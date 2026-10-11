import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { test, after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-reset-test-'));
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { resetPlan, armReset, resetStatus, runPendingReset, runPendingResetOnStartup, createResetChallenge } = await import('../src/factory-reset.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.snowluma.dir = path.join(root, 'snowluma');
cfg.snowluma.autoLaunch = false;
cfg.api.apiKey = 'fixture-secret';
setRuntimeConfig(cfg);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('测试禁止外部请求'); };
const { createApp } = await import('../src/app.js');
let restarts = 0;
const app = createApp({ log: () => {}, resetRoot: root, requestRestart: () => { restarts++; } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const port = app.server.address().port;
after(async () => { await app.stop(); globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });

function request(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers } }, res => {
      let raw = ''; res.on('data', b => raw += b); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
function fixture(name) {
  const base = path.join(root, name);
  const plan = resetPlan({ root: base, dataDir: path.join(base, 'data') });
  for (const target of plan.targets) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'private-record.json'), 'fixture-private');
  }
  fs.writeFileSync(path.join(plan.data, 'config.before-old.json'), 'fixture-api-backup');
  fs.writeFileSync(path.join(plan.data, 'config.json'), JSON.stringify({ api: { apiKey: 'fixture-key', model: 'old' }, customSetting: true }));
  fs.writeFileSync(path.join(plan.bridge, 'node.exe'), 'fixture-program');
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'asset.txt'), 'fixture-asset');
  return plan;
}

test('二次确认令牌限时且一次性，输入错误不能初始化', () => {
  let now = 0;
  const challenge = createResetChallenge({ now: () => now });
  const first = challenge.prepare();
  assert.throws(() => challenge.consume({ token: first.token, confirmation: '确认' }), /无效/);
  now = first.expiresAt + 1;
  assert.throws(() => challenge.consume({ token: first.token, confirmation: '初始化' }), /过期/);
  const second = challenge.prepare();
  assert.throws(() => challenge.consume({ token: first.token, confirmation: '初始化' }), /无效/);
  challenge.consume({ token: second.token, confirmation: '初始化' });
  assert.throws(() => challenge.consume({ token: second.token, confirmation: '初始化' }), /无效/);
});

test('没有初始化任务时普通启动不修改或限制已有数据目录', async () => {
  const dataDir = path.join(root, 'normal-start', 'custom-data-folder');
  assert.equal(await runPendingResetOnStartup({ root, dataDir }), null);
  assert.equal(fs.existsSync(dataDir), false);
});

test('删除目录拒绝根目录、项目根、嵌套边界、外部共享桥接和目录联接', () => {
  assert.throws(() => resetPlan({ root, dataDir: root }), /不安全/);
  assert.throws(() => resetPlan({ root, dataDir: path.parse(root).root }), /不安全/);
  assert.throws(() => resetPlan({ root, dataDir: path.join(root, 'data'), bridgeDir: path.join(root, 'data', 'snowluma') }), /不安全/);
  assert.throws(() => resetPlan({ root, dataDir: path.join(root, 'data'), configuredBridgeDir: path.join(root, 'other-bridge') }), /外部/);
  const base = path.join(root, 'junction');
  fs.mkdirSync(base, { recursive: true });
  fs.symlinkSync(root, path.join(base, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resetPlan({ root: base, dataDir: path.join(base, 'data') }), /联接/);
});

test('移动目录失败恢复全部原件，不执行部分删除', async () => {
  const plan = fixture('rollback');
  armReset(plan);
  const io = Object.create(fs);
  let moved = 0;
  io.renameSync = (...args) => { if (++moved === 2) throw new Error('模拟目录被占用'); return fs.renameSync(...args); };
  await assert.rejects(runPendingReset(plan, { waitParent: async () => {}, stopBridge: async () => {}, io }), /未执行/);
  for (const target of plan.targets) assert.equal(fs.readFileSync(path.join(target, 'private-record.json'), 'utf8'), 'fixture-private');
  assert.equal(JSON.parse(fs.readFileSync(path.join(plan.data, 'config.json'))).api.apiKey, 'fixture-key');
  assert.equal(resetStatus(plan).state, 'failed');
});

test('确认旧进程或桥接未退出时不清除任何数据', async () => {
  const plan = fixture('still-running');
  armReset(plan);
  await assert.rejects(runPendingReset(plan, { waitParent: async () => { throw new Error('旧进程仍运行'); }, stopBridge: async () => {} }), /未执行/);
  for (const target of plan.targets) assert.ok(fs.existsSync(path.join(target, 'private-record.json')));
  await assert.rejects(runPendingReset(plan, { waitParent: async () => {}, stopBridge: async () => { throw new Error('桥接退出失败'); } }), /未执行/);
  for (const target of plan.targets) assert.ok(fs.existsSync(path.join(target, 'private-record.json')));
});

test('删除阶段失败明确报告未完成，下一次启动继续清理，不保留旧配置', async () => {
  const plan = fixture('resume-delete');
  armReset(plan, { restartPort: 41230 });
  const io = Object.create(fs);
  let deleted = 0;
  io.rmSync = (...args) => { if (++deleted === 2) throw new Error('模拟文件占用'); return fs.rmSync(...args); };
  await assert.rejects(runPendingReset(plan, { waitParent: async () => {}, stopBridge: async () => {}, io }), /尚未全部完成/);
  assert.equal(resetStatus(plan).state, 'failed');
  const result = await runPendingReset(plan, { waitParent: async () => {}, stopBridge: async () => {} });
  assert.equal(result.restartPort, 41230);
  assert.equal(resetStatus(plan).state, 'complete');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plan.data, 'config.json'))), DEFAULT_CONFIG);
  for (const target of plan.targets) assert.equal(fs.existsSync(path.join(target, 'private-record.json')), false);
});

test('真实新进程完整清理所有个人数据和备份，默认配置不合并旧键，程序与素材保留', async () => {
  const plan = fixture('cold-start');
  const job = armReset(plan);
  // 新进程等当前测试进程不适用，这里注入空等待；实际删除、默认写入均在新 Node 中运行。
  const moduleUrl = new URL('../src/factory-reset.js', import.meta.url).href;
  const source = `import {resetPlan,runPendingReset} from ${JSON.stringify(moduleUrl)}; const plan=resetPlan(${JSON.stringify({root:path.dirname(plan.data),dataDir:plan.data})}); await runPendingReset(plan,{waitParent:async()=>{},stopBridge:async()=>{}});`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, QQ_AGENT_DATA_DIR: plan.data }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', b => errors += b); child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
  });
  const saved = JSON.parse(fs.readFileSync(path.join(plan.data, 'config.json')));
  assert.deepEqual(saved, DEFAULT_CONFIG);
  assert.equal(saved.customSetting, undefined);
  assert.equal(saved.api.apiKey, '');
  assert.equal(saved.providers.length, 0);
  assert.equal(saved.snowluma.autoLaunch, false);
  assert.equal(saved.server.autoStart, false);
  assert.equal(fs.existsSync(path.join(plan.data, 'config.before-old.json')), false);
  for (const target of plan.targets) assert.equal(fs.existsSync(path.join(target, 'private-record.json')), false);
  assert.equal(fs.readFileSync(path.join(plan.bridge, 'node.exe'), 'utf8'), 'fixture-program');
  assert.equal(fs.readFileSync(path.join(path.dirname(plan.data), 'ui', 'asset.txt'), 'utf8'), 'fixture-asset');
  assert.equal(fs.existsSync(plan.journal), false);
  for (const target of plan.targets) assert.equal(fs.existsSync(`${target}.factory-reset-${job.id}`), false);
  assert.equal(resetStatus(plan).state, 'complete');
});

test('Windows 包内 Node 入口初始化可关闭旧桥接但不会关闭清理进程自己', { skip: process.platform !== 'win32' }, async () => {
  const plan = fixture('bundled-node');
  const exe = path.join(plan.bridge, 'node.exe');
  fs.copyFileSync(process.execPath, exe);
  const bridge = spawn(exe, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const bridgeExit = new Promise(resolve => bridge.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { bridge.once('spawn', resolve); bridge.once('error', reject); });
    armReset(plan);
    const moduleUrl = new URL('../src/factory-reset.js', import.meta.url).href;
    const source = `import {resetPlan,runPendingReset} from ${JSON.stringify(moduleUrl)}; await runPendingReset(resetPlan(${JSON.stringify({root:path.dirname(plan.data),dataDir:plan.data})}),{waitParent:async()=>{}});`;
    await new Promise((resolve, reject) => {
      const child = spawn(exe, ['--input-type=module', '-e', source], { env: { ...process.env, QQ_AGENT_DATA_DIR: plan.data }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', b => errors += b); child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`退出码 ${code}: ${errors}`)));
    });
    await bridgeExit;
    assert.equal(resetStatus(plan).state, 'complete');
    assert.equal(fs.existsSync(exe), true);
  } finally { if (bridge.exitCode === null) bridge.kill(); }
});

test('HTTP 取消准备不删数据，直接调用/跨站/忙碌被拒，最终确认只安排一次冷重启并封锁旧缓存', async () => {
  assert.equal((await request('/api/factory-reset/confirm', { token: 'fake', confirmation: '初始化' })).status, 400);
  assert.equal((await request('/api/factory-reset/prepare', {}, { origin: 'https://example.com' })).status, 403);
  const first = await request('/api/factory-reset/prepare', {});
  assert.equal(first.status, 200);
  const plan = resetPlan({ root, dataDir: process.env.QQ_AGENT_DATA_DIR });
  assert.equal(fs.existsSync(plan.journal), false); // 在第二步取消，仅准备不能删/安排重启
  assert.equal(restarts, 0);
  app.orchestrator.runningChats.add('group:123');
  assert.equal((await request('/api/factory-reset/confirm', { token: first.data.token, confirmation: '初始化' })).status, 409);
  app.orchestrator.runningChats.clear();
  const second = await request('/api/factory-reset/prepare', {});
  const result = await request('/api/factory-reset/confirm', { token: second.data.token, confirmation: '初始化' });
  assert.equal(result.status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarts, 1);
  assert.ok(fs.existsSync(plan.journal));
  assert.equal((await request('/api/factory-reset/confirm', { token: second.data.token, confirmation: '初始化' })).status, 503);
  assert.equal((await request('/api/config', { api: { apiKey: 'should-not-be-written' } })).status, 503);
  assert.equal((await request('/api/factory-reset/status')).data.state, 'restarting');
  assert.equal(restarts, 1);
});
