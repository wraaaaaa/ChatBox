// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复
app.disableHardwareAcceleration();

// ── 数据目录：始终固定在「应用根目录/data」──
// 约定：所有数据都存在安装目录下，不往 %APPDATA% 塞。
//   压缩包用户：data 本来就在压缩包目录里，直接用（项目内 data/）；
//   安装版用户：安装目录/exe 旁边的 data/。选压缩包目录当安装目录时
//   接管里面的 data/（配置、记忆和聊天记录保留），无需另行迁移。
// NSIS 覆盖安装只替换它自己装的文件，运行时生成的 data/ 不在清单里 → 升级不丢数据。
// 兼容兜底：外置 %APPDATA% 时期（2026-09-06 短命版本）的数据自动搬回安装目录。
function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;
  // 开发模式（.bat 直起 node_modules 里的 electron.exe + 项目目录）：项目内 data/
  if (!app.isPackaged) return path.resolve(fileURLToPath(import.meta.url), '..', '..', 'data');
  const portable = path.join(path.dirname(app.getPath('exe')), 'data');
  try {
    if (!fs.existsSync(portable)) {
      // 接管旧版遗留：%APPDATA%/qq-agent/data（外置期版本）→ 搬回安装目录
      const legacy = path.join(app.getPath('userData'), 'data');
      if (fs.existsSync(legacy) && fs.readdirSync(legacy).length > 0) {
        fs.cpSync(legacy, portable, { recursive: true });
        console.log('[data] 已从 %APPDATA% 迁回安装目录:', legacy, '→', portable);
      }
    }
  } catch (error) {
    console.error('[data] 旧数据迁移失败（不影响启动，将从空数据开始）:', error?.message ?? error);
  }
  return portable;
}
process.env.QQ_AGENT_DATA_DIR = resolveDataDir();

// 单实例锁：重复启动（双击图标/.bat）不产生第二个实例，而是唤出已有窗口。
// 没有锁的话第二个实例会双份连 SnowLuma，群消息会被双重回复。
//
// ⚠️ 但**只调 app.quit() 是不够的**：quit 是异步的，下面 whenReady 的回调仍可能先跑起来，
//    于是第二个实例照样 core.start()（占一个新端口）+ 自动拉起一个 SnowLuma。
//    两个 SnowLuma 抢同一个 messages.db → 后起的那个拿到 SQLITE_READONLY →
//    事件管道对每条消息抛错 → **机器人静默失聪**（2026-09-12 实测：用户连点几次图标，
//    6 分钟内起了 17 个 SnowLuma，readonly 报错刷屏，怎么清理都修不好）。
//    所以这里既 quit，又在 whenReady 里早退，保证第二实例一个字节的初始化都不做。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[electron] 已经有一个 QQ Agent 在运行，本次启动直接退出（不启动服务、不拉起 SnowLuma）');
  app.quit();
  app.exit(0);
} else {
  app.on('second-instance', () => showWindow());
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.resolve(__dirname, '..', 'assets', 'icon.png');

let mainWindow = null;
let core = null;
let tray = null;
let quitting = false;

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  app.setLoginItemSettings({ openAtLogin: !!cfg.server?.autoStart });
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('QQ Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    { label: '暂停 / 恢复', click: () => core?.orchestrator.setPaused(!core.orchestrator.paused) },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!core.getConfig().server?.autoStart,
      click: (item) => {
        core.updateConfig({ server: { autoStart: item.checked } });
        applyAutoStart();
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ]));
  tray.on('double-click', () => showWindow());
}

/** 真正退出：置位 quitting，让 close 处理器不再拦窗。 */
function quitApp() {
  quitting = true;
  app.quit();
}

// 托盘气泡只弹一次/进程（每次缩托盘都弹会变成噪音）
let trayBalloonShown = false;

/**
 * 缩到托盘。第一次会弹一个原生气泡说明"程序还活着、怎么找回来"。
 *
 * 为什么要弹：窗口是原生标题栏，点 X 后窗口直接消失，而 Win11 的托盘图标默认
 * 折进溢出区。用户找不到图标、又看不到任何反馈，就会认为"点了 X 关不掉/点了没反应"。
 */
function hideToTray() {
  if (!mainWindow) return;
  mainWindow.hide();
  if (trayBalloonShown) return;
  trayBalloonShown = true;
  try {
    tray?.displayBalloon?.({
      title: 'QQ Agent 仍在后台运行',
      content: '机器人继续在线接消息。双击托盘图标可重新打开窗口；右键托盘图标 →「退出」可以彻底关掉。'
    });
  } catch { /* 托盘不支持气泡时忽略 */ }
}

// 关闭确认框是否已经弹出（防止连点 X 叠出多个框）
let closePromptOpen = false;

/**
 * 问一次"点 X 到底要干什么"。
 *
 * 背景：窗口没有自定义标题栏，"点关闭"的语义完全靠用户猜。旧实现只有
 * closeToTray 一个开关、默认缩托盘且**无任何反馈** → "点了 X 关不掉"成了
 * 最高频的反馈。现在改成：默认（server.closeAsk !== false）弹一次选择，
 * 勾了"记住"就把结果写回 config（closeToTray + closeAsk=false），以后不再打扰。
 */
function askCloseBehavior(toTrayDefault, onDone) {
  dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['最小化到托盘（机器人继续在线）', '彻底退出程序', '取消'],
    defaultId: toTrayDefault ? 0 : 1,
    cancelId: 2,
    noLink: true,
    title: 'QQ Agent',
    message: '关闭窗口时要怎么做？',
    detail: '最小化到托盘：机器人仍在后台运行，继续接收和回复群消息；想重新打开就双击托盘图标（或桌面上的 QQ Agent 图标）。\n彻底退出：关掉程序，机器人下线。',
    checkboxLabel: '记住我的选择，以后不再询问',
    checkboxChecked: false
  }).then(({ response, checkboxChecked }) => onDone(response, checkboxChecked))
    // ⚠️ 弹窗本身失败时不能"什么都不做"：那样窗口被 preventDefault 拦下又没执行任何
    //    动作，用户就会遇到**点 X 毫无反应**——正是这次要修掉的毛病。所以失败时
    //    退回旧行为（按 closeToTray 决定缩托盘还是退出），保证 X 永远有反馈。
    .catch((error) => {
      console.error('[window] 关闭确认框弹出失败，退回默认关闭行为:', error?.message ?? error);
      onDone(toTrayDefault ? 0 : 1, false);
    });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'QQ Agent',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  // 窗口打开先显示 loading 壳，等页面真正加载完成再亮相，避免白屏和用户反复双击
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[window] 页面加载失败:', code, desc, url);
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), 2000);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程崩溃:', JSON.stringify(details));
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => console.error('[window] loadURL 失败:', error));
  // 外部链接交给系统默认浏览器，不在应用内弹新窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // ── 关窗行为 ──
  //
  // 默认缩到托盘（符合"常驻机器人"的使用习惯），但**必须让用户能选择**：
  // 旧实现无条件 hide()，用户点 X 后看不出任何变化（窗口消失、图标藏在
  // Win11 溢出区），于是"点了 X 关不掉/点了没用"成了最常见反馈。
  //
  // 三条路径：
  //   ① server.closeAsk === false（用户勾过"记住"）→ 直接按 closeToTray 执行，不打扰；
  //   ② 否则 → 弹一次三选一（托盘 / 退出 / 取消），勾了"记住"就把结果写回配置；
  //   ③ quitting（走托盘"退出"或 before-quit）→ 不拦截，正常关。
  mainWindow.on('close', (event) => {
    if (quitting) return;
    const server = core?.getConfig?.()?.server || {};
    const toTray = server.closeToTray !== false;

    // ① 已记住：不再询问
    if (server.closeAsk === false) {
      if (toTray) {
        event.preventDefault();
        hideToTray();
      }
      return;
    }

    // ② 拦下窗口，弹一次选择
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    askCloseBehavior(toTray, (response, remember) => {
      closePromptOpen = false;
      if (!mainWindow) return;
      if (response === 2) return;                 // 取消
      const pickTray = response === 0;
      if (remember) {
        try {
          core?.updateConfig?.({ server: { closeToTray: pickTray, closeAsk: false } });
        } catch (error) {
          console.error('[window] 保存关闭偏好失败:', error?.message ?? error);
        }
      }
      if (pickTray) hideToTray();
      else quitApp();
    });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  // 第二实例早退（见文件顶部的说明）：绝不能走到 core.start()——那会占端口并再拉一个 SnowLuma
  if (!gotLock) return;
  try {
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { runPendingResetOnStartup } = await import('../src/factory-reset.js');
    const { ROOT } = await import('../src/config.js');
    const bundled = path.join(ROOT, 'snowluma');
    const bridgeDir = fs.existsSync(bundled) ? bundled : bundled.replace('app.asar', 'app.asar.unpacked');
    const reset = await runPendingResetOnStartup({ dataDir: process.env.QQ_AGENT_DATA_DIR, root: ROOT, bridgeDir });
    if (reset) {
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
      app.setLoginItemSettings({ openAtLogin: false });
    }
    const { createApp } = await import('../src/app.js');
    core = createApp({ log: (...args) => console.log(...args), requestRestart: async () => {
      quitting = true;
      await core.stop();
      app.relaunch();
      app.exit(0); // 旧进程先退出，新进程才会删除数据，避免缓存写回
    } });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    await createWindow(port);
    applyAutoStart();
    createTray();
  } catch (error) {
    console.error('[electron] 启动失败:', error);
    dialog.showErrorBox('QQ Agent 启动未完成', String(error?.message || error));
    app.quit();
  }
});

app.on('before-quit', () => {
  if (!gotLock) return;   // 第二实例没启动过任何东西，不需要收尾
  quitting = true;
  try { core?.stop(); } catch { /* ignore */ }
});
