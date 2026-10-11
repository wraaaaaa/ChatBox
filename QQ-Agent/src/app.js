// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR } from './config.js';
import { customSearch } from './web-search.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes, forwardResIdFromSegments, fetchForwardNodes, isAuthRejection } from './onebot.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { effectiveWeight } from './memory-global.js';
import { MEME_IMPORT_FILE, MEME_README_FILE, memeTemplate } from './meme-store.js';
import { searchImages, imageSearchConfig, downloadImageBuffer } from './image-search.js';
import {
  listPersonas, currentPersonaId, setActivePersona, addPersona, deletePersona,
  renamePersona, ensurePersonas, syncActivePersonaFromConfig, personaMemoryStats, absorbPersona
} from './persona-store.js';
import { collectChatSamples, collectTextSamples, distillPersona } from './persona-distill.js';
import { StickerManager } from './sticker-manager.js';
import { observeName, aliasSnapshot, aliasesOf, currentNameOf } from './identity.js';
import { listMuted, muteGroup, unmuteGroup, isMuted } from './mute.js';
import { parseAdminCommand, isAdmin, muteReplyText, setAdmin, listAdmins, adminOf } from './admin.js';
import { isAtMe } from './prompt.js';
import { parseWhen as parseReminderWhen } from './reminders.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, chatCompletion, resolveApiKey, cacheHitRate } from './llm.js';
import { modelLabel, splitModelLabel, UNKNOWN_VENDOR } from './model-identity.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, connectModel } from './providers.js';
import { MODEL_CATALOG } from './model-catalog.js';
import { appInfo } from './app-info.js';
import { resetPlan, resetStatus, armReset, createResetChallenge } from './factory-reset.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { createEventBus, todayKey } from './util.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

export function createApp({ log = console.log, requestRestart = null, resetRoot = ROOT } = {}) {
  const cfg = getConfig();
  const resetChallenge = createResetChallenge();
  let resetting = false;
  let restartError = '';
  function factoryResetPlan() {
    const bundled = path.join(resetRoot, 'snowluma');
    const bridgeDir = fs.existsSync(bundled) ? bundled : bundled.replace('app.asar', 'app.asar.unpacked');
    return resetPlan({ dataDir: DATA_DIR, root: resetRoot, bridgeDir, configuredBridgeDir: getConfig().snowluma?.dir });
  }
  const bus = createEventBus();
  const sseClients = new Set();

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    if (fs.existsSync(bundled)) return bundled;
    // 安装版：asar 里的文件不可执行，electron-builder 会把 snowluma/ 解包到
    // resources/app.asar.unpacked/snowluma（见 package.json asarUnpack）
    const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
    if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
    return '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;
  // 启动中的 Promise：并发调用复用同一次启动（见 launchSnowluma 的说明）
  // 单飞闸门用（见 launchSnowluma）
  let snowlumaLaunching = null;
  // 「OneBot 连着、但拿不到 QQ 登录信息」的起始时间。
  // 这是另一种失聪：SnowLuma 进程卡死（例如被 EPIPE 卡住）时 WS 还连得上，
  // 但 get_login_info 永远没有结果 —— 界面显示"已连接"，实际上没登上任何 QQ 号。
  let accountMissingSince = 0;
  let lastLoginInfoProbeAt = 0;

  /**
   * 维护"账号到底登没登上"的状态，并在需要时重试 get_login_info。
   *
   * 为什么要主动重试：OneBot 客户端只在 WS 连上的那一刻取一次 get_login_info。
   * 如果那一刻 SnowLuma 正卡着，之后就再也不会问了 —— 明明 QQ 后来登上了，
   * 应用却永远显示"没连上 QQ 号"，直到重启。这里限频重试一次，能自愈。
   */
  function noteAccountHealth() {
    if (!onebot?.connected) { accountMissingSince = 0; return; }
    if (onebot.selfInfo) { accountMissingSince = 0; return; }
    if (!accountMissingSince) accountMissingSince = Date.now();
    const now = Date.now();
    if (now - lastLoginInfoProbeAt > 30000) {
      lastLoginInfoProbeAt = now;
      onebot.call('get_login_info').then((info) => {
        if (info?.user_id != null) {
          onebot.selfInfo = info;
          accountMissingSince = 0;
          log(`[onebot] 已取到登录信息：${info.nickname}（${info.user_id}）`);
          emit('onebot-status', { connected: true, everConnected: true, error: '', self: { userId: String(info.user_id), nickname: String(info.nickname || '') } });
        }
      }).catch(() => { /* 还卡着，下轮再试 */ });
    }
  }
  // SnowLuma 事件管道故障（最近一次）：{ at, count, sample }
  // 典型是 "attempt to write a readonly database" —— 两个 SnowLuma 实例抢同一个
  // messages.db 时，后起的那个写不进去，于是它的事件管道对**每一条消息**抛错，
  // 事件根本发不到 QQ Agent。表现是"机器人突然不理人"，但界面上一切正常。
  let snowlumaPipelineError = null;
  const SNOWLUMA_PIPELINE_ERR = /readonly database|event pipeline handler failed/i;

  /** 从 SnowLuma 的日志行里维护健康状态（故障出现→记录；事件真的走通了→清除）。 */
  function noteSnowlumaHealth(text) {
    const line = String(text ?? '');
    if (SNOWLUMA_PIPELINE_ERR.test(line)) {
      const now = Date.now();
      snowlumaPipelineError = {
        at: now,
        // firstAt 保留"第一次报错"的时间：判断"是否持续在坏"要看它，
        // 判断"现在还在坏吗"看 at（每次报错都会刷新）。
        firstAt: snowlumaPipelineError?.firstAt || now,
        count: (snowlumaPipelineError?.count || 0) + 1,
        sample: line.slice(0, 200)
      };
      emit('snowluma-status', { running: true, embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null, pipelineError: snowlumaPipelineError });
      return;
    }
    // 只有"确实有事件成功走通"才清除：光看到启动日志不算康复
    if (snowlumaPipelineError && /\[Event\]/.test(line) && /\bOK\b/.test(line)) {
      snowlumaPipelineError = null;
      emit('snowluma-status', { running: true, embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null, pipelineError: null });
    }
  }

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    noteSnowlumaHealth(line.text);
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null, pipelineError: snowlumaPipelineError };
  }

  /**
   * 清扫"我们这份 SnowLuma"的所有进程（含不是本进程拉起的孤儿）。
   *
   * 为什么需要：出现"两个实例抢 messages.db"时，我们只认得自己 spawn 的那个孩子，
   * 另一个孤儿杀不掉 —— 用户只能去任务管理器里手工找 node.exe。
   * 按可执行文件路径 + 安装目录精确匹配，是 Windows 上不装依赖也能做到的办法（本项目仅 Windows）。
   * 具体实现见 snowlumaProcFilter / runPowerShell。
   */

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      throw error;
    }
    return true;
  }

  /**
   * 生成"我们这份 SnowLuma 的进程"筛选条件。
   *
   * 两个要点：
   * 1. **只认本安装目录下的 <dir>\node.exe** —— 别的安装/别的端口的 SnowLuma
   *    不归我们管，更不能去杀（用户可能同时跑着另一份）。
   * 2. 用 `-eq` / `.Contains()` 而不是 `-like`：路径里的 `[` `]` 在 -like 里是
   *    字符类通配符，会匹配错对象；而且 helper 自己的命令行里就带着这个路径，
   *    所以匹配对象必须限定在**可执行文件路径**上（helper 是 powershell.exe，永不自撞）。
   */
  function snowlumaProcFilter(dir) {
    const d = String(dir || '').replace(/'/g, "''");
    return [
      'Get-CimInstance Win32_Process | Where-Object {',
      `($_.ExecutablePath -eq '${d}\\node.exe') -or`,
      `($_.Name -eq 'node.exe' -and -not $_.ExecutablePath -and $_.CommandLine -and $_.CommandLine.Contains('${d}'))`,
      '}'
    ].join(' ');
  }

  /** 跑一段 PowerShell 并取回文本输出（失败返回 null）。 */
  function runPowerShell(script, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        ps.stdout.on('data', (chunk) => { out += String(chunk); });
        ps.on('close', () => finish(out));
        ps.on('error', () => finish(null));
        setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
      } catch {
        finish(null);
      }
    });
  }

  /**
   * 跟踪 SnowLuma 的控制台日志文件（替代原来的 stdout 管道）。
   *
   * 为什么要有它：SnowLuma 现在是 detached 的，管道会在 QQ Agent 退出时断掉并把它
   * 卡死在 EPIPE（详见 spawn 处的说明）。改成"写文件 + 这里读文件"之后：
   * 子进程随时可写、与父进程生死无关，控制台照样能看到它的输出（含崩溃前的早期输出）。
   */
  let snowlumaTailTimer = null;
  function startSnowlumaLogTail(file) {
    stopSnowlumaLogTail();
    let offset = 0;
    let pending = '';
    const tick = () => {
      let fd = null;
      try {
        const size = fs.statSync(file).size;
        if (size < offset) { offset = 0; pending = ''; }   // 文件被重写（新一轮启动）
        if (size === offset) return;
        fd = fs.openSync(file, 'r');
        const len = size - offset;
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, offset);
        offset += read;
        pending += buf.slice(0, read).toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';        // 最后一行可能只写了一半，留到下次
        for (const line of lines) if (line.trim()) pushSnowlumaLog(line, 'stdout');
      } catch { /* 文件还没建好/正被杀掉，下个 tick 再来 */ } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      }
    };
    snowlumaTailTimer = setInterval(tick, 1000);
    if (snowlumaTailTimer.unref) snowlumaTailTimer.unref();
    setTimeout(tick, 300);
  }

  function stopSnowlumaLogTail() {
    clearInterval(snowlumaTailTimer);
    snowlumaTailTimer = null;
  }

  /**
   * 数一数"我们这份 SnowLuma"现在有几个进程。
   *
   * 用途：**启动前**的"别起第二个"判断。端口检查挡不住这个窗口期 ——
   * 上一个实例可能正在启动、还没 bind 端口，这时端口是空的，于是又起一个，
   * 两个进程抢同一个 messages.db，后起的那个只读、事件管道全挂。
   * 宁可少起一个（有进程就等它的端口），也绝不起第二个。
   *
   * @returns {Promise<number>} 进程数；-1 表示探测失败（未知）
   */
  async function countSnowlumaProcesses(dir) {
    const out = await runPowerShell(`${snowlumaProcFilter(dir)} | Measure-Object | Select-Object -ExpandProperty Count`, 10000);
    if (out === null) return -1;
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : -1;
  }

  /** 清扫"我们这份 SnowLuma"的所有进程（含不是本进程拉起的孤儿），返回被杀的 pid 列表。 */
  async function killAllSnowlumaProcesses(dir) {
    const out = await runPowerShell(`${snowlumaProcFilter(dir)} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }`);
    if (out === null) return [];
    return String(out).split(/\s+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    // ── 单飞闸门（重要，别删）──
    // 两次并发启动 = 两个 SnowLuma 抢同一个 messages.db：后起的那个拿到
    // SQLITE_READONLY，于是它的事件管道对**每一条消息**抛错，事件根本发不到
    // QQ Agent —— 表现就是"机器人突然不理人"，而且界面全绿、毫无报错。
    // 端口检查挡不住这个竞态：两次调用都可能在对方 bind 之前通过检查。
    // （2026-09-12 实际踩过：18:35 起了第二个实例，18:35:41 起 114 条 readonly。）
    if (snowlumaLaunching) {
      pushSnowlumaLog('已有一次启动正在进行，复用这次启动（避免起两个实例抢数据库）', 'stdout');
      return snowlumaLaunching;
    }
    snowlumaLaunching = doLaunchSnowluma().finally(() => { snowlumaLaunching = null; });
    return snowlumaLaunching;
  }

  async function doLaunchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const wsPort = snowlumaWsPort();
    // 内置日志窗口读的是这个文件（复用已有实例时也接上，否则应用重启后日志窗口是空的）
    const consoleLogFile = path.join(DATA_DIR, 'logs', 'snowluma-console.log');
    if (await isPortOpen('127.0.0.1', wsPort)) {
      startSnowlumaLogTail(consoleLogFile);
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    // ── 端口没开，但**可能已经有一个正在启动**：再等一秒复查端口，并数一下进程 ──
    // 这一步是"两个实例抢数据库"的第二道闸门（第一道是上面的单飞闸门，
    // 只挡得住同一进程内的并发；跨进程/上一个实例正在启动的窗口期要靠这个）。
    await new Promise((r) => setTimeout(r, 800));
    if (await isPortOpen('127.0.0.1', wsPort)) {
      startSnowlumaLogTail(consoleLogFile);
      pushSnowlumaLog(`SnowLuma 已在运行（复查时端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const existing = await countSnowlumaProcesses(dir);
    if (existing > 0) {
      startSnowlumaLogTail(consoleLogFile);
      pushSnowlumaLog(`检测到已有 ${existing} 个 SnowLuma 进程在运行/启动中，不再启动第二个（两个实例会抢同一个数据库，导致消息进不来）。若它一直起不来，请用「强制重启（清理重复实例）」。`, 'stderr');
      return { ok: true, alreadyRunning: true, processes: existing };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');

    // ── 日志为什么写文件而不是接管道（重要，别改回 pipe）──
    // detached: true 让 SnowLuma 独立于 QQ Agent 存活，但 **stdio 管道仍然是绑在父进程上的**：
    // 父进程一死，管道的读端关闭，子进程之后每次 console.log 都抛
    // `EPIPE: broken pipe, write`。SnowLuma 的 uncaughtException 处理器是"kept alive"，
    // 于是它不会退出 —— 而是卡死在无限 EPIPE 里：端口还占着，但 WebUI 不响应、
    // OneBot 也答不出 get_login_info（表现为"进不去 SnowLuma、也没连上 QQ 号"）。
    // 2026-09-12 实测踩到：19:20 重启应用后，19:12 那个实例刷了一屏 EPIPE 变成僵尸。
    // 所以：输出重定向到自己的日志文件（子进程随时可写，与父进程生死无关），
    // 再由 tailer 读文件喂给控制台 —— 既独立又不丢内置日志。
    //
    // ⚠️ 打开失败**只降级、不抛异常**（返回 null）。
    //    以前这里会抛出去，结果是"data/logs 写不进去"这种小毛病会一路
    //    掉到最后那条 launcher.bat 分支 —— 那才是弹出黑色控制台窗口的唯一路径。
    //    为了一个日志文件把黑框带回来，不值。
    const openSnowlumaLogFd = () => {
      try {
        fs.mkdirSync(path.dirname(consoleLogFile), { recursive: true });
        // 每次启动都从头记：内置日志窗口展示的是"这一轮"的输出，避免混进上轮陈货
        return fs.openSync(consoleLogFile, 'w');
      } catch (error) {
        pushSnowlumaLog(`日志文件打不开（${error?.message ?? error}）：本轮 SnowLuma 输出不接入内置控制台，但仍然无窗口启动。`, 'stderr');
        return null;
      }
    };

    // 统一的启动动作：内置模式与回退模式只差"谁来跑"，起进程的方式完全一样。
    // 两处曾经各写一份，于是"日志打不开"在两处各失败一次，直接穿到最后的分支 ——
    // 现在合成一条：日志拿不到就忽略输出，**决不**因此退回可见窗口。
    //
    // ⚠️ 必须 await spawn 的结果再返回（别改回同步 return）：
    //    spawn 失败是**异步**的（'error' 事件后到），同步返回时 child.pid 是
    //    undefined，于是"根本没起来"会被上报成 {ok:true, launched:true} ——
    //    回退分支永远不会被触发，界面上还显示"已运行"。
    //    等 'spawn' 或 'error' 二选一到达，才敢说启动成功。
    const startHidden = async (exe, args, label) => {
      let logFd = openSnowlumaLogFd();
      const child = spawn(exe, args, {
        cwd: dir,
        stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
        windowsHide: true,   // ← 关键：绝不弹控制台窗口
        detached: true
      });
      if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* 交给子进程持有 */ } logFd = null; }

      const spawned = await new Promise((resolve) => {
        let settled = false;
        const ok = () => { if (!settled) { settled = true; resolve(true); } };
        const bad = (error) => { if (!settled) { settled = true; resolve(error); } };
        child.once('spawn', ok);
        child.once('error', bad);
        // 兜底：两个事件都没来（极罕见）也不至于挂住启动流程
        setTimeout(ok, 3000);
      });
      if (spawned !== true) {
        pushSnowlumaLog(`SnowLuma 启动失败（${label}）：${spawned?.message ?? spawned}`, 'stderr');
        return { ok: false, error: String(spawned?.message ?? spawned) };
      }

      snowlumaProc = child;
      child.unref();
      if (fs.existsSync(consoleLogFile)) startSnowlumaLogTail(consoleLogFile);
      pushSnowlumaLog(`SnowLuma 启动中（${label}，pid=${child.pid}）…`, 'stdout');
      child.on('exit', (code, signal) => {
        snowlumaProc = null;
        pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
        emit('snowluma-status', { running: false, embedded: false, pid: null });
      });
      child.on('error', (error) => {
        pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
      });
      emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
      return { ok: true, launched: true, embedded: true, pid: child.pid };
    };

    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      const r1 = await startHidden(nodeExe, [indexMjs], '内置模式');
      if (r1.ok) return r1;
      snowlumaProc = null;
    }
    // ── 唯一的正常路径：用自带的 node.exe 跑 index.mjs，无窗口 ──
    // 为什么不再"失败就换 launcher.bat 重试一次"：
    //   · 两者跑的是同一条命令（launcher.bat 里就是裸 `node ./index.mjs`），
    //     同一个 node.exe 起不来，换层 cmd 再试一遍不会有不同结果；
    //   · launcher.bat 走的是 PATH 上那个 node，而不是自带运行时 —— 依赖能否解析全看运气；
    //   · 它结尾是一句 `pause`，窗口永远不自己关。
    // 所以这里失败就直接如实返回失败，交给最后手段。
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      const r = await startHidden(nodeExe, [indexMjs], '内置模式：自带 node.exe 运行 index.mjs，无窗口');
      if (r.ok) return r;
      snowlumaProc = null;
      return r;   // 起不来就如实说，不再假装成功（旧代码在这里返回 ok:true + pid=undefined）
    }
    // ── 最后手段：连 index.mjs / node.exe 都没有，只能交给 launcher.bat ──
    // launcher.bat 会自带一个控制台窗口（里面还有 pause）。
    // 这里**拿不到子进程句柄**，所以没法可靠地藏掉它 —— 目标进程是那个 bat，
    // 它再去启动真正的 SnowLuma，隐藏父进程不等于隐藏孙子进程。
    // 正常情况下永远走不到这里：项目里 index.mjs 与自带 node.exe 都在，
    // 真走到这儿说明 SnowLuma 目录被删坏了，那种情况下**看见窗口反而是对的**
    // —— 它能告诉用户"出事了、去看它的输出"，而不是静默地什么都不发生。
    const launcher = path.join(dir, 'launcher.bat');
    if (!fs.existsSync(launcher)) return { ok: false, error: `目录里没有 index.mjs / node.exe，也没有 launcher.bat：${dir}` };
    const child = spawn('cmd.exe', ['/c', launcher], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    pushSnowlumaLog('SnowLuma 已用独立控制台窗口启动（index.mjs 缺失的回退路径，此模式下日志不进内置控制台）', 'stderr');
    return { ok: true, launched: true, embedded: false };
  }

  /**
   * SnowLuma 自愈看门狗。
   *
   * 背景：2026-09-12 的故障里，"消息进不来"这件事**没有任何声音** —— OneBot 已连接、
   * SnowLuma 在跑、界面全绿，用户只能反复重启，越重启越糟（每点一次图标多一个实例）。
   *
   * 所以除了把故障显示出来（红色横幅 + 一键修复），再补一层自动自愈：
   * 故障持续超过 90 秒、当前没有会话在跑 → 自动清扫重复实例并重启 SnowLuma，
   * 10 分钟内最多自动修一次（避免和用户手动操作打架）。
   */
  let snowlumaWatchdog = null;
  let snowlumaAutoHealAt = 0;

  async function autoHealSnowluma() {
    // 情形一：事件管道持续报错（消息进不来）
    const err = snowlumaPipelineError;
    // 情形二：OneBot 连着却拿不到 QQ 登录信息（SnowLuma 卡死，例如被 EPIPE 卡住）
    const accountStuckMs = accountMissingSince ? Date.now() - accountMissingSince : 0;
    if (!err && accountStuckMs < 120000) return { ok: false, reason: 'no-error' };
    if (err) {
      const sinceLast = Date.now() - (err.at || 0);
      const sinceFirst = Date.now() - (err.firstAt || err.at || 0);
      // 还在持续报错（最后一条错误在 60 秒内）→ 说明真的坏着；
      // 只有"陈旧的标记"（错误早停了，只是一直没有成功事件来清除它 ——
      // 例如群里一夜没人说话）绝不能触发自愈，否则会白白重启一个健康的 SnowLuma。
      if (sinceLast > 60000) return { ok: false, reason: 'stale', sinceLast };
      if (sinceFirst < 90000) return { ok: false, reason: 'too-early', sinceFirst };
    }
    if (Date.now() - snowlumaAutoHealAt < 600000) return { ok: false, reason: 'cooldown' };
    if (orchestrator.runningChats.size > 0) return { ok: false, reason: 'busy' };
    snowlumaAutoHealAt = Date.now();
    const why = err
      ? `事件管道持续报错 ${Math.round((Date.now() - (err.firstAt || err.at)) / 1000)} 秒（累计 ${err.count} 次）`
      : `连上 OneBot 但 ${Math.round(accountStuckMs / 1000)} 秒拿不到 QQ 登录信息`;
    pushSnowlumaLog(`消息进不来（${why}）：自动执行「清扫重复实例 + 重启 SnowLuma」…`, 'stderr');
    try {
      const dir = snowlumaDir();
      const killed = await killAllSnowlumaProcesses(dir);
      snowlumaProc = null;
      snowlumaPipelineError = null;
      accountMissingSince = 0;
      for (let i = 0; i < 20; i++) {
        const portBusy = await isPortOpen('127.0.0.1', snowlumaWsPort(), 400);
        const left = portBusy ? 1 : await countSnowlumaProcesses(dir);
        if (!portBusy && left <= 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const left = await countSnowlumaProcesses(dir);
      if (left > 0) {
        pushSnowlumaLog(`自愈中止：仍有 ${left} 个 SnowLuma 进程没退掉。`, 'stderr');
        return { ok: false, reason: 'leftover', left };
      }
      const r = await launchSnowluma();
      pushSnowlumaLog(`自愈${r.ok ? '完成' : '失败'}：清扫 ${killed.length} 个实例后重新启动${r.ok ? '' : `（${r.error || ''}）`}`, r.ok ? 'stdout' : 'stderr');
      emit('snowluma-status', { running: !!r.ok, embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null, pipelineError: null, autoHealed: true });
      return { ok: r.ok, killed: killed.length };
    } catch (error) {
      pushSnowlumaLog(`自愈出错：${error?.message ?? error}`, 'stderr');
      return { ok: false, reason: 'error', error: String(error?.message ?? error) };
    }
  }

  function startSnowlumaWatchdog() {
    if (snowlumaWatchdog) return;
    snowlumaWatchdog = setInterval(() => { autoHealSnowluma().catch(() => {}); }, 60000);
    if (snowlumaWatchdog.unref) snowlumaWatchdog.unref();
  }

  function stopSnowlumaWatchdog() {
    clearInterval(snowlumaWatchdog);
    snowlumaWatchdog = null;
  }

  const emit = (type, payload) => {
    bus.emit(type, payload);
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  // 人设身份 + 记忆隔离：先把人设 id/memoryKey 补齐、把老布局的记忆迁进当前人设，
  // 保证接下来任何一次记忆读写都落在正确的那棵目录树里。
  try {
    const bootKey = ensurePersonas();
    log(`[persona] 当前人设：${currentPersonaId() || '(未定)'}  记忆目录：data/memory/${bootKey}/`);
  } catch (error) {
    log('[persona] 人设初始化失败（记忆将退回默认人设目录）:', error?.message ?? error);
  }
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });

  // ── 启动清点：上次进程没跑完的会话 ──
  //   进程被硬杀（断电/强杀）时不会走 finish()：会话永远停在 running（界面一条幽灵"运行中"），
  //   而它 drain 走的消息已被标已读 → **永远不会再被处理**（用户："已读，但一个字都没回"）。
  //   恢复规则与运行内重试一致：**本次一条都没发出去** 才把消息放回未读并重排一次处理；
  //   已经发过话的不重放，否则群里会看到两遍同样的话。
  const recoveredChats = new Set();
  try {
    for (const s of sessions.recoverStale()) {
      // 判"这次到底发过话没有"，两条证据取或：
      //   ① 会话存档里的 sent（正常情况）；
      //   ② 存档里有没有**本次会话开始之后**的机器人发言。
      //   为什么需要 ②：会话落盘有 2 秒节流（#persistThrottled），崩溃发生在"刚发完话"
      //   的 2 秒窗口内时，sent 可能还没写进文件 —— 只看 sent 会误判成"没发过话"，
      //   把消息放回未读 → **群里就会看到两遍同样的话**。而消息存档是发送即写的，可靠得多。
      const spokeInArchive = (Array.isArray(s.sent) && s.sent.length > 0)
        || store.recent(s.chatKey, { limit: 30 }).some((m) => m.self && Number(m.ts) >= Number(s.startedAt || 0));
      const spoke = spokeInArchive;
      const trigger = Array.isArray(s.trigger) ? s.trigger : [];
      const live = [];
      for (const m of trigger) {
        if (!m || m.self || m.id === undefined || m.id === null) continue;
        const hit = store.findByLocalId(s.chatKey, m.id);
        if (hit && hit.read && !hit.skip) live.push(hit);
      }
      if (!spoke && live.length) {
        const back = store.putBackUnread(s.chatKey, live);
        if (back) {
          recoveredChats.add(s.chatKey);
          log(`[恢复] ${s.chatKey} 上次中断时取走的 ${back} 条消息已放回未读，稍后重新处理`);
        }
      } else if (spoke) {
        log(`[恢复] 会话 ${s.id} 上次中断前已发过话，只标记中止、不重放（避免重复发言）`);
      }
    }
    if (recoveredChats.size) log(`[恢复] 共 ${recoveredChats.size} 个会话需要补处理`);
  } catch (error) {
    log(`[恢复] 启动清点失败（不影响启动）：${error?.message ?? error}`);
  }

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 给每个登录过的账号生成独立随机 token（config/onebot_<uin>.json），
  // 且**永久保留**——不表示"当前在线"。多账号场景下"取第一个文件"会拿错 token
  // （WS 401 无限重试）。策略改为：收集所有 per-uin 文件的 token 作为候选，
  // 401 时轮换下一个重连，连上后记住生效的那个（天然支持 SnowLuma 里切账号）。
  let lastSyncTokenSig = '';

  /** 从单个配置对象里提取 ws/http token（找不到网络段时返回 null）。 */
  function extractTokens(data) {
    const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
    const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
    return { wsToken: String(ws?.accessToken ?? ''), httpToken: String(http?.accessToken ?? '') };
  }

  /**
   * 收集所有候选 token。顺序即尝试优先级（**原版优先级不变**）：
   *   1) snowluma/config/onebot_<uin>.json 里探测到的真实令牌（按文件名/uin 升序，原版顺序）
   *   2) 用户手填的令牌（配置里的值，仅在它不在 1) 里时追加）
   *   3) 空令牌兜底（SnowLuma 未设 token 的合法情形）
   *
   * 🔴 401 死循环的老根因（已修）：旧实现的候选列表**只有** 2) 和 3)，
   * 完全不看 1)。当 SnowLuma 还没生成 onebot_<uin>.json（首次运行、没在 WebUI 登录过）时，
   * 候选里就只剩那个空令牌，于是 `applyTokens(candidates[0])` 把空令牌写进 config.json，
   * 把用户手动填好的正确令牌覆盖掉 → 不带 token 去连 → SnowLuma 返回 401 → 死循环。
   * （SnowLuma 的 isAuthorized：`if (!token) return true`；服务端有 token 时，
   *   连接方必须发一模一样的，发空 = 不匹配 = 401。）
   *
   * 修法有两条，都**不删原版功能**：
   *   a) 候选顺序严格保持原版：文件令牌在前、手填令牌追加在后、空令牌永远末位；
   *   b) 在 applyTokens 里加安全网：空令牌绝不覆盖盘上已有的非空令牌。
   * 两者合起来，既不会拿空令牌去连（→401），也不会把用户手填的值抹掉。
   */
  function readSnowlumaTokenCandidates() {
    const out = [];
    try {
      const configured = {
        wsToken: String(getConfig().snowluma?.accessToken || ''),
        httpToken: String(getConfig().snowluma?.httpAccessToken || '')
      };
      const dir = snowlumaDir();
      if (dir) {
        const cfgDir = path.join(dir, 'config');
        let files = [];
        try {
          files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
        } catch { /* ignore */ }
        // 顺序沿用原版 `files.sort()`（按文件名，即 uin 升序）。
        // ⚠️ 不要改成按 mtime 排：多账号下"最近改过的排前"会让候选顺序飘忽，
        //    原版测试对候选顺序有明确断言，改了就是破坏原功能。
        for (const f of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
            const t = extractTokens(data);
            // 只收"真的带了令牌"的候选；全空的文件没有信息量
            if (t.wsToken || t.httpToken) out.push(t);
          } catch { /* 单个文件坏了跳过，不影响其他候选 */ }
        }
      }
      // 用户手填的令牌：作为**轮换兜底**追加在文件令牌之后（⚠️ 不能置顶！）
      // 原版语义是"文件里探测到的令牌优先于配置里的缓存值"——换了账号文件就必须
      // 拿到新令牌，而不是沿用配置里的旧值（原版测试对此有明确断言）。
      // 追加在末尾既保留该语义，又保证手填的令牌永不被丢弃：
      // SnowLuma 还没生成 onebot_<uin>.json（首次运行/没在 WebUI 登录过）时，
      // 候选里就只有它，于是不会再出现"拿空令牌去连 → 401"的老问题。
      if ((configured.wsToken || configured.httpToken)
        && !out.some((c) => c.wsToken === configured.wsToken && c.httpToken === configured.httpToken)) {
        out.push(configured);
      }
      // 空令牌兜底（保留原版行为，永远在候选末尾）：
      // SnowLuma 未设 token 时本来就该不带 token 连（服务端 isAuthorized: `if (!token) return true`）。
      // 它只是**轮换的最后一站**——前面的真实令牌全被 401 拒了才会轮到它。
      // 之所以现在不会再把用户手填的令牌顶掉：applyTokens 的安全网（wouldErase）
      // 会拦住"用空令牌覆盖盘上非空令牌"这一步。
      if (!out.some((c) => !c.wsToken && !c.httpToken)) out.push({ wsToken: '', httpToken: '' });
    } catch (error) {
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', error?.message ?? error);
    }
    return out;
  }

  /** 候选游标：401 时递增轮换。连上后会钉住当前生效下标。 */
  let tokenCandidateIndex = 0;

  function applyTokens({ wsToken, httpToken }) {
    onebot.accessToken = wsToken;
    onebot.httpToken = httpToken || wsToken;
    const cur = getConfig();
    const curWs = String(cur.snowluma?.accessToken || '');
    const curHttp = String(cur.snowluma?.httpAccessToken || '');
    // 🛡️ 安全网：本次要应用的是"空令牌"，但盘上已经有非空令牌 → 不写盘。
    // 空令牌只是"这一次连接不带头"（SnowLuma 未设 token 时的合法情形），
    // 不该把用户手填的值从 config.json 里抹掉。否则 401 轮换转到最后一站时
    // 会擦掉正确令牌，且再也轮不回去（候选集被重新收集时已经没有它了）。
    const wouldErase = !wsToken && !httpToken && (curWs || curHttp);
    if (!wouldErase && (curWs !== wsToken || curHttp !== (httpToken || wsToken))) {
      updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken || wsToken } });
      log(`[onebot] 应用 OneBot 访问令牌（WS ${wsToken ? '有' : '无'} / HTTP ${httpToken ? '有' : '无'}）`);
    } else if (wouldErase) {
      log('[onebot] 本轮按"不带令牌"连接，但保留 config 里已有的令牌不覆盖');
    }
  }

  /** 把候选列表同步进配置 + 挂到 onebot 实例（不立即连接）。返回是否有变化。 */
  function syncSnowlumaTokens() {
    try {
      const candidates = readSnowlumaTokenCandidates();
      if (!candidates.length) return false;
      const sig = candidates.map((c) => `${c.wsToken}|${c.httpToken}`).join(';');
      if (sig === lastSyncTokenSig) return false;
      // 游标重置：候选集变化了，从头开始试
      tokenCandidateIndex = 0;
      applyTokens(candidates[0]);
      onebot.tokenCandidates = candidates;   // 401 轮换用
      lastSyncTokenSig = sig;
      log(`[onebot] 已收集 ${candidates.length} 个 OneBot 令牌候选（SnowLuma 多账号场景 401 时自动轮换）`);
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时：轮换下一个候选 token 重连（3 秒重连循环已有，轮换成本为零）
  let tokenSyncRetryAt = 0;
  let tokenExhaustedLogged = false;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    // 先尝试重新收集：SnowLuma 可能在运行中新生成/更新了 onebot_<uin>.json
    syncSnowlumaTokens();
    const candidates = onebot.tokenCandidates || [];
    if (!candidates.length) return;
    // 指向下一个候选（首次触发也从 0→1 开始换：刚被 401 拒的就是当前这个）
    tokenCandidateIndex = (tokenCandidateIndex + 1) % candidates.length;
    const c = candidates[tokenCandidateIndex];
    applyTokens(c);
    onebot.reconnect();
    // 转了一整圈还全是 401 → 令牌值都不对，得让用户知道该去哪儿填
    if (candidates.length > 1 && tokenCandidateIndex === 0) {
      if (!tokenExhaustedLogged) {
        tokenExhaustedLogged = true;
        log('[onebot] ⚠️ 所有令牌候选都被 401 拒绝 —— 请打开 SnowLuma 控制台确认「WS 访问令牌」，'
          + '并在本程序设置页的 SnowLuma 区域手动填入同一个值（自动探测可能读不到）。');
      }
    } else {
      tokenExhaustedLogged = false;
    }
  }
  onebot.onStatus((status) => {
    if (status.connected) {
      // 连上了：钉住当前候选。下次 401（比如 SnowLuma 里切了账号）再从下一个开始轮
      const cands = onebot.tokenCandidates || [];
      if (cands.length > 1) log('[onebot] 连接成功，当前令牌候选已生效');
      tokenExhaustedLogged = false;
      return;
    }
    // 判据与 onebot.js 的 isAuthRejection 保持一致（401 / Unauthorized / invalid access token）
    if (isAuthRejection(status.error)) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  /**
   * 群管理员指令处理：管理员在群里发「禁言 / 解除」。
   *
   * 关键语义（用户明确要求）：
   *   · 这两条指令**本身不触发对话**——不能因为一句"禁言"就把 AI 叫起来跑一次；
   *     所以这里在入口层直接拦掉，消息只在 store 里存档（供事后查阅），
   *     立刻标为已读，且**绝不调用 orchestrator.onIncoming**。
   *   · 只有该群设定的管理员 QQ 说了才算；别人发同样的话只是普通聊天，照常走 AI。
   *
   * @returns {boolean} true = 已作为指令处理（调用方不要再触发 AI）
   */
  function handleAdminCommand(kind, id, senderId, text) {
    if (kind !== 'group') return false;         // 仅群聊
    if (!getConfig().admin?.enabled) return false;
    const cmd = parseAdminCommand(text);
    if (!cmd) return false;
    // 不是管理员 → 不拦截（当作普通发言，交给 AI 判断）
    if (!isAdmin(id, senderId)) return false;

    const chatKey = `group:${id}`;
    try {
      if (cmd.cmd === 'mute') {
        // 复用 mutedGroups 的硬闸门（绝不触发运行），额外打上管理员来源标记
        muteGroup(id, { until: 0, reason: `管理员(${senderId})指令禁言`, by: 'admin' });
        // 指令消息不进未读批：手工落一条自己的回执，再把这批未读（含指令本身）沉掉
        store.appendSelf(chatKey, { text: '（已禁言）', ts: Date.now() });
        store.markAllRead(chatKey, { tier: 0, reason: '管理员指令：禁言' });
        log(`[admin] 群 ${id} 由管理员 ${senderId} 指令禁言`);
      } else {
        unmuteGroup(id);
        store.appendSelf(chatKey, { text: '（已解除禁言）', ts: Date.now() });
        store.markAllRead(chatKey, { tier: 0, reason: '管理员指令：解除' });
        log(`[admin] 群 ${id} 由管理员 ${senderId} 解除禁言`);
      }
      emit('chat-update', chatKey);
      return true;
    } catch (error) {
      log(`[admin] 指令处理失败：${error?.message ?? error}`);
      return false;   // 处理失败就当普通消息，别把这条指令吞掉
    }
  }

  /**
   * 管理员禁言期间的"被 @ 回应"：不发算力，只回一句固定话术。
   *
   * 为什么要有：禁言 ≠ 装死。被 @ 了完全没反应，群友会以为号被踢了/坏了。
   * 这里直接由本地逻辑回话，不拼提示词、不调模型 —— 成本为零。
   * @returns {boolean} true = 已回应（调用方不要触发 AI）
   */
  function replyIfMutedMention(kind, id, senderId, text) {
    if (kind !== 'group') return false;
    if (!isMutedByAdminOnly(id)) return false;
    if (!isAtMe(text, {
      selfNickname: getConfig().persona?.selfNickname || '',
      botName: getConfig().persona?.botName || '',
      selfId: onebot.selfId
    })) return false;
    const chatKey = `group:${id}`;
    // 防刷屏：同一群 60 秒内只回一次固定话术
    const now = Date.now();
    const last = mutedReplyAt.get(id) || 0;
    if (now - last < 60000) return true;
    mutedReplyAt.set(id, now);
    sender.sendTextBatch(chatKey, muteReplyText(), { atUserId: senderId || null })
      .catch((error) => log(`[admin] 禁言中回应失败：${error?.message ?? error}`));
    return true;
  }

  // 禁言固定话术的发送节流表（群号 → 上次发送时间）
  const mutedReplyAt = new Map();

  /** 该群是否处于"管理员指令禁言"（by=admin 的那一类）。 */
  function isMutedByAdminOnly(groupId) {
    if (!isMuted(groupId)) return false;
    const rec = getConfig().mutedGroups?.[String(groupId)];
    return String(rec?.by || '') === 'admin';
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    if (kind === 'group' && senderId && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // ⚠️ 必须传 res_id，不能只传 message_id（2026-09-14 实测）：
    // SnowLuma 的 get_forward_msg 只对 message_id > 0 做"查事件 → 取 res_id"，
    // 负数 message_id 会把该数字**当成 res_id** 发给服务器 → retcode=100
    // "download forward message payload is empty"。
    // 而 QQ 事件里约一半的转发消息 message_id 是负数（实测 58/58 挂在这上面），
    // 所以入站时就把 forward 段的 res_id 抓下来直传；message_id 只作兜底。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/看图都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    const forwardResId = segments ? forwardResIdFromSegments(segments) : null;
    if (segments && (text.includes('[合并转发') || text.includes('[转发消息'))
      && (forwardResId || event.message_id != null)) {
      try {
        const { nodes } = await fetchForwardNodes(onebot, { resId: forwardResId, mid: event.message_id });
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${e?.message ?? e}`);
      }
    }

    if (!text && !media.length) return;

    // ── 管理员指令（禁言 / 解除）：在入口层拦截，绝不触发 AI ──
    // 必须放在 appendIncoming 之前：指令消息不进未读批，也就不会变成"待处理"。
    if (handleAdminCommand(kind, id, senderId, text)) return;

    // ── 管理员禁言期间的"被 @ 回应"：本地回一句固定话术，不烧算力 ──
    if (replyIfMutedMention(kind, id, senderId, text)) {
      // 被 @ 的消息仍照常存档（沉为已读历史），但不触发运行
      const mutedArrived = store.appendIncoming(`${kind}:${id}`, {
        mid: event.message_id,
        ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
        senderId,
        senderName,
        text: text || '[图片]',
        media,
        forwardResId
      });
      // 重复投递：别顺手把真正的未读也一起标掉
      if (!mutedArrived) {
        log(`[ingest] ${kind}:${id} 收到重复投递（mid=${event.message_id}），已忽略`);
        return;
      }
      store.markAllRead(`${kind}:${id}`, { tier: 0, reason: '管理员禁言中（仅固定回应）' });
      emit('chat-update', `${kind}:${id}`);
      return;
    }

    const chatKeyNow = `${kind}:${id}`;
    const arrived = store.appendIncoming(chatKeyNow, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media,
      forwardResId
    });
    // 重复投递（同一 message_id 再次到达：重连补历史 / 事件重放）→ 已入过档，直接忽略。
    // 不忽略的话会出现"同一条消息回两遍"，存档里也会多出一份。
    if (!arrived) {
      log(`[ingest] ${chatKeyNow} 收到重复投递（mid=${event.message_id}），已忽略`);
      return;
    }
    // 真人说话风格采样：开关关闭时是空操作（enabled=false 直接短路，零开销）
    try {
      if (memory.style?.enabled) {
        memory.observeStyle({
          chatKey: chatKeyNow,
          entry: arrived,
          recent: store.recent(chatKeyNow, { limit: 12 })
        });
      }
    } catch (error) {
      log(`[style] 采样失败（不影响聊天）: ${error?.message ?? error}`);
    }
    // 身份档案：记下"这个 QQ 号现在叫什么"。改名后旧名字会保留成"曾用名"，
    // 提示词里一并给模型 —— 这样群友改了群名片也不会被当成陌生人（用户明确要求）。
    try {
      if (senderId && senderName && senderName !== senderId) {
        const r = observeName(senderId, senderName, { at: arrived.ts });
        if (r.isRename) log(`[identity] ${senderId} 改名：${r.prevName} → ${senderName}`);
      }
    } catch (error) {
      log(`[identity] 记录昵称失败（不影响聊天）: ${error?.message ?? error}`);
    }
    // 表层记忆：把刚收到的这句话暂存一小段时间（默认 10 分钟），
    // 让它在别的会话里也能被立刻查到 —— 这是"私聊说的，去另一个群能马上复述"的入口。
    try {
      const t = String(text || '');
      // 只记有内容的文字消息，不记占位符（[图片]/[语音]/[表情]这种只有壳没内容）
      if (senderId && t && !/^\[(图片|表情|视频|语音|文件|合并转发)/.test(t)) {
        memory.observeSurface({ chatKey: chatKeyNow, userId: senderId, name: senderName, text: t, at: arrived.ts });
      }
    } catch (error) {
      log(`[surface] 记录表层记忆失败（不影响聊天）: ${error?.message ?? error}`);
    }
    emit('chat-update', chatKeyNow);
    orchestrator.onIncoming(chatKeyNow);
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）
    if (isGroup && operatorId && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorName}）`;
    } else {
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: []
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (resetting) return;
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      const evSender = String(event.user_id ?? event.sender?.user_id ?? '');
      // 两道判据，任一命中就忽略：
      //   ① 与 get_login_info 拿到的自己的 QQ 号相同（正常情况）；
      //   ② 事件的 self_id 与发送者相同 —— OneBot v11 里 self_id 就是机器人自己的号。
      //      加 ② 是因为 ① 依赖 get_login_info 成功：桥没回这个接口（或返回异常）时
      //      onebot.selfId 会是空串，这时若桥又上报了机器人自己的消息
      //      （SnowLuma 的 reportSelfMessage=true），就会自问自答、甚至循环。
      if (evSender && (evSender === onebot.selfId || (event.self_id != null && evSender === String(event.self_id)))) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / accessToken / token / secret / password / **cookie** / session …
  // cookie 与 session 一定要在名单里：pixiv 登录 Cookie、图源会话令牌都住在这类字段，
  // 明文回传给前端等于把它们摊在控制台接口上（本地应用也不该这么做）。
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key|cookie|session)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线应当是「校验请求来源」，而不是砍掉本地功能。
   *
   * 放行条件（任一）：
   *   1. 配置了 server.token 且请求带上了它（远程/多用户场景）
   *   2. 请求来自本机控制台：Origin/Referer 指向本服务，或带 x-console-token 头
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token || url.searchParams.get('token') === token) return true;
    }
    // 带自定义头 → 不可能是简单跨站请求（需 CORS 预检通过才能发出），放行
    if (req.headers['x-console-token']) return true;

    const host = String(req.headers.host ?? '');
    const origin = String(req.headers.origin ?? '');
    const referer = String(req.headers.referer ?? '');
    const isLoopbackHost = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
    if (!isLoopbackHost) return false;
    if (origin) return origin === `http://${host}`;
    if (referer) return referer.startsWith(`http://${host}/`);
    return true;   // 地址栏直连等无来源请求，无法进一步区分
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/factory-reset/status' && method === 'GET') {
        // 状态只读：允许外部桥接配置下查看关于页，不扩展删除权限。
        const plan = resetPlan({ dataDir: DATA_DIR, root: resetRoot });
        return json(res, 200, restartError ? { state: 'failed', error: restartError } : resetStatus(plan));
      }
      if (resetting) return json(res, 503, { error: '正在初始化并重启，请稍候' });

      if (pathname === '/api/factory-reset/prepare' && method === 'POST') {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '只能从本机控制台初始化' });
        if (typeof requestRestart !== 'function') return json(res, 409, { error: '当前运行方式不支持自动初始化，请完整重启 QQ Agent 后再试' });
        try { factoryResetPlan(); } catch (error) { return json(res, 409, { error: error.message }); }
        return json(res, 200, { ok: true, ...resetChallenge.prepare() });
      }
      if (pathname === '/api/factory-reset/confirm' && method === 'POST') {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '只能从本机控制台初始化' });
        const body = await readBody(req);
        if (typeof requestRestart !== 'function') return json(res, 409, { error: '此运行方式不支持自动初始化' });
        if (resetting) return json(res, 409, { error: '初始化已在执行' });
        if (orchestrator.runningChats.size || orchestrator.consolidating.size || memory.style?.distilling || visionScan.running || snowlumaLaunching) {
          return json(res, 409, { error: '机器人或后台任务正在运行，请等待结束后再初始化' });
        }
        try {
          const plan = factoryResetPlan();
          resetChallenge.consume(body);
          const job = armReset(plan, { restartPort: server.address()?.port });
          resetting = true;
          orchestrator.setPaused(true, 'factory-reset');
          onebot.close();
          res.once('finish', () => {
            Promise.resolve().then(requestRestart).catch(error => {
              restartError = `自动重启失败，请完整退出并重新打开 QQ Agent：${error.message}`;
              log('[reset]', restartError);
            });
          });
          return json(res, 200, { ok: true, restarting: true, id: job.id });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }

      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          // 事件管道故障要能一眼看到：OneBot 连着、但消息根本没进来时，
          // 界面上原本毫无提示（"机器人不理人"最难查的就是这种情况）
          messageFlow: (() => {
            noteAccountHealth();
            return {
              pipelineError: snowlumaPipelineError,
              accountMissingSince,
              accountNickname: onebot.selfNickname || '',
              lastIncomingAt: store.lastIncomingAt ? store.lastIncomingAt() : 0,
              lastIncomingChat: store.lastIncomingChat ? store.lastIncomingChat() : ''
            };
          })(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null
        });
      }

      // ── 用量看板：按天 / 按会话 / 按模型统计 ──
      // range: 'today'=今天0点起 | '24h'=最近24小时 | '3'|'7'|'14'|'30'=最近N天
      if (pathname === '/api/usage/stats' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 某个维度下的明细（点表格行时弹窗用）
      // dim: 'chat' | 'model' | 'day'  key: 对应值  by: 'day' | 'model' | 'chat'
      if (pathname === '/api/usage/breakdown' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-200) });
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          let stopped = stopSnowluma();
          if (!stopped) {
            // 没有子进程句柄：SnowLuma 是上一轮留下的独立实例（detached）或外部启动的。
            // 这时按进程清单关掉它 —— 否则"关闭 SnowLuma"点下去毫无反应（按钮会骗人）。
            const killed = await killAllSnowlumaProcesses(snowlumaDir());
            stopped = killed.length > 0;
            if (stopped) pushSnowlumaLog(`已关闭 SnowLuma（pid ${killed.join(', ')}）：它不是本次启动拉起的，按进程清单关闭。`, 'stdout');
          }
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      /**
       * 强制重启：先清扫"我们这份" SnowLuma 的所有进程（含孤儿），再起一个干净的。
       * 用于"消息发不进来"的故障 —— 两个实例抢同一个 messages.db 时，
       * 后起的那个写不进去，事件管道对每条消息抛错，机器人静默失聪。
       * 正常停止杀不掉孤儿实例（不在我们的子进程表里），所以必须按进程清扫。
       */
      if (pathname === '/api/snowluma/force-restart' && method === 'POST') {
        try {
          const dir = snowlumaDir();
          const killed = await killAllSnowlumaProcesses(dir);
          pushSnowlumaLog(`强制重启：已清扫 ${killed.length} 个 SnowLuma 进程${killed.length ? `（pid ${killed.join(', ')}）` : ''}`, 'stdout');
          snowlumaProc = null;
          snowlumaPipelineError = null;
          // 等端口与文件句柄真正释放，否则新实例又会撞上同一个只读问题。
          // 同时等"进程数归零" —— 否则下面的"别起第二个"检查会把我们自己挡住。
          for (let i = 0; i < 20; i++) {
            const portBusy = await isPortOpen('127.0.0.1', snowlumaWsPort(), 400);
            const left = portBusy ? 1 : await countSnowlumaProcesses(dir);
            if (!portBusy && left <= 0) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          const left = await countSnowlumaProcesses(dir);
          if (left > 0) {
            pushSnowlumaLog(`强制重启：仍有 ${left} 个 SnowLuma 进程没退掉（可能被杀软/权限拦住），先不启动新实例，避免又抢数据库。`, 'stderr');
            return json(res, 500, { ok: false, killed, error: `仍有 ${left} 个 SnowLuma 进程没退出，请稍后重试或在任务管理器里结束它们` });
          }
          const r = await launchSnowluma();
          return json(res, r.ok ? 200 : 400, { ok: r.ok, killed, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`,
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        // 角色设定允许为空（「新建空白人设」就是先建名字、后填卡片）
        if (!name) return json(res, 400, { ok: false, error: '人设名称不能为空' });
        // customRules 允许为空
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }

      // ── 人设管理（稳定 id + 记忆隔离）──
      if (pathname === '/api/personas' && method === 'GET') {
        const activeId = currentPersonaId();
        const personas = listPersonas().map((p) => ({
          id: p.id,
          name: p.name,
          builtin: !!p.builtin,
          memoryKey: p.memoryKey,
          active: p.id === activeId,
          textLength: String(p.text || '').length,
          preview: String(p.text || '').split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ').slice(0, 100),
          stats: personaMemoryStats(p.memoryKey)
        }));
        return json(res, 200, { ok: true, activeId, personas });
      }

      if (pathname === '/api/personas/active' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const r = setActivePersona(String(body.id || ''));
        if (!r.ok) return json(res, 400, r);
        emit('status', { personaSwitched: r.persona.id });
        emit('memory-update', { phase: 'persona-switched', personaId: r.persona.id });
        return json(res, 200, {
          ok: true,
          persona: { id: r.persona.id, name: r.persona.name, memoryKey: r.persona.memoryKey }
        });
      }

      if (pathname === '/api/personas' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const r = addPersona({ name: body.name, text: body.text, customRules: body.customRules });
        if (!r.ok) return json(res, 400, r);
        emit('status', { personaAdded: r.persona.id });
        return json(res, 200, { ok: true, persona: r.persona });
      }

      // 角色蒸馏：从聊天记录或多段文本里提炼一张角色卡（只返回草稿，不落库）
      if (pathname === '/api/personas/distill' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const source = body.source === 'chats' ? 'chats' : 'text';
        const dcfg = getConfig().distill || {};
        try {
          let samples = [];
          let speakerLabel = '';
          if (source === 'chats') {
            const chatKeys = (Array.isArray(body.chatKeys) ? body.chatKeys : [body.chatKeys])
              .map((k) => String(k || '').trim())
              .filter((k) => /^(group|private):\d+$/.test(k));
            if (!chatKeys.length) return json(res, 400, { ok: false, error: '请至少选择一个会话' });
            const speaker = String(body.speaker || 'self').trim() || 'self';
            const got = collectChatSamples(store, {
              chatKeys,
              speaker,
              maxLines: Math.max(20, Number(dcfg.maxChatLines) || 400),
              perChat: Math.max(10, Number(dcfg.maxPerChat) || 200)
            });
            samples = got.lines;
            speakerLabel = speaker === 'self'
              ? `机器人自己（${getConfig().persona?.botName || '当前人设'}）在 ${chatKeys.length} 个会话里的发言`
              : `QQ ${speaker} 在这些会话里的发言`;
          } else {
            const got = collectTextSamples(String(body.text || ''), {
              maxLines: Math.max(20, Number(dcfg.maxTextLines) || 600),
              speaker: String(body.textSpeaker || '').trim()
            });
            samples = got.lines;
            speakerLabel = '导入的角色对话文本';
          }
          if (samples.length < 5) {
            return json(res, 400, { ok: false, error: `可用样本只有 ${samples.length} 条，太少；换个来源或补充材料再试` });
          }
          const draft = await distillPersona({
            source,
            samples,
            hint: String(body.hint || '').slice(0, 500),
            name: String(body.name || '').slice(0, 60),
            speakerLabel
          });
          return json(res, 200, { ok: true, draft });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // 人设合并：把 fromId 并进路径里的这个人设（同一个角色的两份合成一份）
      const absorbRaw = /^\/api\/personas\/((?:custom|builtin)(?::|%3A)[A-Za-z0-9_]+)\/absorb$/.exec(pathname);
      if (absorbRaw && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const targetId = decodeURIComponent(absorbRaw[1]);
        const r = absorbPersona(targetId, String(body.fromId || ''));
        if (!r.ok) return json(res, 400, r);
        emit('status', { personaAbsorbed: targetId });
        emit('memory-update', { phase: 'persona-absorbed', personaId: targetId });
        return json(res, 200, r);
      }

      // URL 里的 ":" 可能被编码成 %3A（前端 encodeURIComponent 后就是这样），两种都要认，
      // 否则 custom:xxxx 这类 id 的改名/删除会全部 404。
      const personaIdRaw = /^\/api\/personas\/((?:custom|builtin)(?::|%3A)[A-Za-z0-9_]+)$/.exec(pathname);
      const personaIdMatch = personaIdRaw ? [personaIdRaw[0], decodeURIComponent(personaIdRaw[1])] : null;
      if (personaIdMatch && method === 'PATCH') {
        const body = await readBody(req).catch(() => ({}));
        const r = renamePersona(personaIdMatch[1], body.name);
        if (!r.ok) return json(res, 400, r);
        return json(res, 200, { ok: true });
      }
      if (personaIdMatch && method === 'DELETE') {
        const r = deletePersona(personaIdMatch[1]);
        if (!r.ok) return json(res, 400, r);
        emit('status', { personaDeleted: personaIdMatch[1] });
        return json(res, 200, { ok: true, memoryKey: r.memoryKey });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/model-catalog' && method === 'GET') return json(res, 200, { vendors: MODEL_CATALOG });
      if (pathname === '/api/model-connection' && method === 'POST') {
        try {
          const result = connectModel(await readBody(req));
          emit('status', { configUpdated: true });
          return json(res, 200, { ok: true, provider: sanitizeProvider(result.provider), model: result.model });
        } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
      }
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: '',              // 不把真实 Key 暴露给 UI；有 Key 用 hasKey 表示
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 显示目录提供商的真实 Key（本地 UI 点击“显示”用）
      // 明文密钥端点：仅放行本机控制台请求，挡住外部网页冒用（见 keyEndpointAllowed）。
      if (pathname === '/api/providers/key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }

      // 显示顶层 api.apiKey（手动模式、未选目录提供商时用）
      if (pathname === '/api/api-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }

      // 显示某个搜索服务的真实 Key（本地 UI 点击“显示”用）。
      // /api/config 里的搜索 Key 是脱敏的，所以“显示”必须走这里。
      if (pathname === '/api/search-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const field = String(url.searchParams.get('field') || '');
        // 自定义搜索服务的 Key 不走这里（它们存在 webSearch.providers 数组里，
        // 由 /api/search-providers 管理，且添加时是一次性输入，不提供明文回读）。
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        if (!allowed.includes(field)) {
          return json(res, 400, { error: `未知搜索服务：${field}` });
        }
        return json(res, 200, { apiKey: String(getConfig().webSearch?.[field]?.apiKey || '') });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgNow.api.apiKey || '');
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求。
      // apiKey 可省略：省略时由服务端自己解析真实 Key 使用（不外发给客户端），
      // 这样未配置 server.token 时"测试连通性"依然可用。
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const submitted = String(body.apiKey ?? '').trim();
          // 掩码 / 空 → 说明客户端没有新 Key，用服务端已保存的
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const result = await testModelChat({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey,
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: { ...builtinVisionResults(currentProviders()), ...visionResults() }, scanning: visionScan.running });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      // ── 自定义搜索提供商（可添加多个，交互沿用模型提供商那套）──
      if (pathname === '/api/search-providers' && method === 'GET') {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          baseUrl: p.baseUrl,
          model: p.model,
          count: p.count,
          timeoutMs: p.timeoutMs,
          hasApiKey: Boolean(String(p.apiKey || '').trim())   // 不返回明文
        }));
        return json(res, 200, { providers: list });
      }

      // 新增/更新：同 baseUrl + type 视为同一项，覆盖其配置
      if (pathname === '/api/search-providers' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // 掩码/空 = 保持原 Key 不变
            const submitted = String(body.apiKey ?? '').trim();
            if (submitted && submitted !== '******') existing.apiKey = submitted;
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type,
              baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, {
            ok: true,
            provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) }
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除一个自定义搜索提供商
      if (pathname === '/api/search-providers' && method === 'DELETE') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          // 若当前正选中被删的那项，回落 bing，避免搜索直接报错
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) {
            updateConfig({ webSearch: { provider: 'bing' } });
          }
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试某个自定义搜索提供商是否可用
      if (pathname === '/api/search-providers/test' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const body = await readBody(req).catch(() => ({}));
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, {
            ok: true,
            result: {
              ok: true,
              count: r.results.length,
              sample: r.results[0]?.title || '',
              latencyMs: Date.now() - startedAt
            }
          });
        } catch (error) {
          return json(res, 200, {
            ok: true,
            result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt }
          });
        }
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      if (pathname === '/api/config' && method === 'GET') {
        // 不把任何真实 Key 暴露给前端：递归清空所有密钥类字段，用 hasKey 表示"有密钥"。
        // 注意：不要用手工逐字段列举——之前漏了 5 个搜索 Key 和 2 个 SnowLuma 令牌，
        // 加新 provider 时还会继续漏。这里按字段名模式统一处理。
        return json(res, 200, sanitizeConfig(cfgNow));
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        // 设置页直接改了角色卡 → 同步回当前人设的记录。
        // 不做这一步：改完角色卡 → 切到别的人设 → 切回来，改动就丢了。
        try { syncActivePersonaFromConfig(); } catch { /* ignore */ }
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        // 定时提醒：开关切换立即生效；顺带重启循环，让"检查间隔"改了也马上生效
        // （startReminderLoop 是幂等的，不先 stop 的话新间隔不会应用）
        orchestrator.stopReminderLoop();
        if (next.reminder?.enabled !== false) orchestrator.startReminderLoop();
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: next });
      }

      if (pathname === '/api/version' && method === 'GET') {
        // 纯本地读取，无网络依赖：设置页"当前版本"展示用
        return json(res, 200, appInfo());
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        // 上限 2^20（配置上限 1048576）：约等于不限，但拦得住真正的失控请求。
        // 前端靠分页（一次渲染 50 条）避免卡顿，后端不截断。
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        // 内存里的"等待中"状态合并进来一起返回：它已经不是会话实体了
        //（不落盘、不进索引），但对用户来说就该出现在会话列表最上面。
        const pending = orchestrator.pendingSummaries();
        return json(res, 200, { sessions: [...pending, ...sessions.listSummaries(limit)] });
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        // 等待态没有磁盘留档，直接由编排器合成（否则前端会拿到 404）
        const s = sessions.get(sessionMatch[1]) || orchestrator.getPendingSession(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      // 控制台数据管理：只删除用户使用中产生的记录，不修改任何功能配置或登录态。
      if (pathname === '/api/data/delete' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const area = String(body.area || '');
        const all = body.all === true;
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
        if (!all && !ids.length && !Array.isArray(body.messageIds)) return json(res, 400, { ok: false, error: '请先选择要清空的内容' });
        try {
          if (area === 'sessions') {
            const targets = all ? sessions.allRecordIds() : ids;
            if (targets.some((id) => typeof id !== 'string' || !/^[\w-]+$/.test(id))) throw new Error('会话 ID 不合法');
            if (targets.some((id) => sessions.current.has(id) || orchestrator.getPendingSession(id))) {
              return json(res, 409, { ok: false, error: '包含正在运行或等待的会话，请结束后重试' });
            }
            const removed = sessions.removeRecords(targets);
            emit('session-update', { phase: 'records-deleted' });
            return json(res, 200, { ok: true, removed: removed.length });
          }
          if (area === 'chats') {
            const keyPattern = /^(group|private):\d+$/;
            const chatKey = String(body.chatKey || '');
            const messageIds = Array.isArray(body.messageIds) ? [...new Set(body.messageIds)] : null;
            if (messageIds) {
              if (!keyPattern.test(chatKey) || !messageIds.length || messageIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
                throw new Error('消息选择无效');
              }
              if (orchestrator.runningChats.has(chatKey) || orchestrator.pendingPlans.has(chatKey)) {
                return json(res, 409, { ok: false, error: '该聊天正在处理消息，请结束后重试' });
              }
              const removed = store.removeMessages(chatKey, messageIds);
              emit('chat-update', chatKey);
              return json(res, 200, { ok: true, removed });
            }
            const targets = all ? store.listChats() : ids;
            if (targets.some((key) => typeof key !== 'string' || !keyPattern.test(key))) throw new Error('聊天标识不合法');
            if (targets.some((key) => orchestrator.runningChats.has(key) || orchestrator.pendingPlans.has(key))) {
              return json(res, 409, { ok: false, error: '包含正在处理消息的聊天，请结束后重试' });
            }
            let removed = 0;
            for (const key of targets) if (store.removeChat(key)) removed++;
            emit('chat-update', { phase: 'records-deleted' });
            return json(res, 200, { ok: true, removed });
          }
          if (area === 'memory') {
            const special = ['__global__', '__reminders__', '__style__'];
            const targets = all ? [...memory.listChats(), ...special] : ids;
            if (targets.some((key) => typeof key !== 'string' || (!/^(group|private):\d+$/.test(key) && !special.includes(key)))) {
              throw new Error('记忆标识不合法');
            }
            if (targets.some((key) => orchestrator.consolidating.has(key) || orchestrator.runningChats.has(key))) {
              return json(res, 409, { ok: false, error: '包含正在运行或整理的记忆，请结束后重试' });
            }
            if (targets.some((key) => special.includes(key)) && (orchestrator.runningChats.size || orchestrator.consolidating.size)) {
              return json(res, 409, { ok: false, error: '机器人正在使用记忆，请结束后重试' });
            }
            if (targets.includes('__reminders__') && memory.reminders?.list({ status: 'running' }).length) {
              return json(res, 409, { ok: false, error: '有提醒正在发送，请稍后重试' });
            }
            if (targets.includes('__style__') && memory.style?.distilling) {
              return json(res, 409, { ok: false, error: '风格学习正在运行，请稍后重试' });
            }
            let removed = 0;
            for (const key of targets.filter((key) => !special.includes(key))) if (memory.removeChat(key)) removed++;
            if (targets.includes('__global__')) { memory.global.clearAll(); removed++; }
            if (targets.includes('__reminders__')) { memory.reminders.clearAll(); removed++; }
            if (targets.includes('__style__')) { memory.style.clearAll(); removed++; }
            emit('memory-update', { phase: 'records-deleted' });
            emit('reminder-update', { phase: 'records-deleted' });
            emit('style-update', { phase: 'records-deleted' });
            return json(res, 200, { ok: true, removed });
          }
          return json(res, 400, { ok: false, error: '未知的数据区域' });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) });
        }
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        // 附带群名，让 UI 能显示"群名（群号）"。
        // 群名要调 OneBot 拿，可能慢或失败 —— 用 allSettled 保证绝不影响主流程：
        // 拿不到的 chatName 为空，UI 自动退回只显示群号。
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))   // 3s 超时保护
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }

      // ── 跨群聊长期记忆（memory-global）──
      // 总览：人物档案 + 长期事件 + 统计。记忆页签的「跨群档案」区块用它。
      if (pathname === '/api/memory-global' && method === 'GET') {
        const g = memory.global;
        if (!g) return json(res, 200, { stats: null, people: [], events: [] });
        const people = g.listPeople({ limit: 500 }).map((p) => ({
          userId: p.userId,
          name: p.primaryName || Object.values(p.names)[0] || p.userId,
          names: p.names,
          chats: Object.keys(p.names),
          updatedAt: p.updatedAt,
          factCount: p.facts.length,
          facts: p.facts.map((f) => ({
            id: f.id,
            content: f.content,
            importance: f.importance,
            pinned: f.pinned === true,
            hits: f.hits,
            weight: Number(effectiveWeight(f).toFixed(3)),
            from: [...new Set(f.sources.map((s) => s.chatKey))],
            at: f.lastTouchedAt
          }))
        }));
        const events = g.listEvents({ limit: 500 }).map((e) => ({
          id: e.id,
          text: e.text,
          kind: e.kind,
          scope: e.scope,
          chatKey: e.chatKey,
          origin: e.origin || '',
          participants: e.participants,
          importance: e.importance,
          pinned: e.pinned === true,
          resolved: e.resolved === true,
          createdAt: e.createdAt,
          lastMentionAt: e.lastMentionAt,
          weight: Number(effectiveWeight(e).toFixed(3))
        }));
        return json(res, 200, { stats: g.stats(), people, events });
      }

      // ── 表层记忆（刚说过的话，限时暂存）──
      // 列出当前还有效的表层记忆（可带 userId / chatKey 过滤），供 UI 展示与手动沉淀。
      if (pathname === '/api/memory-global/surface' && method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const items = memory.global?.listSurface({
          userId: String(url.searchParams.get('userId') || ''),
          chatKey: String(url.searchParams.get('chatKey') || ''),
          limit: Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200))
        }) || [];
        const now = Date.now();
        return json(res, 200, {
          items: items.map((s) => ({
            id: s.id,
            userId: s.userId,
            name: s.name || s.userId,
            chatKey: s.chatKey,
            text: s.text,
            at: s.at,
            expiresAt: s.expiresAt,
            remainMs: s.expiresAt ? Math.max(0, s.expiresAt - now) : 0,
            promoted: !!s.promotedAt
          }))
        });
      }

      // 把一条表层记忆沉淀为长期记忆（UI 的「存入长期」按钮）
      if (pathname === '/api/memory-global/surface/promote' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body.id ?? '').trim();
        if (!id) return json(res, 400, { ok: false, error: 'id 不能为空' });
        const r = memory.promoteSurface(id, {
          kind: String(body.kind ?? 'event'),
          importance: Number(body.importance) || 3,
          as: body.as === 'fact' ? 'fact' : 'event'
        });
        if (!r.ok) return json(res, 400, { ok: false, error: r.reason || '沉淀失败' });
        emit('memory-update', { phase: 'surface-promoted' });
        return json(res, 200, { ok: true, result: r });
      }

      const gmSurfaceMatch = /^\/api\/memory-global\/surface\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (gmSurfaceMatch && method === 'DELETE') {
        const done = memory.global?.removeSurface(gmSurfaceMatch[1]) === true;
        emit('memory-update', { phase: 'surface-removed' });
        return json(res, done ? 200 : 404, { ok: done });
      }

      // 手动记一条长期事件
      if (pathname === '/api/memory-global/events' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { ok: false, error: 'text 不能为空' });
        const event = memory.global?.noteEvent({
          text,
          kind: String(body.kind ?? 'event'),
          scope: body.scope === 'global' ? 'global' : 'chat',
          chatKey: String(body.chatKey ?? ''),
          participants: Array.isArray(body.participants) ? body.participants : [],
          importance: Number(body.importance) || 3,
          pinned: body.pinned === true
        });
        if (!event) return json(res, 400, { ok: false, error: '写入失败：检查 chatKey 或总开关' });
        emit('memory-update', { chatKey: event.chatKey || 'global', phase: 'global-event-added' });
        return json(res, 200, { ok: true, event });
      }

      const gmEventMatch = /^\/api\/memory-global\/events\/([A-Za-z0-9_]+)(\/resolve)?$/.exec(pathname);
      if (gmEventMatch && method === 'DELETE') {
        const done = memory.global?.forgetEvent(gmEventMatch[1]) === true;
        emit('memory-update', { phase: 'global-event-removed' });
        return json(res, done ? 200 : 404, { ok: done });
      }
      if (gmEventMatch && method === 'PATCH') {
        const body = await readBody(req).catch(() => ({}));
        const event = memory.global?.updateEvent(gmEventMatch[1], body) || null;
        if (!event) return json(res, 400, { ok: false, error: '更新失败：事件不存在或参数非法' });
        emit('memory-update', { phase: 'global-event-updated' });
        return json(res, 200, { ok: true, event });
      }
      if (gmEventMatch && gmEventMatch[2] && method === 'POST') {
        const done = memory.global?.resolveEvent(gmEventMatch[1]) === true;
        emit('memory-update', { phase: 'global-event-resolved' });
        return json(res, done ? 200 : 404, { ok: done });
      }

      // ── 梗知识库（网梗/游戏梗/群内黑话）────────────────────────────
      // 数据在 data/memory/_global/memes/memes.json；也可用 memes.md 导入。
      if (pathname === '/api/memes' && method === 'GET') {
        const memes = memory.memes;
        if (!memes) return json(res, 200, { memes: [], stats: null, files: null });
        return json(res, 200, {
          memes: memes.list({ includeDisabled: true, limit: 2000 }),
          stats: memes.stats(),
          cfg: getConfig().meme || {},
          files: {
            data: memes.file,
            import: MEME_IMPORT_FILE,
            readme: MEME_README_FILE
          }
        });
      }

      if (pathname === '/api/memes' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const r = memory.addMeme({ ...body, origin: 'manual' });
        if (!r.ok) return json(res, 400, r);
        emit('meme-update', { phase: r.merged ? 'merged' : 'added', id: r.entry.id });
        return json(res, 200, { ok: true, meme: r.entry, merged: r.merged === true, stats: memory.memeStats() });
      }

      // 从 memes.md 导入（每次点都做"同名合并"，不会重复建条目）
      if (pathname === '/api/memes/import' && method === 'POST') {
        const memes = memory.memes;
        if (!memes) return json(res, 400, { ok: false, error: '梗库模块未加载' });
        const body = await readBody(req).catch(() => ({}));
        let text = String(body.text ?? '');
        if (!text) {
          try { text = fs.readFileSync(MEME_IMPORT_FILE, 'utf8'); } catch { /* 文件不存在 */ }
        }
        const r = memes.importMarkdown(text);
        if (r.ok) emit('meme-update', { phase: 'imported', added: r.added, merged: r.merged });
        return json(res, r.ok ? 200 : 400, { ...r, stats: memes.stats() });
      }

      // 写出格式说明/模板文件（用户删了能重新生成）
      if (pathname === '/api/memes/init-files' && method === 'POST') {
        const memes = memory.memes;
        if (!memes) return json(res, 400, { ok: false, error: '梗库模块未加载' });
        try {
          fs.mkdirSync(path.dirname(MEME_README_FILE), { recursive: true });
          if (!fs.existsSync(MEME_README_FILE)) fs.writeFileSync(MEME_README_FILE, memeTemplate('README.md'), 'utf8');
          if (!fs.existsSync(MEME_IMPORT_FILE)) fs.writeFileSync(MEME_IMPORT_FILE, memeTemplate('memes.md'), 'utf8');
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
        return json(res, 200, { ok: true, files: { import: MEME_IMPORT_FILE, readme: MEME_README_FILE } });
      }

      const memeMatch = /^\/api\/memes\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (memeMatch && method === 'GET') {
        const memes = memory.memes;
        const one = memes?.get(decodeURIComponent(memeMatch[1])) || null;
        return json(res, one ? 200 : 404, one ? { ok: true, meme: one } : { ok: false, error: '找不到这条梗' });
      }
      if (memeMatch && method === 'PATCH') {
        const memes = memory.memes;
        if (!memes) return json(res, 400, { ok: false, error: '梗库模块未加载' });
        const body = await readBody(req).catch(() => ({}));
        const r = memes.update(decodeURIComponent(memeMatch[1]), body);
        if (!r.ok) return json(res, 400, r);
        emit('meme-update', { phase: 'updated', id: r.entry.id });
        return json(res, 200, { ok: true, meme: r.entry, stats: memes.stats() });
      }
      if (memeMatch && method === 'DELETE') {
        const memes = memory.memes;
        if (!memes) return json(res, 400, { ok: false, error: '梗库模块未加载' });
        const r = memes.remove(decodeURIComponent(memeMatch[1]));
        if (r.ok) emit('meme-update', { phase: 'removed', id: memeMatch[1] });
        return json(res, r.ok ? 200 : 404, { ...r, stats: memes.stats() });
      }

      // 手动+1（控制台上看到某条梗被用了，点一下记一笔，用于统计）
      const memeUseMatch = /^\/api\/memes\/([A-Za-z0-9_]+)\/use$/.exec(pathname);
      if (memeUseMatch && method === 'POST') {
        const memes = memory.memes;
        if (!memes) return json(res, 400, { ok: false, error: '梗库模块未加载' });
        const body = await readBody(req).catch(() => ({}));
        const updated = memes.markUsed(decodeURIComponent(memeUseMatch[1]), String(body?.context ?? '（控制台手动记录）'));
        if (!updated) return json(res, 404, { ok: false, error: '找不到这条梗' });
        return json(res, 200, { ok: true, meme: updated, stats: memes.stats() });
      }

      // ── 搜图服务 ─────────────────────────────────────────────────
      // 图片中转：控制台预览用。
      // 为什么必须中转：pixiv 图床（i.pximg.net）有防盗链，浏览器直接 <img src> 会 403，
      // 控制台的缩略图就会全是裂图。这里由主进程带 referer 下载后回吐（顺带过一遍
      // safe-fetch 的内网校验，等于把控制台也保护起来了）。
      if (pathname === '/api/image-proxy' && method === 'GET') {
        const raw = String(url.searchParams.get('u') || '');
        if (!raw) return json(res, 400, { ok: false, error: '缺少 u 参数' });
        try {
          const got = await downloadImageBuffer(raw, { maxBytes: 6 * 1024 * 1024 });
          res.writeHead(200, {
            'content-type': got.mime || 'image/jpeg',
            'content-length': got.buffer.length,
            'cache-control': 'public, max-age=600'
          });
          res.end(got.buffer);
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      // 控制台"试搜"用：只返回结果信息（不发图），顺便验证图源配置。
      // items[].thumb 给的是 /api/image-proxy 中转地址（前端直接塞 <img src> 即可）。
      // 返回条数按请求的 limit（人气排序会给 rankPool 个候选补查详情，但没必把整个池子
      // 都丢回前端 —— 试搜的缩略图每个都要过一次中转，白花流量）。
      if (pathname === '/api/image-search' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const query = String(body.query ?? '').trim();
        if (!query) return json(res, 400, { ok: false, error: '请填搜索词' });
        const cfg = imageSearchConfig();
        const wantLimit = Math.min(10, Math.max(1, Number(body.limit) || cfg.defaultLimit || 3));
        try {
          const res2 = await searchImages(query, {
            cfg,
            provider: String(body.provider || cfg.provider),
            limit: wantLimit,
            stage: String(body.stage || 'auto'),
            hideAi: body.hideAi === undefined ? cfg.hideAi : body.hideAi !== false,
            allowR18: body.allowR18 === true && cfg.allowR18 === true
          });
          const shown = res2.items.slice(0, Math.max(wantLimit, 1));
          return json(res, 200, {
            ok: true,
            provider: res2.provider,
            query: res2.query,
            attempts: res2.attempts,
            dropped: res2.dropped,
            sortBy: cfg.sortBy,
            minBookmarks: cfg.minBookmarks,
            totalFound: res2.items.length,
            items: shown.map((it) => ({
              id: it.id,
              title: it.title,
              author: it.author,
              tags: (it.tags || []).slice(0, 12),
              width: it.width,
              height: it.height,
              ai: it.ai,
              rating: it.rating,
              source: it.source,
              // 人气（控制台里用来一眼看出"这图好不好看"）
              bookmarkCount: Number.isFinite(Number(it.bookmarkCount)) ? Number(it.bookmarkCount) : null,
              likeCount: Number.isFinite(Number(it.likeCount)) ? Number(it.likeCount) : null,
              viewCount: Number.isFinite(Number(it.viewCount)) ? Number(it.viewCount) : null,
              // 中转预览地址：pixiv 等图床有防盗链，浏览器直连会 403
              thumb: `/api/image-proxy?u=${encodeURIComponent(it.thumb || it.url)}`,
              pageUrl: it.pageUrl || ''
            }))
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── 表情库管理（控制台：备注/新增/删除/待备注清单）──────────
      if (pathname === '/api/stickers' && method === 'GET') {
        const q = String(url.searchParams.get('q') ?? '').trim();
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const onlyUnnoted = url.searchParams.get('unnoted') === '1';
        try {
          // 控制台要看到 URL 才能预览/编辑，所以这里直接给完整条目（tools 那套是给模型的精简版）
          const all = stickers.entries.map((e) => ({
            id: e.id,
            url: e.url,
            desc: e.desc,
            label: e.label,
            localNote: e.localNote,
            tags: e.tags,
            moods: e.moods,
            usage: e.usage,
            avoid: e.avoid,
            source: e.source,
            useCount: e.useCount,
            updatedAt: e.updatedAt
          }));
          const list = onlyUnnoted ? all.filter((e) => !e.localNote && !e.usage) : all;
          const ql = q.toLowerCase();
          const filtered = ql
            ? list.filter((e) => [e.label, e.desc, e.localNote, e.usage, ...(e.tags || []), ...(e.moods || [])].join(' ').toLowerCase().includes(ql))
            : list;
          return json(res, 200, {
            ok: true,
            stats: stickers.stats(),
            total: all.length,
            count: filtered.length,
            stickers: filtered.slice(0, limit)
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/stickers' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        try {
          const entry = stickers.add({
            url: String(body.url ?? ''),
            label: String(body.label ?? ''),
            note: String(body.note ?? ''),
            tags: Array.isArray(body.tags) ? body.tags : [],
            moods: Array.isArray(body.moods) ? body.moods : [],
            usage: String(body.usage ?? '')
          });
          return json(res, 200, { ok: true, sticker: entry, stats: stickers.stats() });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      const stickerMatch = /^\/api\/stickers\/([^/]+)$/.exec(pathname);
      if (stickerMatch && method === 'PATCH') {
        const body = await readBody(req).catch(() => ({}));
        const entry = stickers.note(decodeURIComponent(stickerMatch[1]), {
          note: body.note !== undefined ? String(body.note) : undefined,
          label: body.label !== undefined ? String(body.label) : undefined,
          desc: body.desc !== undefined ? String(body.desc) : undefined,
          tags: Array.isArray(body.tags) ? body.tags : undefined,
          moods: Array.isArray(body.moods) ? body.moods : undefined,
          usage: body.usage !== undefined ? String(body.usage) : undefined,
          avoid: body.avoid !== undefined ? String(body.avoid) : undefined,
          // 控制台清空字段：控制台把每格都回传，"清空"表现为空串/空数组，
          // 所以要显式告诉后端"这些是我故意清掉的"（否则会被当成"没提供"而保留旧值）。
          clear: (() => {
            const c = [];
            if (body.note === '') c.push('note');
            if (body.label === '') c.push('label');
            if (body.usage === '') c.push('usage');
            if (body.avoid === '') c.push('avoid');
            if (Array.isArray(body.tags) && body.tags.length === 0) c.push('tags');
            if (Array.isArray(body.moods) && body.moods.length === 0) c.push('moods');
            return c;
          })(),
          source: 'manual'
        });
        if (!entry) return json(res, 404, { ok: false, error: '找不到这个表情' });
        return json(res, 200, { ok: true, sticker: entry, stats: stickers.stats() });
      }
      if (stickerMatch && method === 'DELETE') {
        const r = stickers.remove(decodeURIComponent(stickerMatch[1]));
        if (!r.ok) return json(res, 404, r);
        return json(res, 200, { ...r, stats: stickers.stats() });
      }

      const gmPersonMatch = /^\/api\/memory-global\/people\/(\d{1,15})$/.exec(pathname);
      if (gmPersonMatch && method === 'GET') {
        const person = memory.global?.getPerson(gmPersonMatch[1]) || null;
        return json(res, person ? 200 : 404, { ok: !!person, person });
      }
      if (gmPersonMatch && method === 'PUT') {
        const body = await readBody(req).catch(() => ({}));
        const list = Array.isArray(body.impressions) ? body.impressions : [body.impressions];
        const person = memory.global?.replaceFacts(gmPersonMatch[1], list.filter(Boolean), {
          name: String(body.name ?? ''),
          chatKey: String(body.chatKey ?? '')
        });
        if (!person) return json(res, 400, { ok: false, error: '写入失败：QQ 号不合法或长期记忆被关闭' });
        emit('memory-update', { phase: 'global-person-updated' });
        return json(res, 200, { ok: true, person });
      }
      if (gmPersonMatch && method === 'DELETE') {
        const done = memory.global?.forgetPerson(gmPersonMatch[1]) === true;
        emit('memory-update', { phase: 'global-person-removed' });
        return json(res, done ? 200 : 404, { ok: done });
      }

      const gmFactMatch = /^\/api\/memory-global\/people\/(\d{1,15})\/facts\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (gmFactMatch && method === 'DELETE') {
        const removed = memory.global?.forgetFact(gmFactMatch[1], { factId: gmFactMatch[2] }) || 0;
        emit('memory-update', { phase: 'global-fact-removed' });
        return json(res, 200, { ok: removed > 0, removed });
      }

      // 从既有的各群印象重建跨群档案（一次性迁移 / 随时可重跑，幂等）。
      // 用户历史数据里已经攒了印象，不该等到"下一个会话被整理"才进跨群档案。
      if (pathname === '/api/memory-global/rebuild' && method === 'POST') {
        const g = memory.global;
        if (!g) return json(res, 400, { ok: false, error: '长期记忆未初始化' });
        let chats = 0;
        let syncedMembers = 0;
        const detail = [];
        for (const chatKey of memory.listChats()) {
          const members = memory.members(chatKey);
          if (!members.length) continue;
          chats += 1;
          let n = 0;
          for (const m of members) {
            if (!m.userId || !m.impressions.length) continue;
            g.syncChatFacts(m.userId, m.impressions.map((e) => e.content), { name: m.name, chatKey });
            n += 1;
          }
          syncedMembers += n;
          detail.push({ chatKey, members: members.length, synced: n });
        }
        emit('memory-update', { phase: 'global-rebuild' });
        return json(res, 200, { ok: true, chats, syncedMembers, detail, stats: g.stats() });
      }

      // 手动跑一次遗忘曲线（dryRun=1 只看会清理什么，不落盘）
      if (pathname === '/api/memory-global/decay' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const dryRun = body.dryRun === true || body.dryRun === 1 || body.dryRun === '1';
        const result = memory.global?.decay({ dryRun }) || null;
        emit('memory-update', { phase: 'decay', ...(result || {}) });
        return json(res, 200, { ok: true, result, stats: memory.global?.stats?.() ?? null });
      }

      // ── 定时提醒 ──────────────────────────────────────────────────────
      // 列表：控制台「记忆 → ⏰ 定时提醒」用；模型自己走 remind_at 工具
      if (pathname === '/api/reminders' && method === 'GET') {
        const store = memory.reminders;
        if (!store) return json(res, 200, { stats: null, items: [] });
        const url = new URL(req.url, 'http://127.0.0.1');
        const chatKey = url.searchParams.get('chatKey') || '';
        const status = url.searchParams.get('status') || '';
        return json(res, 200, {
          stats: store.stats(),
          items: store.list({ chatKey, status, limit: 500 }),
          cfg: getConfig().reminder || {}
        });
      }

      // 手工新建（控制台用）
      if (pathname === '/api/reminders' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const parsed = parseReminderWhen(String(body.when ?? body.dueAt ?? ''));
        if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error });
        const r = memory.createReminder({
          text: String(body.text ?? ''),
          note: String(body.note ?? ''),
          dueAt: parsed.at,
          chatKey: String(body.chatKey ?? ''),
          targetUserId: body.targetUserId ?? '',
          targetName: String(body.targetName ?? ''),
          repeat: body.repeat || null,
          importance: Number(body.importance) || 3,
          source: 'manual'
        });
        if (!r.ok) return json(res, 400, r);
        emit('reminder-update', { phase: 'created', id: r.item.id, chatKey: r.item.chatKey });
        return json(res, 200, { ok: true, item: r.item, stats: memory.reminders.stats() });
      }

      // 清理已结束的历史记录（保留天数额见 config.reminder.ttlDays）
      if (pathname === '/api/reminders/prune' && method === 'POST') {
        const removed = memory.reminders.prune();
        emit('reminder-update', { phase: 'pruned', removed });
        return json(res, 200, { ok: true, removed, stats: memory.reminders.stats() });
      }

      // 立即触发一条（把时间提到现在，并立刻叫一次调度器，不用等轮询）
      const remFireMatch = /^\/api\/reminders\/([A-Za-z0-9_]+)\/fire$/.exec(pathname);
      if (remFireMatch && method === 'POST') {
        const r = memory.fireReminderNow(remFireMatch[1]);
        if (!r.ok) return json(res, 404, r);
        // 不等它跑完：触发里可能有一次模型调用（几十秒），
        // 卡住这个 HTTP 请求只会让控制台转圈。结果通过 SSE reminder-update 回来。
        orchestrator.dispatchDueReminders().catch(() => {});
        return json(res, 200, { ok: true, item: r.item });
      }

      const remMatch = /^\/api\/reminders\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (remMatch && method === 'PATCH') {
        const body = await readBody(req).catch(() => ({}));
        const patch = { ...body };
        if (body.when !== undefined) {
          const parsed = parseReminderWhen(String(body.when));
          if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error });
          patch.dueAt = parsed.at;
          delete patch.when;
        }
        const r = memory.reminders.update(remMatch[1], patch);
        if (!r.ok) return json(res, 400, r);
        emit('reminder-update', { phase: 'updated', id: r.item.id, chatKey: r.item.chatKey });
        return json(res, 200, { ok: true, item: r.item, stats: memory.reminders.stats() });
      }
      if (remMatch && method === 'DELETE') {
        const done = memory.reminders.remove(remMatch[1]);
        emit('reminder-update', { phase: 'removed', id: remMatch[1] });
        return json(res, done ? 200 : 404, { ok: done, stats: memory.reminders.stats() });
      }

      // ── 真人说话风格学习 ────────────────────────────────────────────
      if (pathname === '/api/style' && method === 'GET') {
        const style = memory.style;
        if (!style) return json(res, 200, { stats: null, items: [] });
        return json(res, 200, {
          stats: style.stats(),
          items: style.items(),
          samples: style.samples.slice(-60).map((s) => ({
            ts: s.ts,
            chatKey: s.chatKey,
            kind: s.kind,
            text: s.kind === 'speech' ? s.text : `${s.stim.text}${s.stim.caption ? `（${s.stim.caption}）` : ''} → ${s.resp.text}`
          })),
          cfg: getConfig().styleLearn || {}
        });
      }

      if (pathname === '/api/style/distill' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const r = await orchestrator.distillStyle({ force: body.force !== false });
        return json(res, r.ok ? 200 : 400, { ...r, stats: memory.style?.stats?.() ?? null });
      }

      if (pathname === '/api/style/items' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const r = memory.style.addItem(String(body.kind ?? 'speech'), String(body.text ?? ''), {
          confidence: Number(body.confidence) || 0.8,
          source: 'manual'
        });
        if (!r.ok) return json(res, 400, r);
        emit('style-update', { phase: 'item-added', kind: r.kind });
        return json(res, 200, { ok: true, ...r, stats: memory.style.stats() });
      }

      const styleItemMatch = /^\/api\/style\/items\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (styleItemMatch && method === 'PATCH') {
        const body = await readBody(req).catch(() => ({}));
        const done = memory.style.pinItem(styleItemMatch[1], body.pinned !== false);
        emit('style-update', { phase: 'item-pinned' });
        return json(res, done ? 200 : 404, { ok: done, stats: memory.style.stats() });
      }
      if (styleItemMatch && method === 'DELETE') {
        const done = memory.style.removeItem(styleItemMatch[1]);
        emit('style-update', { phase: 'item-removed' });
        return json(res, done ? 200 : 404, { ok: done, stats: memory.style.stats() });
      }

      if (pathname === '/api/style/samples' && method === 'DELETE') {
        memory.style.clearSamples();
        emit('style-update', { phase: 'samples-cleared' });
        return json(res, 200, { ok: true, stats: memory.style.stats() });
      }
      if (pathname === '/api/style/profile' && method === 'DELETE') {
        memory.style.clearProfile();
        emit('style-update', { phase: 'profile-cleared' });
        return json(res, 200, { ok: true, stats: memory.style.stats() });
      }

      // 记忆文件列表：只展示实际保存的群友印象或正在整理的聊天。
      if (pathname === '/api/memory-files' && method === 'GET') {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey,
            impressionCount,
            memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        // 带上"正在整理"状态：切页签后前端靠它恢复提示，
        // 否则用户切走再切回，完全看不出整理是在跑还是已经中断。
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files: files.filter((f) => f.memberCount > 0 || f.impressionCount > 0 || f.consolidating), consolidating: [...busy] });
      }

      const memoryFileMatch = /^\/api\/memory-files\/(group|private)_(\d+)$/.exec(pathname);
      if (memoryFileMatch && method === 'GET') {
        const chatKey = `${memoryFileMatch[1]}:${memoryFileMatch[2]}`;
        return json(res, 200, {
          ...memory.query(chatKey),
          members: memory.members(chatKey)
        });
      }

      // 手动编辑某个群友的印象（PUT 编辑：QQ号必填，备注可同步保存 / DELETE 删除成员文件）
      const memoryMemberMatch = /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/.exec(pathname);
      if (memoryMemberMatch && method === 'PUT') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        const body = await readBody(req).catch(() => ({}));
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: memoryMemberMatch[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (memoryMemberMatch && method === 'DELETE') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        memory.removeMember(chatKey, memoryMemberMatch[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }

      // 手动整理某个群的记忆：遍历聊天记录中出现的成员，逐人整理直到收敛
      if (pathname === '/api/memory-files/consolidate' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });

          // 可选：只整理指定的群友（QQ 号数组）。不传 = 整理全群。
          // 传了但记忆里还没有此人时，会从聊天记录里新建印象。
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          // 手动触发：跳过门槛/冷却检查，且对零印象的人启用"新建印象"模式
          const force = body.force !== false;

          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => {
              emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) });
            })
            .catch((error) => {
              emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) });
            })
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        // 单群消息上限 2^20：约等于不限，存档一口气全给
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply,
          // skip = 被档位判定跳过（机器人决定不回应）。带上它，存档页才能
          // 把"它看见了但选择不说"和"它没收到"区分开。
          skip: m.skip || null,
          // 保留媒体定位信息，供存档展示和图片功能使用。
          // （曾经漏了这个字段，前端收到的 media 永远是 undefined → 图片全丢）
          media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }

      // 群成员列表（OneBot get_group_member_list），用于备注与记忆页成员展示
      const groupMembersMatch = /^\/api\/groups\/(\d+)\/members$/.exec(pathname);
      if (groupMembersMatch && method === 'GET') {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(groupMembersMatch[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const ok = orchestrator.forceWake(chatKey);
        return json(res, 200, { ok });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      // ── 群管理员指令（群内「禁言 / 解除」）──────────────────────
      if (pathname === '/api/admins' && method === 'GET') {
        const cfgA = getConfig().admin || {};
        return json(res, 200, {
          ok: true,
          enabled: cfgA.enabled !== false,
          admins: listAdmins(),
          muteReply: String(cfgA.muteReply ?? '')
        });
      }
      if (pathname === '/api/admins' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        if (body.enabled !== undefined) {
          updateConfig({ admin: { enabled: !!body.enabled } });
        }
        if (body.muteReply !== undefined) {
          updateConfig({ admin: { muteReply: String(body.muteReply).slice(0, 200) } });
        }
        if (body.groupId !== undefined) {
          const r = setAdmin(String(body.groupId ?? ''), String(body.userId ?? ''));
          if (!r.ok) return json(res, 400, r);
        }
        return json(res, 200, { ok: true, admins: listAdmins(), muteReply: String(getConfig().admin?.muteReply ?? '') });
      }
      const adminMatch = /^\/api\/admins\/(\d{1,15})$/.exec(pathname);
      if (adminMatch && method === 'DELETE') {
        const r = setAdmin(adminMatch[1], '');
        if (!r.ok) return json(res, 400, r);
        return json(res, 200, { ok: true, ...r, admins: listAdmins() });
      }

      // ── 群禁言（命中即完全不触发 AI 运行，省 token）──────────────
      if (pathname === '/api/muted-groups' && method === 'GET') {
        return json(res, 200, { ok: true, groups: listMuted(), muted: listMuted().filter((x) => !x.expired).length });
      }
      if (pathname === '/api/muted-groups' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const groupId = String(body.groupId ?? body.group ?? '').trim();
        if (!/^\d{1,15}$/.test(groupId)) return json(res, 400, { ok: false, error: 'groupId 必须是数字群号' });
        // 支持三种到期写法：until（时间戳）| minutes（多少分钟后）| 都不传 = 永久
        let until = Math.max(0, Number(body.until) || 0);
        if (!until && Number(body.minutes) > 0) until = Date.now() + Number(body.minutes) * 60000;
        const r = muteGroup(groupId, { until, reason: String(body.reason ?? ''), by: String(body.by ?? 'manual') });
        if (!r.ok) return json(res, 400, r);
        // 禁言生效后，把该群未读沉掉（不留积压，解禁不炸）
        orchestrator.emit('chat-update', `group:${groupId}`);
        return json(res, 200, { ok: true, group: r, groups: listMuted() });
      }
      const muteMatch = /^\/api\/muted-groups\/(\d+)$/.exec(pathname);
      if (muteMatch && method === 'DELETE') {
        const r = unmuteGroup(muteMatch[1]);
        if (!r.ok) return json(res, 400, r);
        orchestrator.emit('chat-update', `group:${muteMatch[1]}`);
        return json(res, 200, { ok: true, ...r, groups: listMuted() });
      }

      // ── 发言人昵称历史（改名识别）────────────────────────────────
      if (pathname === '/api/identity/aliases' && method === 'GET') {
        const snap = aliasSnapshot();
        return json(res, 200, { ok: true, members: snap, renamed: snap.filter((x) => x.renamed).length });
      }
      const aliasMatch = /^\/api\/identity\/aliases\/(\d+)$/.exec(pathname);
      if (aliasMatch && method === 'GET') {
        const uid = aliasMatch[1];
        return json(res, 200, { ok: true, userId: uid, current: currentNameOf(uid), history: aliasesOf(uid) });
      }
      if (aliasMatch && method === 'DELETE') {
        // 清空某人的昵称历史（只留当前名）——脏数据修正用
        const uid = aliasMatch[1];
        const cur = currentNameOf(uid);
        const all = { ...(getConfig().memberAliases || {}) };
        if (cur) all[uid] = [{ name: cur, at: Date.now() }];
        else delete all[uid];
        updateConfig({ memberAliases: all });
        return json(res, 200, { ok: true, userId: uid, history: aliasesOf(uid) });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        // 恢复时的积压补处理已并入 setPaused（托盘菜单、HTTP 走同一条路）。
        // skipBacklog = 用户明确选择"丢弃积压"，此时**不能**排补处理。
        orchestrator.setPaused(!!body.paused, 'manual', { skipBacklog: !!body.skipBacklog });
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        // skipBacklog：别排补处理 —— 下面马上就要把这批未读标掉了，排了就打架
        orchestrator.setPaused(false, 'resumed', { skipBacklog: true });
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // 静态 UI
    if (req.method === 'GET' || req.method === 'HEAD') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const ext = path.extname(fullPath);
        // 视频按需流式发送，支持 Chromium 的字节范围请求；不把整段视频读入内存。
        if (ext === '.mp4') {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) throw new Error('Not a file');
          const size = stat.size;
          let start = 0;
          let end = size - 1;
          const range = req.headers.range;
          if (range) {
            const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
            let valid = !!parts && !!(parts[1] || parts[2]);
            if (valid) {
              if (!parts[1]) {
                const suffix = Number(parts[2]);
                valid = Number.isSafeInteger(suffix) && suffix > 0;
                start = Math.max(0, size - suffix);
              } else {
                start = Number(parts[1]);
                end = parts[2] ? Math.min(Number(parts[2]), end) : end;
              }
              valid = valid && Number.isSafeInteger(start) && Number.isSafeInteger(end)
                && start >= 0 && start < size && end >= start;
            }
            if (!valid) {
              res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' });
              res.end();
              return;
            }
          }
          const headers = {
            'content-type': 'video/mp4', 'accept-ranges': 'bytes',
            'content-length': Math.max(0, end - start + 1), 'cache-control': 'no-cache'
          };
          if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
          res.writeHead(range ? 206 : 200, headers);
          if (req.method === 'HEAD' || size === 0) { res.end(); return; }
          const stream = fs.createReadStream(fullPath, { start, end });
          stream.on('error', () => res.destroy());
          res.once('close', () => stream.destroy());
          stream.pipe(res);
          return;
        }
        const data = fs.readFileSync(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start({ portOverride } = {}) {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number.isInteger(portOverride) && portOverride > 0 && portOverride <= 65535 ? portOverride : Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');


    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const wsPort = snowlumaWsPort();
        if (!(await isPortOpen('127.0.0.1', wsPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      // accessToken/httpToken 已由 applyTokens 直接挂到实例（候选[0]）
    }
    await onebot.connect();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startMemoryMaintenance();
    orchestrator.startReminderLoop();
    // 上次中断的运行：把放回未读的那批排一次处理（延迟一点，等连接与各循环就绪）
    for (const chatKey of recoveredChats) orchestrator.scheduleWake(chatKey, 3000);
    startSnowlumaWatchdog();
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    orchestrator.stopMemoryMaintenance();
    orchestrator.stopReminderLoop();
    stopSnowlumaWatchdog();
    stopSnowlumaLogTail();
    await orchestrator.abortAll();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程。
    // 注意：SnowLuma 退出时不一定能立刻把 config 落盘，但我们的 stop 不会再去读它，
    // 下次启动会读到完整文件。
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus };
}

/**
 * 用量数据：按天 / 按会话 / 按群聚合最近 N 天的调用记录。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs;
  } catch {
    return '';
  }
}

function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      rows: usageRowsCache.rows.slice(),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数，与调用行一起读取。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const started = Number(s.startedAt) || 0;
    if (!started) continue;

    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (started >= win.start && started <= win.end) {
      searchCount += Number(s.webSearchCount) || 0;
      for (const m of (s.messages || [])) {
        const name = m && m.toolCall && m.toolCall.name;
        if (name) toolCounts[String(name)] = (toolCounts[String(name)] || 0) + 1;
      }
    }

    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const calls = [];
    for (const m of (s.messages || [])) {
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      calls.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }

    if (calls.length) {
      for (const c of calls) {
        if (c.at < win.start || c.at > win.end) continue;
        rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (!p && !c) continue;
      if (started < win.start || started > win.end) continue;
      rows.push({
        promptTokens: p,
        completionTokens: c,
        cachedTokens: Number(u.cachedTokens) || 0,
        at: started,
        model: String(s.model || '') || '(未知)',
        chatKey: String(s.chatKey || '(未知)'),
        vendor: String(s.vendor || ''),
        sessionId: s.id,
        exact: false
      });
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.slice();
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

/** 对一批调用只统计 token 与次数，不读取任何价格配置。 */
function summarizeUsageRows(rows) {
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0;
  for (const r of rows) {
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    exactCalls, runs: rows.length
  };
}

/** 按某个字段分组并统计用量。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...summarizeUsageRows(list) }));
  out.sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。 */
function buildUsageStats({ range = '7' } = {}) {
  const { rows, win, searchCount, toolCounts } = collectUsageRows({ range });
  const totals = summarizeUsageRows(rows);
  // 按天分桶需要 dayKey 字段
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  const byDay = win.mode === 'days'
    ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
    : [];
  const chats = groupBy(rows, 'chatKey', 0);
  // 保留全部分组，前端负责长列表滚动。
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    chats,
    models
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的用量
 */
function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = summarizeUsageRows(subset);
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    rows: groups.map((g) => ({
      key: g.key,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}
