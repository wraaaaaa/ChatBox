// 冷重启 UI 隔离验收：只读写工具生成的临时目录，绝不使用真实 data/ 或桥接。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-reset-preview-'));
if (!path.basename(root).startsWith('qq-agent-reset-preview-') || path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('仅允许本预览创建的临时目录');
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');
globalThis.fetch = async () => { throw new Error('隔离预览禁止外部请求'); };
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig } = await import('../src/config.js');
const { resetPlan, runPendingReset } = await import('../src/factory-reset.js');
const plan = resetPlan({ root, dataDir: process.env.QQ_AGENT_DATA_DIR });
await runPendingReset(plan, { stopBridge: async () => {} });
if (!process.argv[2]) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.apiKey = 'fixture-key';
  cfg.ui.theme = 'dark';
  cfg.persona.customRules = 'fixture-rule';
  cfg.webSearch.providers = [{ id: 'fixture', name: '旧搜索服务', baseUrl: 'https://example.com/search', apiKey: 'fixture-search-key' }];
  cfg.imageSearch.providers = [{ id: 'fixture', name: '旧图源', baseUrl: 'https://example.com/images', apiKey: 'fixture-image-key' }];
  cfg.snowluma.dir = path.join(root, 'snowluma');
  cfg.snowluma.autoLaunch = false;
  cfg.proactive.enabled = false;
  cfg.reminder.enabled = false;
  setRuntimeConfig(cfg);
  updateConfig({});
  for (const n of ['config', 'data', 'logs']) {
    fs.mkdirSync(path.join(plan.bridge, n), { recursive: true });
    fs.writeFileSync(path.join(plan.bridge, n, 'fixture-private.json'), 'fixture-private');
  }
  fs.writeFileSync(path.join(plan.data, 'config.old.json'), 'fixture-secret-backup');
} else {
  const cfg = getConfig();
  // 只覆盖运行时桥接地址做隔离，不持久化，不会影响默认配置回读验收。
  cfg.snowluma = { ...cfg.snowluma, dir: path.join(root, 'snowluma'), wsUrl: 'ws://127.0.0.1:65532', httpUrl: 'http://127.0.0.1:65533', autoLaunch: false };
  setRuntimeConfig(cfg);
}
const { createApp } = await import('../src/app.js');
const app = createApp({ log: () => {}, resetRoot: root, requestRestart: async () => {
  const port = app.server.address().port;
  await app.stop();
  const out = fs.openSync(path.join(root, 'preview.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root, String(port)], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  process.exit(0);
} });
await new Promise(resolve => app.server.listen(Number(process.argv[3] || 0), '127.0.0.1', resolve));
console.log(JSON.stringify({ url: `http://127.0.0.1:${app.server.address().port}`, root, pid: process.pid }));
process.once('SIGINT', async () => { await app.stop(); process.exit(0); });
