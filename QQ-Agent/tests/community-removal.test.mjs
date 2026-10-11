// 隔离回归：node --test tests/community-removal.test.mjs
// 不启动真实 OneBot/模型，不读取项目 data/，禁止测试中的外部 fetch。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-regression-'));
process.env.QQ_AGENT_DATA_DIR = path.join(tmp, 'data');
// 即使旧环境强制开启遥测，也不能产生请求。
process.env.QQ_AGENT_TELEMETRY = '1';
const externalRequests = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  externalRequests.push(String(url));
  throw new Error('测试禁止外部请求');
};
const { DEFAULT_CONFIG, setRuntimeConfig, getConfig } = await import('../src/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.snowluma = { ...cfg.snowluma, dir: path.join(tmp, 'bridge'), autoLaunch: false };
cfg.api = { ...cfg.api, apiKey: 'fixture-key' };
cfg.proactive.enabled = false;
cfg.reminder.enabled = false;
cfg.telemetry = { enabled: true }; // 旧配置字段也不应重新启用上报
setRuntimeConfig(cfg);
const { createApp } = await import('../src/app.js');
const app = createApp({ log: () => {} });
// 只启动 HTTP 监听，不调用会连接 QQ 和启动后台任务的 app.start()。
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const port = app.server.address().port;
after(async () => {
  await app.stop();
  globalThis.fetch = oldFetch;
  // 仅清理本测试创建的临时目录。
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(url, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method,
      headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data; try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('旧暗色首屏只迁移一次，之后保留用户手动选择', () => {
  assert.equal(DEFAULT_CONFIG.ui.theme, 'light');
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline);
  const values = new Map([['qqa-theme', 'dark']]);
  let applied = '';
  const context = { localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }, window: { matchMedia: () => ({ matches: false }) },
  document: { documentElement: { setAttribute: (_name, value) => { applied = value; } } } };
  vm.runInNewContext(inline, context);
  assert.equal(applied, 'light');
  assert.equal(values.get('qqa-theme'), 'light');
  values.set('qqa-theme', 'dark');
  vm.runInNewContext(inline, context);
  assert.equal(applied, 'dark');
});

test('已删除的路由和静态资源不再可用，本地版本与控制台正常', async () => {
  for (const [url, method] of [['/api/update-check', 'GET'], ['/api/media-data', 'POST'],
    ['/landing.html', 'GET'], ['/group-qrcode.jpg', 'GET'],
    ['/api/model-prices', 'GET'], ['/api/model-prices/refresh', 'POST']]) {
    assert.equal((await request(url, method, method === 'POST' ? { items: [] } : undefined)).status, 404, url);
  }
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.data, /id="tabs"/);
  assert.doesNotMatch(page.data, /quote-btn|feedback-btn|open-site-btn/);
  const version = (await request('/api/version')).data;
  assert.equal(version.version, '0.5.0-alpha');
  assert.equal(version.displayVersion, 'v0.5alpha');
  assert.equal(version.originalAuthor, 'Kondius');
  assert.equal(version.maintainer, 'wraaaaaa');
  assert.equal((await request('/refresh.css')).status, 200);
  assert.doesNotMatch(page.data, /data-tab="snowluma"|view-snowluma/);
});

test('配置保存保留已有密钥、名单和本地设置', async () => {
  assert.equal((await request('/api/config', 'POST', { ui: { refreshMs: 4000 } })).status, 200);
  assert.equal(getConfig().api.apiKey, 'fixture-key');
  assert.deepEqual(getConfig().allow, cfg.allow);
  const result = await request('/api/config');
  assert.equal(result.data.ui.refreshMs, 4000);
  assert.equal(result.data.api.apiKey, undefined);
  assert.equal(result.data.api.hasApiKey, true);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data/config.json'), 'utf8'));
  assert.equal(saved.api.apiKey, 'fixture-key');
});

test('记忆列表不生成白名单空占位，删除后不回填，保留整理中的记录', async () => {
  const previous = structuredClone(getConfig());
  const group = 'group:1019727210';
  const privateChat = 'private:889900';
  try {
    setRuntimeConfig({ ...previous, allow: { ...previous.allow, groups: ['1019727210'], private: ['889900'] } });
    let list = (await request('/api/memory-files')).data.files;
    assert.equal(list.some((f) => f.chatKey === group || f.chatKey === privateChat), false);
    app.memory.append(group, 'memberImpression', '隔离列表测试', { userId: '7712345', target: '测试' });
    assert.equal((await request('/api/memory-files')).data.files.find((f) => f.chatKey === group).impressionCount, 1);
    assert.equal((await request('/api/data/delete', 'POST', { area: 'memory', ids: [group] })).data.removed, 1);
    assert.equal((await request('/api/memory-files')).data.files.some((f) => f.chatKey === group), false);
    app.memory.clear(group); // 仅剩元数据的空目录同样不显示。
    assert.equal((await request('/api/memory-files')).data.files.some((f) => f.chatKey === group), false);
    app.orchestrator.consolidating.add(group);
    assert.equal((await request('/api/memory-files')).data.files.find((f) => f.chatKey === group).consolidating, true);
  } finally {
    app.orchestrator.consolidating.delete(group);
    app.memory.removeChat(group);
    setRuntimeConfig(previous);
  }
});

test('视频资源支持 HEAD、字节范围、末尾片段及非法范围，保留目录边界', async () => {
  const asset = fs.readFileSync(path.join(root, 'ui/assets/background-loop.mp4'));
  const mediaRequest = (range, method = 'GET', url = '/assets/background-loop.mp4') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method,
      headers: range ? { range } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const head = await mediaRequest(null, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], 'video/mp4');
  assert.equal(Number(head.headers['content-length']), asset.length);
  assert.equal(head.body.length, 0);
  for (const [range, start, end] of [
    ['bytes=0-31', 0, 31], ['bytes=-32', asset.length - 32, asset.length - 1],
    [`bytes=${asset.length - 32}-`, asset.length - 32, asset.length - 1],
    [`bytes=${asset.length - 16}-${asset.length + 100}`, asset.length - 16, asset.length - 1]
  ]) {
    const response = await mediaRequest(range);
    assert.equal(response.status, 206, range);
    assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${asset.length}`);
    assert.deepEqual(response.body, asset.subarray(start, end + 1));
  }
  for (const range of ['bytes=9-1', 'bytes=-0', 'bytes=-', `bytes=${asset.length}-`, 'bytes=0-1,3-4']) {
    const response = await mediaRequest(range);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers['content-range'], `bytes */${asset.length}`);
  }
  assert.equal((await mediaRequest(null, 'GET', '/assets/%2e%2e%5cpackage.json')).status, 403);
  assert.equal((await mediaRequest(null, 'GET', '/assets/missing.mp4')).status, 404);
});

test('背景暂停偏好、窗口隐藏、减少动态效果和播放失败不影响界面', async () => {
  const source = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  const init = source.slice(source.indexOf('function initVideoBackground()'), source.indexOf('initVideoBackground();') + 'initVideoBackground();'.length);
  function fixture({ stored = null, reduced = false } = {}) {
    const handlers = {};
    const motionHandlers = {};
    const values = new Map(stored === null ? [] : [['qqa-background-paused', stored]]);
    const video = { muted: false, paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
      addEventListener: (event, fn) => { handlers[`video:${event}`] = fn; } };
    const button = { textContent: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener: (event, fn) => { handlers[`button:${event}`] = fn; } };
    const motion = { matches: reduced, addEventListener: (event, fn) => { motionHandlers[event] = fn; } };
    const notices = [];
    const document = { hidden: false, addEventListener: (event, fn) => { handlers[event] = fn; } };
    vm.runInNewContext(init, { $: (sel) => sel === '#background-video' ? video : button,
      window: { matchMedia: () => motion }, document, showNotice: (...args) => notices.push(args),
      localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
    return { video, button, document, handlers, motion, motionHandlers, notices, values };
  }
  const f = fixture();
  assert.equal(f.video.muted, true);
  assert.equal(f.video.paused, false);
  f.handlers['button:click']();
  assert.equal(f.video.paused, true);
  assert.equal(f.values.get('qqa-background-paused'), '1');
  assert.equal(f.button.textContent, '播放背景');
  assert.equal(fixture({ stored: '1' }).video.paused, true);
  f.handlers['button:click']();
  f.document.hidden = true;
  f.handlers.visibilitychange();
  assert.equal(f.video.paused, true);
  f.document.hidden = false;
  f.handlers.visibilitychange();
  assert.equal(f.video.paused, false);
  const reduce = fixture({ reduced: true });
  assert.equal(reduce.video.paused, true);
  reduce.motion.matches = false;
  reduce.motionHandlers.change();
  assert.equal(reduce.video.paused, false);
  const rejected = fixture();
  rejected.video.play = () => Promise.reject(new Error('autoplay blocked'));
  rejected.handlers.visibilitychange();
  await Promise.resolve();
  assert.equal(rejected.button.textContent, '播放背景');
  f.handlers['video:error']();
  assert.equal(f.button.disabled, true);
  assert.match(f.notices[0][0], /静态背景/);
});

test('聊天去重、发送留档和本地用量统计保持工作', async () => {
  const key = 'group:123456789';
  const incoming = { mid: -42, senderId: '12345', senderName: '测试成员', text: '测试消息', ts: Date.now() };
  assert.ok(app.store.appendIncoming(key, incoming));
  assert.equal(app.store.appendIncoming(key, incoming), null);
  const sends = [];
  app.onebot.sendText = async (...args) => { sends.push(args); return { message_id: 99 }; };
  const result = await app.sender.sendTextBatch(key, ['测试回复']);
  assert.equal(result.sent.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(app.store.recent(key).at(-1).self, true);
  const s = app.sessions.create({ chatKey: key, trigger: [], triggerSummary: '隔离测试' });
  s.model = 'fixture-model';
  s.usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 10, calls: 1 };
  app.sessions.finish(s.id, 'done');
  const usage = await request('/api/usage/stats?range=7');
  assert.equal(usage.status, 200);
  assert.equal(usage.data.totals.promptTokens, 100);
  assert.equal(usage.data.totals.completionTokens, 20);
  assert.equal(usage.data.totals.totalTokens, 120);
  assert.equal(Object.hasOwn(usage.data.totals, 'cost'), false);
  const breakdown = await request(`/api/usage/breakdown?range=7&dim=chat&key=${encodeURIComponent(key)}&by=model`);
  assert.equal(breakdown.status, 200);
  assert.equal(breakdown.data.totals.totalTokens, 120);
  assert.equal(breakdown.data.rows.length, 1);
  assert.equal(Object.hasOwn(breakdown.data.rows[0], 'cost'), false);
  assert.ok(fs.existsSync(path.join(tmp, 'data/usage-today.json')));
  assert.equal(fs.existsSync(path.join(tmp, 'data/telemetry-totals.json')), false);
  const chats = await request('/api/chats/group_123456789/messages');
  assert.equal(chats.status, 200);
  assert.match(JSON.stringify(chats.data), /测试回复/);
});

test('本地反馈和全部模型工具保留', async () => {
  const { buildToolDefs, executeTool } = await import('../src/tools.js');
  const defs = buildToolDefs();
  assert.equal(defs.length, 36);
  const events = [];
  const session = { feedbacks: [] };
  const result = await executeTool(defs, { session, emit: (...args) => events.push(args) },
    'report_feedback', JSON.stringify({ message: '需要本地管理员处理' }));
  assert.equal(result.isError, undefined);
  assert.equal(session.feedbacks.length, 1);
  assert.equal(events[0][0], 'feedback');
});

test('13 个设置分栏、SnowLuma 与人设高级菜单正常渲染，保存反馈覆盖成功和失败', async () => {
  const nodes = new Map();
  const makeNode = () => ({ innerHTML: '', textContent: '', value: '', dataset: {}, style: {},
    listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; }, setAttribute() {}, pause() {}, play: async () => {},
    querySelectorAll: () => [], querySelector: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
  const document = { addEventListener() {}, querySelectorAll: () => [],
    querySelector(sel) { if (!nodes.has(sel)) nodes.set(sel, makeNode()); return nodes.get(sel); },
    documentElement: makeNode(), body: makeNode() };
  const context = vm.createContext({ document, console, structuredClone, URL,
    localStorage: { getItem: () => null, setItem() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, fixtureConfig: structuredClone(DEFAULT_CONFIG) });
  const source = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  // 不执行启动轮询；其他顶层声明和事件绑定均执行。
  const init = source.indexOf('(async function init()');
  assert.ok(init > 0);
  vm.runInContext(source.slice(0, init), context);
  vm.runInContext('state.config = fixtureConfig; state.memes = { memes: [], stats: {} };', context);
  for (const section of ['api', 'search', 'image', 'memory', 'reminder', 'style', 'meme', 'persona', 'allow', 'chat', 'desktop', 'onebot', 'about']) {
    const html = vm.runInContext(`state.settingsSection = ${JSON.stringify(section)}; renderSettingsSection(state.config)`, context);
    if (section === 'about') {
      assert.doesNotMatch(html, /save-cfg-btn/);
      assert.match(html, /factory-reset-btn/);
      assert.match(html, /v0.5alpha/);
      assert.match(html, /Kondius.*wraaaaaa/);
    } else assert.match(html, /save-cfg-btn/, section);
    assert.doesNotMatch(html, /check-update-btn|qrcode-egg|1098345913/, section);
    if (['memory', 'reminder', 'style'].includes(section)) {
      assert.match(html, /memory-record-open/, section);
      assert.match(html, /memory-record-reset/, section);
      assert.match(html, /清空已保存内容/, section);
      assert.match(html, /在此查看已保存内容/, section);
    }
  }
  vm.runInContext('renderSettingsSidebar()', context);
  assert.equal((nodes.get('#settings-sidebar').innerHTML.match(/data-section=/g) || []).length, 14);
  assert.match(nodes.get('#settings-sidebar').innerHTML, /settings-submenu/);
  assert.match(nodes.get('#settings-sidebar').innerHTML, /说话风格库/);
  assert.match(nodes.get('#settings-sidebar').innerHTML, /SnowLuma · OneBot/);
  vm.runInContext("state.globalMemory = { stats: { people: 1, facts: 1, events: 0 }, people: [{ name: '测试', facts: [{ content: '<img src=x onerror=alert(1)>' }] }], events: [] }", context);
  const memoryPreview = vm.runInContext("renderMemoryRecordActions('__global__', '跨群档案与长期记忆')", context);
  assert.match(memoryPreview, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(memoryPreview, /<img src=x/);
  const gateway = vm.runInContext("state.settingsSection = 'onebot'; renderSettingsSection(state.config)", context);
  assert.match(gateway, /id="snowluma-page"/);
  const persona = vm.runInContext("state.settingsSection = 'persona'; renderSettingsSection(state.config)", context);
  assert.match(persona, /advanced-submenu/);
  assert.match(persona, /cfg-roletext/);
  assert.doesNotMatch(persona, /成本核算/);
  vm.runInContext("state.sessions = [{id:'run-1', chatKey:'group:123', status:'done', startedAt:1}]; renderSessionList()", context);
  assert.match(nodes.get('#session-items').innerHTML, /record-check[\s\S]*record-delete/);
  vm.runInContext("state.chats = [{key:'group:123', total:1, lastTs:1}]; renderChatList()", context);
  assert.match(nodes.get('#chat-items').innerHTML, /record-check[\s\S]*record-delete/);
  vm.runInContext("state.memoryFiles = [{chatKey:'group:123', memberCount:1, impressionCount:1}]; renderMemoryList()", context);
  assert.match(nodes.get('#memory-items').innerHTML, /record-check[\s\S]*record-delete/);
  assert.doesNotMatch(nodes.get('#memory-items').innerHTML, /__global__|__reminders__|__style__|跨群档案记录|提醒记录|风格记录/);
  // 完整管理在设置本页加载，不切换顶层页签，也不覆盖聊天印象面板。
  const memoryBefore = document.querySelector('#memory-detail').innerHTML;
  for (const [section, heading] of [['memory', '跨群档案'], ['reminder', '定时提醒'], ['style', '说话风格库']]) {
    context.fetch = async (url) => ({ ok: true, json: async () => String(url).includes('surface') ? { items: [] } : { stats: {}, people: [], events: [], items: [], samples: [] } });
    await vm.runInContext(`state.tab = 'settings'; state.settingsSection = ${JSON.stringify(section)}; loadSettingsMemoryDetail()`, context);
    assert.match(nodes.get('#settings-memory-records').innerHTML, new RegExp(heading));
    assert.equal(nodes.get('#memory-detail').innerHTML, memoryBefore);
    assert.equal(vm.runInContext('state.tab', context), 'settings');
  }
  // 顶层一键清空只提交聊天键，跨群档案/提醒/风格的特殊键不进入删除范围。
  context.recordBar = { dataset: { area: 'memory' }, addEventListener(_event, fn) { this.handler = fn; } };
  context.deleteCalls = [];
  const queryAllBefore = document.querySelectorAll;
  document.querySelectorAll = (sel) => sel === '.record-actions' ? [context.recordBar] : [];
  vm.runInContext("deleteUserRecords = (area, options) => deleteCalls.push({area, options}); bindRecordActions();", context);
  context.recordBar.handler({ target: { closest: () => ({ dataset: { action: 'delete-all' } }) } });
  assert.equal(context.deleteCalls[0].area, 'memory');
  assert.deepEqual(Array.from(context.deleteCalls[0].options.ids), ['group:123']);
  assert.equal(context.deleteCalls[0].options.all, undefined);
  document.querySelectorAll = queryAllBefore;
  context.fetch = async (url) => ({ ok: true, json: async () => String(url).includes('memory-files')
    ? { files: [{ chatKey: 'group:123', memberCount: 0, impressionCount: 0, consolidating: false }] }
    : String(url).includes('/api/chats') ? { chats: [] } : structuredClone(DEFAULT_CONFIG) });
  await vm.runInContext("state.currentMemoryChatKey = 'group:123'; loadMemoryView()", context);
  assert.equal(vm.runInContext('state.currentMemoryChatKey', context), null);
  assert.doesNotMatch(nodes.get('#memory-items').innerHTML, /data-key=/);
  assert.match(nodes.get('#memory-detail').innerHTML, /暂无聊天群友印象/);
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await vm.runInContext("api('/api/config', { method: 'POST', body: '{}' })", context);
  assert.match(nodes.get('#action-notice').textContent, /已生效/);
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { ok: false, note: '目标服务不可达' } }) });
  await vm.runInContext("api('/api/providers/test-chat', { method: 'POST', body: '{}' })", context);
  assert.match(nodes.get('#action-notice').textContent, /未生效：目标服务不可达/);
  context.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(vm.runInContext("api('/api/config', { method: 'POST', body: '{}' })", context), /offline/);
  assert.match(nodes.get('#action-notice').textContent, /失败：offline/);
  for (const read of [false, true]) {
    const row = vm.runInContext(`chatMsgRowHtml({id: 1, ts: 1, read: ${read}, senderName: '<人>', text: '<内容>', skip: {tier: 2, reason: '<原因>'}})`, context);
    assert.equal((row.match(/<td\b/g) || []).length, 5);
    assert.match(row, /&lt;内容&gt;/);
    assert.doesNotMatch(row, /quote-check|quote-selected/);
  }
});

test('会话、存档和当前人设记忆可单项、多选及全部清空，运行中数据受保护', async () => {
  const post = (body) => request('/api/data/delete', 'POST', body);
  const key = 'group:812345';
  const first = app.sessions.create({ chatKey: key, trigger: [], triggerSummary: '待完成' });
  assert.equal((await post({ area: 'sessions', all: true })).status, 409);
  app.sessions.finish(first.id, 'done');
  const second = app.sessions.create({ chatKey: key, trigger: [], triggerSummary: '第二项' });
  app.sessions.finish(second.id, 'done');
  assert.equal((await post({ area: 'sessions', ids: [first.id] })).data.removed, 1);
  assert.equal(app.sessions.get(first.id), null);
  const third = app.sessions.create({ chatKey: key, trigger: [], triggerSummary: '第三项' });
  app.sessions.finish(third.id, 'done');
  assert.equal((await post({ area: 'sessions', ids: [second.id, third.id] })).data.removed, 2);
  assert.equal((await post({ area: 'sessions', all: true })).status, 200);
  assert.equal(app.sessions.allRecordIds().length, 0);

  const a = app.store.appendIncoming(key, { mid: 3001, senderId: '77', senderName: '测试', text: '第一条' });
  const b = app.store.appendIncoming(key, { mid: 3002, senderId: '77', senderName: '测试', text: '第二条' });
  assert.equal((await post({ area: 'chats', chatKey: key, messageIds: [a.id] })).data.removed, 1);
  assert.equal(app.store.findByLocalId(key, a.id), null);
  assert.ok(app.store.findByLocalId(key, b.id));
  assert.equal((await post({ area: 'chats', chatKey: key, messageIds: [b.id] })).data.removed, 1);
  app.store.appendIncoming(key, { mid: 3003, senderId: '77', senderName: '测试', text: '第三条' });
  app.orchestrator.runningChats.add(key);
  assert.equal((await post({ area: 'chats', ids: [key] })).status, 409);
  app.orchestrator.runningChats.delete(key);
  assert.equal((await post({ area: 'chats', ids: [key] })).data.removed, 1);
  assert.equal(app.store.listChats().includes(key), false);
  for (const chatKey of ['private:812346', 'private:812347']) {
    app.store.appendIncoming(chatKey, { mid: Number(chatKey.split(':')[1]), senderId: '77', text: '批量测试' });
  }
  assert.equal((await post({ area: 'chats', ids: ['private:812346', 'private:812347'] })).data.removed, 2);
  assert.equal((await post({ area: 'chats', all: true })).status, 200);

  app.memory.append(key, 'memberImpression', '喜欢橘色', { userId: '7712345', target: '测试' });
  assert.equal(app.memory.members(key).length, 1);
  assert.equal((await post({ area: 'memory', ids: [key] })).data.removed, 1);
  assert.equal(app.memory.members(key).length, 0);
  app.memory.append(key, 'memberImpression', '长期测试', { userId: '7712345', target: '测试' });
  const otherKey = 'private:812348';
  app.memory.append(otherKey, 'memberImpression', '多选测试', { userId: '7712346', target: '测试二' });
  assert.equal((await post({ area: 'memory', ids: [key, otherKey] })).data.removed, 2);
  app.memory.append(key, 'memberImpression', '长期测试', { userId: '7712345', target: '测试' });
  const previousConfig = structuredClone(getConfig());
  setRuntimeConfig({ ...previousConfig, reminder: { ...previousConfig.reminder, enabled: true } });
  const reminder = app.memory.reminders.create({ text: '隔离提醒', dueAt: Date.now() + 3600000, chatKey: key, source: 'manual' });
  assert.equal(reminder.ok, true);
  setRuntimeConfig(previousConfig);
  const style = app.memory.style.addItem('speech', '测试说话风格', { source: 'manual' });
  assert.equal(style.ok, true);
  app.memory.global.rememberFact('7712345', '偏爱橘色', { name: '测试', chatKey: key });
  const globalFactCount = app.memory.global.stats().facts;
  assert.ok(globalFactCount > 0);
  app.memory.style.distilling = true;
  assert.equal((await post({ area: 'memory', ids: ['__style__'] })).status, 409);
  app.memory.style.distilling = false;
  assert.equal((await post({ area: 'memory', ids: ['../config'] })).status, 400);
  assert.equal((await post({ area: 'memory', ids: ['__reminders__'] })).data.removed, 1);
  assert.equal(app.memory.reminders.list().length, 0);
  assert.equal(app.memory.style.items().length, 1);
  assert.equal(app.memory.global.stats().facts, globalFactCount);
  assert.equal((await post({ area: 'memory', ids: ['__style__'] })).data.removed, 1);
  assert.equal(app.memory.style.items().length, 0);
  assert.equal(app.memory.global.stats().facts, globalFactCount);
  assert.equal((await post({ area: 'memory', ids: ['__global__'] })).data.removed, 1);
  assert.equal(app.memory.global.stats().facts, 0);
  const cleared = await post({ area: 'memory', all: true });
  assert.equal(cleared.status, 200);
  assert.equal(app.memory.members(key).length, 0);
  assert.equal(app.memory.style.items().length, 0);
  assert.equal(app.memory.reminders.list().length, 0);
  assert.equal(app.memory.global.stats().facts, 0);
  assert.equal(getConfig().api.apiKey, 'fixture-key');
  assert.equal(fs.existsSync(path.join(tmp, 'bridge')), false);
});

test('模型接入 API 脱敏，无密钥跨厂商切换失败时保留配置', async () => {
  assert.equal((await request('/api/model-catalog')).data.vendors.length, 3);
  const first = await request('/api/model-connection', 'POST', { vendor: 'deepseek', model: 'deepseek-flash', apiKey: 'connection-fixture' });
  assert.equal(first.status, 200);
  assert.equal(first.data.provider.hasKey, true);
  assert.ok(!JSON.stringify(first.data).includes('connection-fixture'));
  const before = structuredClone(getConfig());
  const rejected = await request('/api/model-connection', 'POST', { vendor: 'gpt', model: 'gpt-6-astra' });
  assert.equal(rejected.status, 400);
  assert.deepEqual(getConfig(), before);
  const second = await request('/api/model-connection', 'POST', { vendor: 'deepseek', model: 'deepseek-v4-pro' });
  assert.equal(second.status, 200);
  assert.equal(second.data.provider.id, first.data.provider.id);
  assert.equal(getConfig().api.model, 'deepseek-v4-pro');
});

test('无上报请求或遗留外部功能入口', () => {
  assert.deepEqual(externalRequests, []);
  for (const rel of ['src/app.js', 'src/config.js', 'src/sessions.js', 'ui/app.js', 'ui/index.html', 'ui/style.css']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    // 关于页按用户要求保留署名，网站/上传/遥测入口仍不可恢复。
    assert.doesNotMatch(text, /https?:\/\/[^\s"']*kondius|COMMUNITY_API|runUpdateCheck|quoteMode|quoteSelected|startTelemetryLoop|group-qrcode|\/api\/media-data/i, rel);
  }
});
