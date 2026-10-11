// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR } from './config.js';
import { runPendingResetOnStartup } from './factory-reset.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
process.on('uncaughtException', (error) => console.error('[未捕获异常]', error));

const reset = await runPendingResetOnStartup({ dataDir: DATA_DIR, root: ROOT });
const { createApp } = await import('./app.js');
const app = createApp({ requestRestart: async () => {
  await app.stop();
  const child = spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: process.env, detached: true, windowsHide: true, stdio: 'ignore' });
  // 必须等到 spawn 确认成功，否则不能把“已安排重启”当成执行成功。
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  process.exit(0);
} });
app.start({ portOverride: reset?.restartPort }).catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});
