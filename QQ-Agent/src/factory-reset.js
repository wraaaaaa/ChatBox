// 完整初始化在新进程导入业务组件之前执行，防止旧缓存/异步任务把数据写回来。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DEFAULT_CONFIG } from './config.js';
import { writeJsonAtomic } from './util.js';

export const RESET_PHRASE = '初始化';
export const RESET_SCOPE = '模型及搜索/搜图密钥、全部用户设置和自定义人设、聊天/会话存档、记忆、提醒、风格、梗库、表情缓存、用量与日志、旧配置备份，以及内置 SnowLuma 的配置和账号数据';

function assertPlainPath(target) {
  for (let p = path.resolve(target); ; p = path.dirname(p)) {
    let stat;
    try { stat = fs.lstatSync(p); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('初始化目录不能是符号链接或目录联接');
    if (path.dirname(p) === p) break;
  }
}

export function resetPlan({ dataDir, root, bridgeDir = path.join(root, 'snowluma'), configuredBridgeDir = '' }) {
  const data = path.resolve(dataDir);
  const appRoot = path.resolve(root);
  const bridge = path.resolve(bridgeDir);
  if (path.basename(data).toLowerCase() !== 'data' || data === appRoot
      || !path.relative(data, appRoot).startsWith('..')
      || !path.relative(data, bridge).startsWith('..')) {
    throw new Error('数据目录范围不安全，已拒绝初始化');
  }
  // 外部 SnowLuma 可能被其他项目共用，不能把删除范围扩大到任意配置路径。
  if (configuredBridgeDir && path.resolve(configuredBridgeDir).toLowerCase() !== bridge.toLowerCase()) {
    throw new Error('当前使用外部 SnowLuma。请先切换到项目内置目录，再执行全部初始化');
  }
  for (const p of [data, bridge, ...['config', 'data', 'logs'].map(n => path.join(bridge, n))]) assertPlainPath(p);
  return { data, bridge, targets: [data, ...['config', 'data', 'logs'].map(n => path.join(bridge, n))],
    journal: path.join(path.dirname(data), 'data.factory-reset.json') };
}

export function resetStatus(plan) {
  try {
    const job = JSON.parse(fs.readFileSync(plan.journal, 'utf8'));
    return { state: job.error ? 'failed' : 'restarting', id: job.id, error: job.error || '' };
  } catch { /* 没有待执行任务 */ }
  try {
    const result = JSON.parse(fs.readFileSync(path.join(plan.data, 'factory-reset-result.json'), 'utf8'));
    return { state: 'complete', id: result.id, completedAt: result.completedAt };
  } catch { return { state: 'idle' }; }
}

export function armReset(plan, { parentPid = process.pid, restartPort } = {}) {
  if (fs.existsSync(plan.journal)) throw new Error('已有初始化任务，请先重启应用完成它');
  const job = { id: crypto.randomUUID(), parentPid, phase: 'staging', createdAt: Date.now() };
  if (Number.isInteger(restartPort) && restartPort > 0 && restartPort <= 65535) job.restartPort = restartPort;
  writeJsonAtomic(plan.journal, job);
  return job;
}

export function createResetChallenge({ now = Date.now } = {}) {
  let pending = null;
  return {
    prepare() {
      pending = { token: crypto.randomBytes(32).toString('hex'), expiresAt: now() + 180000 };
      return { ...pending, phrase: RESET_PHRASE, scope: RESET_SCOPE };
    },
    consume(body) {
      if (!pending || now() > pending.expiresAt || body?.token !== pending.token || body?.confirmation !== RESET_PHRASE) {
        throw new Error('二次确认无效或已过期，请重新点击初始化');
      }
      pending = null; // 单次使用，重复点击不能重启第二次
    }
  };
}

export async function runPendingResetOnStartup(options, dependencies) {
  const journal = path.join(path.dirname(path.resolve(options.dataDir)), 'data.factory-reset.json');
  // 安全删除的目录限制仅适用于初始化，不改变普通启动的数据目录兼容性。
  if (!fs.existsSync(journal)) return null;
  return runPendingReset(resetPlan(options), dependencies);
}

async function waitForParent(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) throw new Error('初始化必须在旧进程退出后执行');
  const until = Date.now() + 15000;
  while (true) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= until) throw new Error('旧进程尚未退出，未清除数据，请关闭旧窗口后重试');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// 精确匹配包内运行时，绝不关闭电脑上的 QQ 客户端或其他 Node 进程。
export async function stopBundledBridge(bridge) {
  if (process.platform !== 'win32' || !fs.existsSync(path.join(bridge, 'node.exe'))) return;
  const exe = path.join(bridge, 'node.exe').replace(/'/g, "''");
  // 无窗口入口也可能借用包内 node.exe；不能把正在清理的新进程自己结束。
  const filter = `$_.ExecutablePath -eq '${exe}' -and $_.ProcessId -ne ${process.pid}`;
  const script = `$ErrorActionPreference='Stop'; $targets=@(Get-CimInstance Win32_Process | Where-Object { ${filter} }); foreach ($p in $targets) { Stop-Process -Id $p.ProcessId -Force }; Start-Sleep -Milliseconds 250; if (@(Get-CimInstance Win32_Process | Where-Object { ${filter} }).Count) { throw 'SnowLuma 进程未退出' }`;
  await new Promise((resolve, reject) => {
    const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('关闭 SnowLuma 超时，未清除数据')); }, 15000);
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('无法确认 SnowLuma 已关闭，未清除数据')); });
  });
}

export async function runPendingReset(plan, { stopBridge = stopBundledBridge, waitParent = waitForParent, io = fs } = {}) {
  if (!fs.existsSync(plan.journal)) return null;
  const job = JSON.parse(fs.readFileSync(plan.journal, 'utf8'));
  if (!/^[a-f0-9-]{36}$/.test(job.id) || !['staging', 'deleting'].includes(job.phase)) throw new Error('初始化任务文件无效');
  const staged = plan.targets.map(original => ({ original, backup: `${original}.factory-reset-${job.id}` }));
  try {
    await waitParent(job.parentPid);
    await stopBridge(plan.bridge);
    // 新进程重新检查，不能仅信任按钮点击时的目录校验。
    for (const p of [plan.data, plan.bridge, ...plan.targets, ...staged.map(s => s.backup)]) assertPlainPath(p);
    if (job.phase === 'staging') {
      for (const s of staged) {
        if (!io.existsSync(s.backup) && io.existsSync(s.original)) io.renameSync(s.original, s.backup);
      }
      job.phase = 'deleting';
      delete job.error;
      writeJsonAtomic(plan.journal, job);
    }
    // 整体恢复默认，不能深合并旧配置；不会保留供应商、密钥或扩展字段。
    io.mkdirSync(plan.data, { recursive: true });
    writeJsonAtomic(path.join(plan.data, 'config.json'), structuredClone(DEFAULT_CONFIG));
    for (const s of staged) io.rmSync(s.backup, { recursive: true, force: true });
    const result = { id: job.id, completedAt: Date.now() };
    writeJsonAtomic(path.join(plan.data, 'factory-reset-result.json'), result);
    io.unlinkSync(plan.journal);
    // 浏览器版此次重启保持原地址，配置文件仍是完整默认值。
    return { ...result, restartPort: job.restartPort };
  } catch (error) {
    if (job.phase === 'staging') {
      // 还没开始删除时，目录移动失败必须恢复原件，避免半初始化。
      for (const s of staged.reverse()) {
        if (io.existsSync(s.backup) && !io.existsSync(s.original)) io.renameSync(s.backup, s.original);
      }
    }
    job.error = job.phase === 'deleting' ? '初始化尚未全部完成，重启应用会继续清理' : `初始化未执行：${error.message}`;
    writeJsonAtomic(plan.journal, job);
    throw new Error(job.error, { cause: error });
  }
}
