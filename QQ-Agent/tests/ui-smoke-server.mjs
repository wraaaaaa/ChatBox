// 隔离 UI 预览：只监听本地 HTTP，不调用 app.start()，因此不连接 QQ 或模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ui-smoke-'));
process.once('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));
process.env.QQ_AGENT_DATA_DIR = path.join(tempDir, 'data');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const config = structuredClone(DEFAULT_CONFIG);
config.snowluma = {
  ...config.snowluma,
  dir: path.join(tempDir, 'bridge'),
  wsUrl: 'ws://127.0.0.1:65532',
  httpUrl: 'http://127.0.0.1:65533',
  autoLaunch: false
};
config.proactive.enabled = false;
config.reminder.enabled = false;
setRuntimeConfig(config);

const { createApp } = await import('../src/app.js');
const app = createApp({ log: () => {} });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
console.log(`UI_SMOKE_URL=http://127.0.0.1:${app.server.address().port}`);

async function stop() {
  await app.stop();
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
