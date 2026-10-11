// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 500;    // 存档页：首次加载条数
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  appInfo: null,
  personaTemplates: {},
  personas: [],          // 人设库（含各自记忆规模），来源 /api/personas
  personaActiveId: '',
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  settingsMemoryExpanded: true,
  memoryView: 'events',
  currentMemoryChatKey: null,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {},  // chatKey -> { note, at, failed? }
  // 定时提醒 / 说话风格库：记忆页签里的两个伪条目用
  reminders: null,        // /api/reminders 的返回 { stats, items, cfg }
  style: null,            // /api/style 的返回 { stats, items, samples, cfg }
  memes: null,            // /api/memes 的返回 { memes, stats, cfg, files }（设置 → 梗知识库）
  reminderFilter: 'open'  // 提醒列表默认只看"待触发+错过"
};

// 记录管理的勾选状态与列表渲染分开，轮询刷新不会抹掉用户正在选择的项目。
const selectedRecords = {
  sessions: new Set(), chats: new Set(), memory: new Set(), messages: new Set()
};

async function deleteUserRecords(area, { ids = [], all = false, chatKey = '', messageIds = null, scopeLabel = '' } = {}) {
  const labels = { sessions: '会话记录', chats: '消息存档', memory: '记忆记录' };
  const scope = scopeLabel || (messageIds ? `${messageIds.length} 条消息` : (all ? `${area === 'memory' ? '当前人设的' : ''}全部${labels[area]}` : `${ids.length} 项${labels[area]}`));
  if (!all && !ids.length && !messageIds?.length) return showNotice('请先勾选要清空的内容', 'error');
  if (!(await confirmRecordDeletion(scope))) return;
  try {
    const result = await api('/api/data/delete', {
      method: 'POST', body: JSON.stringify({ area, ids, all, chatKey, messageIds })
    });
    showNotice(`已清空 ${result.removed} 项`, 'success');
    selectedRecords[area].clear();
    if (messageIds) selectedRecords.messages.clear();
    if (area === 'sessions') {
      if (all || ids.includes(state.currentSessionId)) {
        state.currentSessionId = null;
        state.sessionDetail = null;
        $('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      }
      await loadSessions();
    } else if (area === 'chats') {
      if (!messageIds && (all || ids.includes(state.currentChatKey))) {
        state.currentChatKey = null;
        state.chatMessages = [];
        $('#chat-detail').innerHTML = '<div class="empty-hint">← 选择会话查看消息存档</div>';
      }
      await loadChats();
      if (messageIds && state.currentChatKey === chatKey) await loadChatMessages(chatKey, { keepView: true });
    } else {
      if (all || ids.includes(state.currentMemoryChatKey)) {
        state.currentMemoryChatKey = null;
        $('#memory-detail').innerHTML = '<div class="empty-hint">← 选择记录查看记忆</div>';
      }
      if (state.tab === 'memory') await loadMemoryView();
      if (state.tab === 'settings') await refreshSettingsMemoryState(state.settingsSection, { force: true });
    }
  } catch (error) {
    showNotice(`清空失败：${error.message}`, 'error');
    if (area === 'sessions') await loadSessions({ quiet: true });
    else if (area === 'chats') await loadChats({ quiet: true });
    else await loadMemoryView();
  }
}

function confirmRecordDeletion(scope) {
  return new Promise((resolve) => {
    const overlay = modelModalShell({
      head: '确认清空',
      body: `<p>将清空 <strong>${esc(scope)}</strong>。此操作无法撤销。</p>`,
      foot: '<button class="btn" id="record-cancel">取消</button><button class="btn btn-danger" id="record-confirm">确认清空</button>',
      danger: true
    });
    const finish = (accepted) => { closeModelModal(overlay); resolve(accepted); };
    overlay.querySelector('#record-cancel').addEventListener('click', () => finish(false));
    overlay.querySelector('#record-confirm').addEventListener('click', () => finish(true));
    overlay.querySelector('.model-modal-close').addEventListener('click', () => resolve(false));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) resolve(false); });
  });
}

function bindRecordActions() {
  $$('.record-actions').forEach((bar) => bar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const area = bar.dataset.area;
    const selected = selectedRecords[area];
    if (button.dataset.action === 'select-all') {
      const items = area === 'sessions' ? state.sessions.map((item) => item.id)
        : area === 'chats' ? state.chats.map((item) => item.key)
          : (state.memoryFiles || []).map((item) => item.chatKey);
      selected.clear();
      for (const id of items) selected.add(id);
      ({ sessions: renderSessionList, chats: renderChatList, memory: renderMemoryList })[area]();
    } else if (button.dataset.action === 'delete-selected') {
      deleteUserRecords(area, { ids: [...selected] });
    } else if (button.dataset.action === 'delete-all') {
      if (area === 'memory') {
        deleteUserRecords(area, { ids: (state.memoryFiles || []).map((item) => item.chatKey), scopeLabel: '当前人设的全部聊天群友印象' });
      } else deleteUserRecords(area, { all: true });
    }
  }));
}
bindRecordActions();

// ── 工具函数 ──
// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。
/** 数字加千分位（token 计数用）。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 * 用 let 而不是 const：点范围按钮会改它，改完要重新拉取数据。
 */
let usageRange = '7';

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认 —— 这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_sticker:      { name: '发表情包',   cat: '发言',   icon: '🎴' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看图片',     cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
  memory_search:     { name: '查长期记忆', cat: '记忆',   icon: '🔍' },
  memory_note_event: { name: '记长期事件', cat: '记忆',   icon: '📌' },
  memory_forget:     { name: '忘掉一条',   cat: '记忆',   icon: '🫥' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  // 其他
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' }
};

/** 分类的展示顺序（"其他"垫底） */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '记忆', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

const CONSOLE_MARKER = 'qq-agent-console';

/* ══════════════════════════════════════════════════════════════
   主题（明/暗/系统/？）
   ══════════════════════════════════════════════════════════════
   四种取值：'dark' | 'light' | 'system'（跟随系统偏好）| '?'（整活主题）。
   持久化两层：
     1. localStorage —— 立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme —— 保留用户选择，但不覆盖此设备的白色首屏偏好
   首屏防闪由 index.html 的内联脚本负责（首次升级将旧暗色偏好迁到白色）。
*/
const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️', '?': '❓' };
const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统', '?': '？' };
const THEME_VALUES = ['dark', 'light', 'system', '?'];

/** 读取当前主题设置；首次升级将旧版默认暗色迁到白色。 */
function getThemePref() {
  try {
    if (localStorage.getItem('qqa-white-theme-v1') !== '1') {
      localStorage.setItem('qqa-white-theme-v1', '1');
      localStorage.setItem('qqa-theme', 'light');
      return 'light';
    }
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'light';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  syncChaosLayers(actual === '?');
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = THEME_ICON[pref] || THEME_ICON.dark;
    btn.title = `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/* ── 「？」主题的 JS 层：VHS 覆盖层 + 点击爆粒子 ──
   CSS 管不了的就这两件需要一个真实 DOM 层（body 的 ::before/::after 已被占用）。
   主题切走即移除，零残留。 */
function syncChaosLayers(on) {
  let vhs = document.getElementById('chaos-vhs');
  if (on && !vhs) {
    vhs = document.createElement('div');
    vhs.id = 'chaos-vhs';
    vhs.innerHTML = '<div class="vhs-track"></div>';   // 白闪太刺眼已移除，只留扫描线+追踪误差带
    document.body.appendChild(vhs);
  } else if (!on && vhs) {
    vhs.remove();
  }
}

// 点击爆「？」粒子：只在「？」主题下生效（判断放点击时，不绑状态）
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  // 一次爆 3~5 个，方向随机（抽象 = 不统一）
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'chaos-pop';
    el.textContent = '？';
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    el.style.setProperty('--dy', `${-40 - Math.random() * 90}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 540}deg`);
    el.style.fontSize = `${14 + Math.random() * 20}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }
}, { passive: true });

/** 点击按钮：暗 → 亮 → 跟随系统 → ？ → 暗。 */
function cycleTheme() {
  const order = THEME_VALUES;
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  applyTheme(next);
  // 尽力同步到后端，失败不影响本地使用
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

let lastAction = null;
let noticeTimer = null;
document.addEventListener('click', (event) => {
  const button = event.target?.closest?.('button');
  if (button) lastAction = { label: (button.getAttribute('aria-label') || button.textContent).trim().replace(/\s+/g, ' ').slice(0, 28), at: Date.now() };
}, true);

function showNotice(message, kind = 'success') {
  const node = $('#action-notice');
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { node.hidden = true; }, kind === 'error' ? 6500 : 3600);
}

for (const eventName of ['input', 'change']) {
  document.addEventListener(eventName, (event) => {
    if (!event.target?.closest?.('#settings-form')) return;
    if (event.target.closest('#vendor-panel-other')) return; // 自定义接入有独立的确认按钮
    const result = $('#cfg-save-result');
    if (result) result.textContent = '有未保存的修改';
  });
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const changing = method !== 'GET' && method !== 'HEAD';
  // 初始化提交不代表清理完成，其独立流程在冷重启后核实结果。
  const announce = changing && !path.startsWith('/api/factory-reset/');
  const label = lastAction && Date.now() - lastAction.at < 15000 ? lastAction.label : '操作';
  try {
    const res = await fetch(path, {
      headers: {
        'content-type': 'application/json',
        'x-console-token': CONSOLE_MARKER,
        ...(options.headers || {})
      },
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (announce) {
      const failed = data.ok === false || data.result?.ok === false;
      const reason = data.error || data.result?.note || data.result?.error || '操作未完成';
      showNotice(failed ? `「${label}」未生效：${reason}` : `「${label}」已生效`, failed ? 'error' : 'success');
    }
    return data;
  } catch (error) {
    if (announce) showNotice(`「${label}」失败：${error.message}`, 'error');
    throw error;
  }
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  // 拆成"接口地址"与"模型"两步：合并判断时新手分不清到底缺哪个。
  // 出厂 baseUrl 为空，第一条会直接指出该填什么。
  const urlOk = !!String(cfg.api.baseUrl || '').trim();
  checks.push({
    ok: urlOk,
    label: urlOk ? `接口地址：${cfg.api.baseUrl}` : '还没有填接口地址（Base URL，必填）：官方 API 或中转站提供的 OpenAI 兼容地址',
    fix: urlOk ? null : 'settings-api'
  });
  const modelOk = !!String(cfg.api.model || '').trim();
  checks.push({
    ok: modelOk,
    label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（填好地址后点「获取列表」或手动添加）',
    fix: modelOk ? null : 'settings-api'
  });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot（SnowLuma）未连接 —— 请到设置中启动', fix: obOk ? null : 'snowluma-tab' });
  return { ready: urlOk && modelOk && allowOk && obOk, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  const flow = s?.messageFlow || null;
  const pipelineErr = flow?.pipelineError || s?.snowluma?.pipelineError || null;
  const pipelineRecent = pipelineErr && (Date.now() - (pipelineErr.at || 0) < 15 * 60000);
  // 另一种失聪：OneBot 连着、但没登上任何 QQ 号（SnowLuma 卡死时就是这样）
  const accountStuck = Number(flow?.accountMissingSince) > 0
    && (Date.now() - Number(flow.accountMissingSince) > 60000)
    && !!s?.onebot?.connected;
  // 消息进不来的优先级最高：这时候"机器人不理人"但界面上一片正常，用户根本无从下手
  if (pipelineRecent || accountStuck) {
    show = true;
    html = pipelineRecent
      ? `🩺 <b>消息进不来了</b>：SnowLuma 的事件管道在报错（${esc(String(pipelineErr.sample || '').slice(0, 60))}…），
         所以群里的消息传不到机器人这边 —— 它看起来"不理人"，其实是根本没收到。
         这通常是两个 SnowLuma 实例抢同一个数据库造成的。`
      : `🩺 <b>QQ 号没登上</b>：OneBot 连上了，但一直取不到登录信息 —— SnowLuma 多半卡住了
         （它占着端口却不响应，所以"进不去 SnowLuma"）。机器人此时收不到任何消息。`;
    html += ` <button class="btn btn-small btn-primary" id="banner-sl-fix">一键修复（重启 SnowLuma）</button>
      <span class="muted" id="banner-sl-fix-msg"></span>`;
  } else if (state.paused) {
    show = true;
    // 恢复后积压怎么处理由设置决定，界面上必须说清楚：
    // 否则用户点了「恢复」，看到积压被跳过，会以为机器人还是坏的。
    const forcedMode = (s?.orchestrator?.resumeBacklogMode || 'tier') === 'force';
    html = forcedMode
      ? '⏸ 机器人已暂停，不会处理任何消息。<span class="muted">（恢复时会把暂停期间的积压补处理）</span>'
      : '⏸ 机器人已暂停，不会处理任何消息。<span class="muted">（恢复时积压按档位判定，低档位群里可能被跳过）</span>';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动，且设置里的 WS/HTTP 地址正确。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused && !pipelineRecent && !accountStuck) {
      const forcedMode = (s?.orchestrator?.resumeBacklogMode || 'tier') === 'force';
      html += ` <button class="btn btn-small" id="banner-resume-btn" title="${forcedMode
        ? '恢复运行，并把暂停期间积压的未读消息全部补处理'
        : '恢复运行；暂停期间积压的未读按档位判定，低档位群里可能被跳过'}">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
    const fixBtn = $('#banner-sl-fix');
    if (fixBtn) fixBtn.addEventListener('click', async () => {
      const msg = $('#banner-sl-fix-msg');
      fixBtn.disabled = true;
      if (msg) msg.textContent = '正在清扫重复实例并重启…（约 20 秒）';
      try {
        const r = await api('/api/snowluma/force-restart', { method: 'POST', body: '{}' });
        if (msg) msg.textContent = r.ok ? `已重启${r.killed?.length ? `（清理了 ${r.killed.length} 个残留实例）` : ''}，等它登录后消息就会恢复。` : `失败：${r.error || '未知错误'}`;
      } catch (e) {
        if (msg) msg.textContent = `失败：${e.message}`;
      } finally {
        fixBtn.disabled = false;
        setTimeout(() => { refreshStatus(); }, 3000);
      }
    });
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

function switchTab(name) {
  if (name === 'snowluma') {
    state.settingsSection = 'onebot';
    name = 'settings';
  }
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'memory') loadMemoryView();
  if (name === 'usage') loadUsageView({ force: true });
  if (name === 'settings') loadSettings();
}

// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    label.textContent = s.onebot.connected
      ? `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
      : 'OneBot 未连接';
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${rateTxt}`;
    $('#search-count-label').textContent = `搜索：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`;
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#reload-page-btn')?.addEventListener('click', () => window.location.reload());

// 背景独立于机器人运行；隐藏窗口时停播，恢复后遵循本机偏好。
function initVideoBackground() {
  const video = $('#background-video');
  const button = $('#background-toggle-btn');
  if (!video || !button) return;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let preference = null;
  let failed = false;
  let playbackAttempt = 0;
  try { preference = localStorage.getItem('qqa-background-paused'); } catch { /* 本机偏好可选 */ }
  let paused = preference === null ? motion.matches : preference === '1';
  video.muted = true;
  const update = () => {
    const attempt = ++playbackAttempt;
    button.textContent = failed ? '背景不可用' : paused ? '播放背景' : '暂停背景';
    button.setAttribute('aria-pressed', String(paused));
    button.disabled = failed;
    if (paused || document.hidden || failed) video.pause();
    else video.play().catch(() => {
      if (attempt !== playbackAttempt) return;
      // 自动播放被浏览器阻止时允许用户手动重试，不影响管理界面。
      paused = true;
      button.textContent = '播放背景';
      button.setAttribute('aria-pressed', 'true');
    });
  };
  button.addEventListener('click', () => {
    paused = !paused;
    preference = paused ? '1' : '0';
    try { localStorage.setItem('qqa-background-paused', preference); } catch { /* 忽略 */ }
    update();
  });
  video.addEventListener('error', () => {
    failed = true;
    update();
    showNotice('视频背景加载失败，已使用静态背景，页面功能仍可使用', 'error');
  });
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', () => {
    if (preference === null) { paused = motion.matches; update(); }
  });
  update();
}
initVideoBackground();

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => {
    loadSessions();
    refreshStatus();
    // 自动跟随新会话（等待中/运行中）
    if (state.autoFollowRunning) {
      loadSessions({ quiet: true }).then(() => {
        const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
        if (active && active.id !== state.currentSessionId) selectSession(active.id);
      });
    }
  });
  es.addEventListener('session-update', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    // SSE 事件本身携带完整会话快照：patch 立即进 state，渲染走合批（见上）
    const patch = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerSummary: data.triggerSummary ?? '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null —— pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) patch.sent = data.sent;
    if (data.finishReason !== undefined) patch.finishReason = data.finishReason;
    if (data.error !== undefined) patch.error = data.error;
    if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
    const existing = state.sessions.find((s) => s.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.sessions.unshift({ ...patch, trigger: data.trigger || '', triggerSummary: data.triggerSummary || '', startedAt: data.startedAt ?? Date.now() });
      // 上限要大于一次可取的数量，否则新会话一进来就把旧的挤没了
      state.sessions = state.sessions.slice(0, SESSION_KEEP);
    }
    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...patch });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* 数据坏了也照常刷列表 */ }
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来 —— 不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    const id = data.sessionId;
    if (id && id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      loadSessionDetail(id, { quiet: true });
    }
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('memory-update', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { data = { phase: 'refresh' }; }
    const phase = data.phase || '';
    const chatKey = data.chatKey || '';

    // 状态一律记进 state（不依赖当前 DOM），这样切走页签再切回也能恢复显示。
    // 原先只操作 DOM 且 tab 不对就 return，导致切回来完全看不出整理是否还在跑。
    if (phase === 'consolidate-start') {
      if (chatKey) state.consolidating[chatKey] = { startedAt: Date.now() };
    } else if (phase === 'consolidate-done') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) state.consolidateResult[chatKey] = { note: data.note || '整理完成', at: Date.now() };
    } else if (phase === 'consolidate-error') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        state.consolidateResult[chatKey] = { note: `整理失败：${data.error || '未知错误'}`, at: Date.now(), failed: true };
      }
    }

    if (state.tab === 'settings' && state.settingsSection === 'memory') refreshSettingsMemoryState('memory');
    // 只有停在记忆页时才操作聊天印象的 DOM / 刷新列表
    if (state.tab !== 'memory') return;

    if (phase === 'consolidate-start') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '整理中…';
      renderMemoryList();
    } else if (phase === 'consolidate-done') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = data.note || '整理完成';
      loadMemoryView();
    } else if (phase === 'consolidate-error') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = `整理失败：${data.error || '未知错误'}`;
      renderMemoryList();
    } else {
      loadMemoryView();
    }
  });
  // 定时提醒 / 风格库的实时刷新：她自己定了提醒、或后台学完一轮，界面要跟上
  es.addEventListener('reminder-update', async () => {
    await refreshReminderState();
    if (state.tab === 'settings' && state.settingsSection === 'reminder') refreshSettingsMemoryState('reminder');
  });
  es.addEventListener('style-update', async () => {
    await refreshStyleState();
    if (state.tab === 'settings' && state.settingsSection === 'style') refreshSettingsMemoryState('style');
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
    if (state.tab === 'settings' && state.settingsSection === 'onebot') loadSnowlumaPage({ quiet: true });
  });
  es.addEventListener('status', () => refreshStatus());
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'settings' && state.settingsSection === 'onebot') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-log', (ev) => {
    const d = JSON.parse(ev.data);
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && state.tab === 'settings' && state.settingsSection === 'onebot') {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    // 一次全取：后端上限 2^20（约等于不限），前端靠分页渲染（SESSION_PAGE）避免卡顿
    const data = await api('/api/sessions?limit=1048576');
    state.sessions = data.sessions || [];
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
      if (active) selectSession(active.id);
    }
    // 当前打开的会话在等待/运行中时，也顺手刷新详情
    if (state.currentSessionId) {
      const cur = state.sessions.find((s) => s.id === state.currentSessionId);
      if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
        loadSessionDetail(state.currentSessionId, { quiet: true });
      }
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  return Number.isFinite(n) && n >= 1000 ? n : 4000;
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  attachScrollLoader('session-list', () => {
    const all = state.sessions || [];
    if (state.sessionLimit >= all.length) return;   // 已经全显示了
    state.sessionLimit = Math.min(all.length, state.sessionLimit + SESSION_PAGE);
    renderSessionList();
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
    if (state.tab === 'settings' && state.settingsSection === 'onebot') loadSnowlumaPage({ quiet: true });
    if (state.tab === 'usage') loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}
startListPoller();

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const all = state.sessions || [];
  const shown = all.slice(0, state.sessionLimit);
  const rest = all.length - shown.length;
  box.innerHTML = shown.map((s) => {
    const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
    const waitHtml = s.status === 'waiting' && s.waitUntil
      ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
      : '';
    const activityHtml = s.status === 'running' && s.activity
      ? `<span class="session-activity">${esc(s.activity)}</span>`
      : '';
    const searchHtml = Number(s.webSearchCount) > 0
      ? `<span class="muted">搜 ${s.webSearchCount}</span>`
      : '';
    const isNew = !state.seenSessionIds.has(s.id);
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}" data-id="${s.id}">
        <div class="session-title">
          <input class="record-check" type="checkbox" aria-label="选择会话 ${esc(s.id)}" ${selectedRecords.sessions.has(s.id) ? 'checked' : ''} />
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
          <button class="record-delete" type="button" aria-label="清空这条会话" title="清空这条会话">×</button>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          ${waitHtml}
          ${activityHtml}
          ${s.status !== 'waiting' ? `<span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span><span>${s.rounds || 0} 轮</span>${searchHtml}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更多（还有 ${rest} 条）`
      : (all.length > SESSION_PAGE ? `已显示全部 ${all.length} 条` : '');
  }
  // 头部显示总数（已显示 / 总数），便于确认分页是否真的加载完了
  const cnt = $('#session-count');
  if (cnt) {
    cnt.textContent = all.length ? `${shown.length}/${all.length}` : '';
  }
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
    el.querySelector('.record-check')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.checked) selectedRecords.sessions.add(el.dataset.id);
      else selectedRecords.sessions.delete(el.dataset.id);
    });
    el.querySelector('.record-delete')?.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteUserRecords('sessions', { ids: [el.dataset.id] });
    });
  });
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      el.textContent = remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…';
    }
  }, 100);
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};

  const html = [];
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
      </h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
        <span>联网搜索 ${Number(s.webSearchCount) || 0} 次</span>
      </div>
    </div>`);

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      inputMessages: (s.inputMessages || []).map((m) => ({ role: m.role, content: m.content })),
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    if (s.systemPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
          <div class="coll-body">${esc(s.systemPrompt)}</div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible" open>
          <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
          <div class="coll-body">${esc(s.userPrompt)}</div>
        </details>`);
    }
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        html.push(`
          <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
            <div class="tool-head"><span class="tool-name">${esc(item.toolCall.name)}</span></div>
            <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
            <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
          </div>`);
      } else if (item.toolImages) {
        html.push(`
          <div class="tool-card">
            <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
            <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
          </div>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <div class="bubble bubble-assistant">
            <div class="asr-label">思考（不发送）</div>
            ${esc(text || '（无文本输出，仅调用工具）')}
          </div>`);
      }
    }
    // 发出的消息
    for (const sent of s.sent || []) {
      html.push(`
        <div class="sent-badge">
          <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}</div>
          ${esc(sent.text)}
        </div>`);
    }
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 说明：此处原先有一段"运行中每 2s 自递归拉详情"的兜底轮询，已移除。
  // 原因：renderSessionDetail 会被 SSE 事件和 4s 主轮询反复调用，每次都新起一个
  // setTimeout 且从不取消旧的，切换/高频刷新时 timer 会不断累积；
  // 而下面的 4s 主轮询（loadSessions）已经会对 running/waiting 的会话刷新详情，
  // 功能完全覆盖，2s 递归属于纯重复请求。
}

// ── SnowLuma 独立页签 ──
/**
 * 只刷新 SnowLuma 的日志区（不重建整个页面）。
 * SSE 每来一条新日志就调一次 —— 如果这里重建整页，
 * 用户正在看的日志会被反复重绘，滚动位置也保不住。
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  const pre = box.querySelector('.snowluma-logs-view');
  if (!pre) return;                       // 页面还没渲染过，等下次整页刷新
  try {
    const logs = await api('/api/snowluma/logs');
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    // ⚠️ 先记贴底状态再换内容：新日志追加在底部，scrollTop 不变 = 阅读位置不变；
    //    只有用户本来就贴底才跟随到底，往上翻历史时绝不把他拽回去。
    //    滚动容器是 <pre> 自己（overflow-y:auto），不是 parentElement —— 之前滚错了对象。
    const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
    pre.textContent = logText;
    if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
  } catch { /* 刷新失败静默，不影响主流程 */ }
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs')
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    // 消息流健康度：OneBot 连着 ≠ 消息进得来（事件管道坏掉时它是静默的）
    const pipelineErr = status.messageFlow?.pipelineError || null;
    const lastIncomingAt = Number(status.messageFlow?.lastIncomingAt) || 0;
    const lastIncomingChat = status.messageFlow?.lastIncomingChat || '';
    const sinceMin = lastIncomingAt ? Math.round((Date.now() - lastIncomingAt) / 60000) : -1;
    // 「OneBot 连着但没登上 QQ 号」= SnowLuma 卡死的典型表现（WebUI 也会打不开）
    const accountMissingSince = Number(status.messageFlow?.accountMissingSince) || 0;
    const accountStuckMin = accountMissingSince ? Math.round((Date.now() - accountMissingSince) / 60000) : 0;
    const flowHtml = pipelineErr
      ? `<div class="hint" style="color:var(--color-text-danger,#f66);margin-top:6px">
           ⚠ 事件管道报错 ${pipelineErr.count || 1} 次（最近 ${fmtTime(pipelineErr.at)}）：${esc(String(pipelineErr.sample || '').slice(0, 90))}
           <br />消息因此进不来 —— 机器人会表现为"不理人"。点下面的「强制重启」修一下。
         </div>`
      : (accountStuckMin >= 1
        ? `<div class="hint" style="color:var(--color-text-danger,#f66);margin-top:6px">
             ⚠ OneBot 已连接，但已经 ${accountStuckMin} 分钟拿不到 QQ 登录信息：SnowLuma 多半卡住了
             （所以 WebUI 也进不去）。机器人此时收不到任何消息，点下面的「强制重启」修一下。
           </div>`
        : `<div class="hint" style="margin-top:6px">
             当前 QQ 号：${status.onebot?.self?.nickname ? esc(status.onebot.self.nickname) : (status.onebot?.connected ? '（还没取到登录信息）' : '未连接')}
             · 最近一条收到的消息：${lastIncomingAt ? `${fmtTime(lastIncomingAt)}（${sinceMin <= 0 ? '刚刚' : `${sinceMin} 分钟前`}${lastIncomingChat ? ` · ${esc(chatNameOf(lastIncomingChat) || lastIncomingChat)}` : ''}）` : '（启动后还没有收到任何消息）'}
           </div>`);
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';

    // 整页重建前记住日志滚动位置：SSE/轮询触发的 quiet 重建会重置 DOM，
    // 不补偿的话用户往下翻日志会被弹回顶部（实测：划两下就蹦上去）
    const oldPre = box.querySelector('.snowluma-logs-view');
    const prevScroll = oldPre
      ? { top: oldPre.scrollTop, atBottom: oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 40 }
      : null;

    box.innerHTML = `
      <div class="snowluma-page-card">
        <h2>SnowLuma（OneBot 网关）</h2>
        <div class="snowluma-state-row">
          <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
          <span>SnowLuma：<strong>${running ? '运行中' : '未运行'}</strong></span>
          ${pid ? `<span class="muted">pid ${pid}</span>` : ''}
          <span class="muted">${embedded ? '内置模式（随 QQ Agent 退出）' : (running ? '独立模式' : '')}</span>
        </div>
        <div class="snowluma-state-row">
          <span class="dot ${onebotConnected ? 'dot-on' : 'dot-off'}"></span>
          <span>OneBot：<strong>${onebotConnected ? `已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}` : '未连接'}</strong></span>
          <span class="muted">WS ${s.onebot?.error ? `：${s.onebot.error}` : ''}</span>
        </div>
        <div class="snowluma-state-row muted">
          <span>目录：${esc(dir || '（未找到项目内 snowluma/ 文件夹）')}</span>
        </div>
        <div class="snowluma-state-row">
          <span>WebUI：</span>
          ${webuiUrl
            ? `<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">${esc(webuiUrl)}</button>`
            : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>'}
        </div>
        <div class="snowluma-actions">
          <button class="btn btn-primary" id="sl-start-btn" ${running ? 'disabled' : ''}>${running ? '已运行' : '启动 SnowLuma'}</button>
          <button class="btn btn-danger" id="sl-stop-btn" ${running ? '' : 'disabled'}>关闭 SnowLuma</button>
          <button class="btn btn-small" id="sl-force-restart-btn" title="清扫所有 SnowLuma 进程（含残留的重复实例）后重新启动一个干净实例 —— 消息进不来时用这个">强制重启（清理重复实例）</button>
          <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
          <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
          <span id="sl-hint" class="muted" style="font-size:12px"></span>
        </div>
        ${flowHtml}
        <div>
          <div class="hint" style="margin-bottom:6px">运行日志（仅保留最近 500 行）</div>
          <pre class="snowluma-logs-view">${esc(logText)}</pre>
        </div>
      </div>`;

    // 恢复日志滚动：贴底跟随新日志；否则回到原阅读位置；首次渲染贴底
    const newPre = box.querySelector('.snowluma-logs-view');
    if (newPre) newPre.scrollTop = prevScroll ? (prevScroll.atBottom ? newPre.scrollHeight : prevScroll.top) : newPre.scrollHeight;

    $('#sl-start-btn').addEventListener('click', async () => {
      const btn = $('#sl-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
      } catch (e) {
        $('#sl-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    $('#sl-stop-btn').addEventListener('click', async () => {
      const btn = $('#sl-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
        // 别骗用户：没关掉就直说（SnowLuma 可能是外部启动的，或本来就已经关了）
        $('#sl-hint').textContent = r.stopped ? '已请求关闭 SnowLuma。' : '没有找到正在运行的 SnowLuma（可能已经关了）。';
      } catch (e) {
        $('#sl-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });
    $('#sl-refresh-btn').addEventListener('click', () => loadSnowlumaPage());
    $('#sl-force-restart-btn').addEventListener('click', async () => {
      const btn = $('#sl-force-restart-btn');
      btn.disabled = true; btn.textContent = '重启中…（约 20 秒）';
      $('#sl-hint').textContent = '正在清扫所有 SnowLuma 进程并重新启动…';
      try {
        const r = await api('/api/snowluma/force-restart', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.ok
          ? `已重启${r.killed?.length ? `，清理了 ${r.killed.length} 个残留实例（pid ${r.killed.join(', ')}）` : ''}；等 QQ 登录完成后消息就会恢复。`
          : `重启失败：${r.error || '未知错误'}`;
      } catch (e) {
        $('#sl-hint').textContent = `重启失败：${e.message}`;
      }
      btn.disabled = false; btn.textContent = '强制重启（清理重复实例）';
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 3000);
    });
    $('#sl-open-folder-btn').addEventListener('click', async () => {
      try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
      catch (e) { $('#sl-hint').textContent = `失败：${e.message}`; }
    });
    const webuiBtn = $('#sl-open-webui-btn');
    if (webuiBtn) webuiBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
        if (!r.ok) $('#sl-hint').textContent = r.error;
      } catch (e) {
        $('#sl-hint').textContent = `打开失败：${e.message}`;
      }
    });
  } catch (e) {
    if (!quiet) console.error(e);
  }
}

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  box.innerHTML = state.chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <input class="record-check" type="checkbox" aria-label="选择存档 ${esc(name)}" ${selectedRecords.chats.has(c.key) ? 'checked' : ''} />
          <span class="session-chat">${esc(name)}</span>
          <button class="record-delete" type="button" aria-label="清空这份存档" title="清空这份存档">×</button>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
          ${c.skipped ? `<span class="skip-pill" title="被档位判定跳过（机器人看见了但决定不回应）">跳过 ${c.skipped}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
    el.querySelector('.record-check')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.checked) selectedRecords.chats.add(el.dataset.key);
      else selectedRecords.chats.delete(el.dataset.key);
    });
    el.querySelector('.record-delete')?.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteUserRecords('chats', { ids: [el.dataset.key] });
    });
  });
}

async function selectChat(key) {
  if (state.currentChatKey !== key) selectedRecords.messages.clear();
  state.currentChatKey = key;
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=100000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}${meta.skipped ? ` <span class="skip-pill" title="被档位判定跳过：机器人看见了这些消息，但按当前档位决定不回应。它们不会触发模型调用。">已跳过 ${meta.skipped}</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <div class="record-actions message-actions"><button class="btn btn-small" id="chat-select-visible">全选当前显示</button><button class="btn btn-small" id="chat-delete-selected">清空所选消息</button></div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
      method: 'POST', body: JSON.stringify({ text })
    });
    input.value = '';
    // 同理，保持当前分页与滚动位置
    loadChatMessages(key, { keepView: true });
  });

  $('#chat-select-visible').addEventListener('click', () => {
    for (const row of $$('#chat-msg-body tr[data-midrow]')) selectedRecords.messages.add(Number(row.dataset.midrow));
    updateChatMessagesBody(true);
  });
  $('#chat-delete-selected').addEventListener('click', () => deleteUserRecords('chats', {
    chatKey: key, messageIds: [...selectedRecords.messages]
  }));
  $('#chat-msg-body').addEventListener('click', (event) => {
    const check = event.target.closest('.message-check');
    if (check) {
      const id = Number(check.closest('tr').dataset.midrow);
      if (check.checked) selectedRecords.messages.add(id);
      else selectedRecords.messages.delete(id);
      return;
    }
    const button = event.target.closest('.message-delete');
    if (button) deleteUserRecords('chats', { chatKey: key, messageIds: [Number(button.closest('tr').dataset.midrow)] });
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();

}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  // 跳过标记：这条消息机器人看见了，但按档位决定不回应（零 token）。
  // 没有它的话，"档位拦下了"和"消息没进来"在界面上完全同形。
  const skipPill = m.skip
    ? ` <span class="skip-pill" title="档位 ${Number(m.skip.tier) || 0}：${esc(m.skip.reason || '未触发')}">跳过</span>`
    : '';
  return `
    <tr class="${m.read ? '' : 'unread'}${m.skip ? ' skipped-row' : ''}" data-midrow="${m.id}">
      <td class="record-cell"><input class="message-check" type="checkbox" aria-label="选择消息 ${m.id}" ${selectedRecords.messages.has(m.id) ? 'checked' : ''} /></td>
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}${skipPill}</td>
      <td class="record-cell"><button class="record-delete message-delete" type="button" aria-label="清空这条消息" title="清空这条消息">×</button></td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  return `<div class="usage-wrap"><div class="usage-head"><h2>用量</h2></div><div class="usage-cards">${card.repeat(4)}</div><div class="sk-block"></div></div>`;
}

function renderUsagePage(stats, status) {
  const box = $('#usage-page');
  if (!box) return;
  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head"><div><div class="eyebrow">INSIGHTS</div><h2>用量概览</h2><p class="muted">查看调用、Token 与缓存表现</p></div>
        <div class="usage-days">${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
          <button class="btn btn-small" id="usage-refresh-btn">刷新</button></div></div>
      <div class="usage-cards">
        <div class="usage-card accent"><div class="uc-label">总 Token</div><div class="uc-value" data-field="tokens">-</div><div class="uc-sub" data-field="tokens-sub">-</div></div>
        <button type="button" class="usage-card clickable" id="runs-card"><div class="uc-label">模型调用 <span class="uc-more">查看工具明细 ›</span></div><div class="uc-value" data-field="runs">-</div><div class="uc-sub" data-field="runs-sub">-</div></button>
        <div class="usage-card"><div class="uc-label">联网搜索</div><div class="uc-value" data-field="search">-</div><div class="uc-sub">搜索与网页读取次数</div></div>
        <div class="usage-card"><div class="uc-label">缓存命中率</div><div class="uc-value" data-field="rate">-</div><div class="usage-bar"><div class="usage-bar-fill ok" data-field="rate-bar"></div></div><div class="uc-sub" data-field="rate-sub">-</div></div>
      </div>
      <div data-block="days"><h3 class="usage-h3">按天</h3><div class="table-scroll"><table class="usage-table clickable" data-table="days"><thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th></tr></thead><tbody></tbody></table></div></div>
      <div data-block="chats"><h3 class="usage-h3">按会话</h3><div class="table-scroll"><table class="usage-table clickable" data-table="chats"><thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th></tr></thead><tbody></tbody></table></div></div>
      <div data-block="models"><h3 class="usage-h3">按模型 <button class="btn btn-small" id="models-expand" hidden>展开全部</button></h3><div class="table-scroll"><table class="usage-table clickable" data-table="models"><thead><tr><th>渠道 · 模型</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th></tr></thead><tbody></tbody></table></div></div>
    </div>`;
  box.querySelector('#runs-card')?.addEventListener('click', () => openToolBreakdown());
  box.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => {
    usageRange = button.dataset.range;
    loadUsageView({ force: true });
  }));
  box.querySelector('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true }));
  for (const [table, dim] of [['days', 'day'], ['chats', 'chat'], ['models', 'model']]) {
    box.querySelector(`[data-table="${table}"]`)?.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-key]');
      if (row) openUsageBreakdown(dim, row.dataset.key);
    });
  }
  box.querySelector('#models-expand')?.addEventListener('click', () => {
    const tbody = box.querySelector('[data-table="models"] tbody');
    tbody.dataset.expanded = tbody.dataset.expanded === '1' ? '0' : '1';
    updateUsagePage(state.usageStats, status);
  });
  updateUsagePage(stats, status);
}

function updateUsagePage(stats, status) {
  const box = $('#usage-page');
  if (!box) return;
  const totals = stats?.totals || {};
  const put = (name, value) => {
    const node = box.querySelector(`[data-field="${name}"]`);
    if (node) node.textContent = String(value);
  };
  put('tokens', fmtTok(totals.totalTokens));
  put('tokens-sub', `输入 ${fmtTok(totals.promptTokens)} · 输出 ${fmtTok(totals.completionTokens)}`);
  put('runs', totals.runs || 0);
  put('runs-sub', `今日 ${status?.usage?.runs ?? 0} 次`);
  put('search', fmtTok(stats?.searchCount));
  put('rate', `${((totals.cacheHitRate || 0) * 100).toFixed(1)}%`);
  put('rate-sub', `命中 ${fmtTok(totals.cachedTokens)} / 输入 ${fmtTok(totals.promptTokens)}`);
  const bar = box.querySelector('[data-field="rate-bar"]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, (totals.cacheHitRate || 0) * 100)).toFixed(1)}%`;
  box.querySelectorAll('[data-range]').forEach((button) => button.classList.toggle('btn-primary', button.dataset.range === usageRange));
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.hidden = stats?.mode !== 'days';
  const renderRows = (name, list, builder, colspan, fold = false) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const values = list || [];
    const folded = fold && values.length > 20 && tbody.dataset.expanded !== '1';
    tbody.innerHTML = values.length ? (folded ? values.slice(0, 20) : values).map(builder).join('') : `<tr><td colspan="${colspan}" class="muted">本区间暂无记录</td></tr>`;
    if (fold) {
      const button = box.querySelector('#models-expand');
      button.hidden = values.length <= 20;
      button.textContent = folded ? `展开全部（${values.length}）` : '收起';
    }
  };
  const cell = (value) => `<td class="r">${fmtTok(value)}</td>`;
  const rate = (value) => `<td class="r">${((value || 0) * 100).toFixed(0)}%</td>`;
  renderRows('days', stats?.days, (row) => `<tr data-key="${esc(row.day)}"><td>${esc(row.day)}</td>${cell(row.runs)}${cell(row.promptTokens)}${cell(row.completionTokens)}${cell(row.cachedTokens)}${rate(row.cacheHitRate)}</tr>`, 6);
  renderRows('chats', stats?.chats, (row) => `<tr data-key="${esc(row.key)}"><td>${esc(formatChatTitle(row.key, chatNameOf(row.key)))}</td>${cell(row.runs)}${cell(row.promptTokens)}${cell(row.completionTokens)}${rate(row.cacheHitRate)}</tr>`, 5);
  renderRows('models', stats?.models, (row) => `<tr data-key="${esc(row.key)}"><td>${esc(row.key)}</td>${cell(row.runs)}${cell(row.promptTokens)}${cell(row.completionTokens)}${rate(row.cacheHitRate)}</tr>`, 5, true);
}

let usageLoadToken = 0;
let usageLastData = null;
async function loadUsageView({ force = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;
  const token = ++usageLoadToken;
  const range = usageRange;
  const cached = usageLastData?.range === range ? usageLastData : null;
  if (force) {
    if (cached) renderUsagePage(cached.stats, cached.status);
    else box.innerHTML = renderUsageSkeleton();
  }
  try {
    const [stats, status] = await Promise.all([api(`/api/usage/stats?range=${encodeURIComponent(range)}`), api('/api/status')]);
    if (token !== usageLoadToken || state.tab !== 'usage' || usageRange !== range) return;
    state.usageStats = stats;
    usageLastData = { range, stats, status };
    if (force || !box.querySelector('[data-table="models"]')) renderUsagePage(stats, status);
    else updateUsagePage(stats, status);
  } catch (error) {
    if (!cached && token === usageLoadToken) box.innerHTML = `<div class="empty-hint">用量加载失败：${esc(error?.message || error)}</div>`;
    showNotice(`用量刷新失败：${error?.message || error}`, 'error');
  }
}

function openUsageBreakdown(dim, key) {
  const tabs = { chat: [['model', '各模型'], ['day', '各天']], model: [['chat', '各会话'], ['day', '各天']], day: [['model', '各模型'], ['chat', '各会话']] }[dim] || [['model', '各模型']];
  let by = tabs[0][0];
  const overlay = modelModalShell({
    head: `用量明细 · ${esc(key)}`,
    body: `<div class="ub-wrap"><div class="ub-tabs" id="ub-tabs">${tabs.map(([value, label]) => `<button class="btn btn-small" data-by="${value}">${label}</button>`).join('')}</div><div class="ub-scroll"><table class="usage-table"><thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th></tr></thead><tbody id="ub-body"><tr><td colspan="5">加载中…</td></tr></tbody></table></div></div>`,
    foot: '<button class="btn" id="ub-close">关闭</button>'
  });
  const body = overlay.querySelector('#ub-body');
  const load = async () => {
    body.innerHTML = '<tr><td colspan="5">加载中…</td></tr>';
    try {
      const data = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${by}`);
      overlay.querySelector('#ub-col').textContent = { model: '模型', chat: '会话', day: '日期' }[by];
      body.innerHTML = data.rows?.length ? data.rows.map((row) => `<tr><td>${esc(by === 'chat' ? formatChatTitle(row.key, chatNameOf(row.key)) : row.key)}</td><td class="r">${fmtTok(row.runs)}</td><td class="r">${fmtTok(row.promptTokens)}</td><td class="r">${fmtTok(row.completionTokens)}</td><td class="r">${((row.cacheHitRate || 0) * 100).toFixed(0)}%</td></tr>`).join('') : '<tr><td colspan="5">暂无记录</td></tr>';
    } catch (error) { body.innerHTML = `<tr><td colspan="5">加载失败：${esc(error.message)}</td></tr>`; }
  };
  overlay.querySelectorAll('[data-by]').forEach((button) => button.addEventListener('click', () => {
    by = button.dataset.by;
    overlay.querySelectorAll('[data-by]').forEach((item) => item.classList.toggle('btn-primary', item === button));
    load();
  }));
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('[data-by]').classList.add('btn-primary');
  load();
}

// ── 记忆视图 ──
/** 拉一次提醒 / 风格库状态（记忆页签顶部两张卡与设置页都要用）。失败不抛出。 */
async function refreshReminderState() {
  try {
    state.reminders = await api('/api/reminders');
  } catch { /* 接口不可用时保持旧值 */ }
  return state.reminders;
}
async function refreshStyleState() {
  try {
    state.style = await api('/api/style');
  } catch { /* 同上 */ }
  return state.style;
}

async function loadMemoryView() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
    const files = await api('/api/memory-files');
    // 兼容尚未重启的旧后端：白名单空占位不属于用户产生的记忆。
    state.memoryFiles = (files.files || []).filter((item) => item.memberCount > 0 || item.impressionCount > 0 || item.consolidating);
    state.chats = chats.chats || [];
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey && !state.memoryFiles.some((item) => item.chatKey === state.currentMemoryChatKey)) {
      state.currentMemoryChatKey = null;
      $('#memory-detail').innerHTML = '<div class="empty-hint">暂无聊天群友印象</div>';
    } else if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
let consolidateTicker = null;
function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个详情页（避免打断用户阅读/滚动）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
    renderMemoryList();
  }, 1000);
}

function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何群友印象（等机器人使用记忆工具后才会出现）</div>';
    bindMemoryListClicks(box);
    return;
  }
  box.innerHTML = files.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--color-background-warning)">整理中…</span>`
      : '';
    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount
        ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象`
        : '暂无群友印象');
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}">
        <div class="chat-item-title">
          ${memoryRecordControls(key, names[key] || key)}
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${busyHtml}
          <button class="record-delete" type="button" aria-label="清空 ${esc(names[key] || key)} 的记忆" title="清空这项记忆">×</button>
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span></div>
      </div>`;
  }).join('');
  bindMemoryListClicks(box);
}

function memoryRecordControls(key, label) {
  return `<input class="record-check" type="checkbox" aria-label="选择记忆 ${esc(label)}" ${selectedRecords.memory.has(key) ? 'checked' : ''} />`;
}

/** 顶层记忆列表只管理各聊天的群友印象。 */
function bindMemoryListClicks(box) {
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(el.dataset.key);
    });
    el.querySelector('.record-check')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.checked) selectedRecords.memory.add(el.dataset.key);
      else selectedRecords.memory.delete(el.dataset.key);
    });
    el.querySelector('.record-delete')?.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteUserRecords('memory', { ids: [el.dataset.key] });
    });
  });
}

/**
 * 跨群档案 · 长期记忆详情页。
 * 展示：总览统计 → 人物档案（跨群合并后的事实 + 每个群里的称呼）→ 长期事件。
 */
async function loadGlobalMemoryDetail() {
  const detail = settingsMemoryDetail('memory');
  if (!detail) return;
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  let data;
  try {
    data = await api('/api/memory-global');
    state.globalMemory = data;
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
    return;
  }
  let surface = [];
  try { surface = (await api('/api/memory-global/surface?limit=200')).items || []; } catch { surface = []; }
  if (detail !== settingsMemoryDetail('memory')) return;
  const s = data.stats || {};
  const KIND = { event: '事件', topic: '话题', promise: '约定', joke: '梗', grudge: '恩怨', preference: '偏好' };
  const chatTitle = (k) => (k ? formatChatTitle(k, chatNameOf(k)) : '跨群');

  // 表层记忆：刚说过的话，十来分钟后自动消失；可以手动「存入长期」
  const fmtRemain = (ms) => {
    const n = Math.max(0, Number(ms) || 0);
    if (n <= 0) return '即将过期';
    const m = Math.floor(n / 60000);
    if (m >= 1) return `还剩 ${m} 分钟`;
    const sec = Math.floor(n / 1000);
    return `还剩 ${sec} 秒`;
  };
  const surfaceHtml = surface.length
    ? surface.map((it) => `
        <div style="padding:8px 0;border-bottom:1px solid var(--color-border-tertiary,#3333)">
          <span class="muted" style="font-size:12px">${esc(it.name)}（QQ ${esc(it.userId)}）· ${esc(chatTitle(it.chatKey))} · ${esc(fmtRemain(it.remainMs))}${it.promoted ? ' · <b>已存入长期</b>' : ''}</span>
          <div>${esc(it.text)}</div>
          <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-small gm-sf-promote" data-id="${esc(it.id)}"${it.promoted ? ' disabled' : ''}>存入长期</button>
            <button class="btn btn-small gm-sf-del" data-id="${esc(it.id)}">删除</button>
          </div>
        </div>`).join('')
    : '<div class="muted" style="padding:10px">暂无。最近几分钟内有人说话（含私聊）就会出现在这里，超过保留时长自动消失。</div>';

  const peopleHtml = (data.people || []).length
    ? data.people.map((p) => `
        <div style="padding:10px 0;border-bottom:1px solid var(--color-border-tertiary,#3333)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
            <strong>${esc(p.name)}</strong>
            <span class="muted" style="font-size:12px">QQ ${esc(p.userId)} · 见于 ${p.chats.length} 个会话 · ${p.facts.length} 条事实</span>
          </div>
          ${Object.entries(p.names || {}).map(([k, v]) => `<div class="muted" style="font-size:12px">${esc(chatTitle(k))}：${esc(v)}</div>`).join('')}
          ${(p.facts || []).map((f) => `
            <div style="margin-top:5px">
              <span class="muted" style="font-size:12px">[重要度 ${f.importance}${f.weight < 0.3 ? ' · 快淡忘了' : ''}]</span>
              ${esc(f.content)}
              ${(f.from || []).length ? `<span class="muted" style="font-size:12px">（记于 ${f.from.map((k) => esc(chatTitle(k))).join('、')}）</span>` : ''}
            </div>`).join('')}
        </div>`).join('')
    : '<div class="muted" style="padding:10px">还没有跨群人物档案。等机器人记下某个群友的印象，并自动按 QQ 号归入跨群档案。</div>';

  const eventsHtml = (data.events || []).length
    ? data.events.map((e) => `
        <div style="padding:8px 0;border-bottom:1px solid var(--color-border-tertiary,#3333)">
          <span class="muted" style="font-size:12px">[${KIND[e.kind] || esc(e.kind)}] ${esc(chatTitle(e.chatKey || e.origin))}${e.scope === 'global' ? ' · <b>跨群跟人走</b>' : ''} · 重要度 ${e.importance}${e.resolved ? ' · 已翻篇' : ''}</span>
          <div>${esc(e.text)}</div>
          <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-small gm-ev-scope" data-id="${esc(e.id)}" data-scope="${e.scope === 'global' ? 'chat' : 'global'}"
              title="${e.scope === 'global' ? '收回成只在这个会话里生效' : '改成跟人走：这个人出现在哪个会话都能想起来'}">${e.scope === 'global' ? '改为仅本会话' : '改为跨群跟人走'}</button>
            <button class="btn btn-small gm-ev-del" data-id="${esc(e.id)}">删除</button>
          </div>
        </div>`).join('')
    : '<div class="muted" style="padding:10px">还没有长期事件。跑一轮「整理本群记忆」会自动抽取，机器人也可以在聊天里主动记。</div>';

  detail.innerHTML = `
    <div class="detail-header">
      <h2>🌐 跨群档案 · 长期记忆</h2>
      <div class="sub">
        <span>同一个 QQ 号在不同群是同一个人；这一层跨所有会话生效，与每个群自己的群友印象互补。</span>
        <button class="btn btn-small" id="mem-global-refresh">刷新</button>
      </div>
    </div>
    <div class="muted" style="margin:10px 0">
      人物 ${s.people ?? 0} · 事实 ${s.facts ?? 0} · 长期事件 ${s.events ?? 0}（本群 ${s.chatEvents ?? 0} / 跨群 ${s.globalEvents ?? 0}）· 覆盖 ${s.chats ?? 0} 个会话 · 表层 ${s.surface ?? 0}
    </div>
    <div class="hint" style="margin-bottom:14px">
      最弱的记忆权重 ${s.weakestWeight ?? '-'}（低于淡出阈值会被遗忘清理淘汰）·
      ${s.lastDecayAt ? `上次清理 ${fmtTime(s.lastDecayAt)}` : '尚未跑过遗忘清理'}。
      开关与阈值在本页下方。
    </div>
    <h3>⏳ 表层记忆（刚说过的话，${surface.length}）</h3>
    <div class="muted" style="font-size:12px;margin-bottom:4px">
      限时暂存：任何会话（含私聊）刚说的话都进这里，机器人能立刻在别的会话复述。
      到时间自动消失；点「存入长期」才会长期保留。
    </div>
    ${surfaceHtml}
    <h3>人物档案（${(data.people || []).length}）</h3>
    ${peopleHtml}
    <h3 style="margin-top:18px">长期事件（${(data.events || []).length}）</h3>
    ${eventsHtml}`;
  $('#mem-global-refresh')?.addEventListener('click', () => loadGlobalMemoryDetail());
  // 作用域一键切换：自动抽取难免判错，给管理员一个当场修的机会
  $$('.gm-ev-scope', detail).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`/api/memory-global/events/${b.dataset.id}`, {
        method: 'PATCH', body: JSON.stringify({ scope: b.dataset.scope })
      });
      await loadGlobalMemoryDetail();
    } catch (e) { b.disabled = false; alert(`修改失败：${e.message}`); }
  }));
  $$('.gm-ev-del', detail).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`/api/memory-global/events/${b.dataset.id}`, { method: 'DELETE' });
      await loadGlobalMemoryDetail();
    } catch (e) { b.disabled = false; alert(`删除失败：${e.message}`); }
  }));
  // 表层记忆：存入长期（沉淀成长期事件，跨群跟人走）
  $$('.gm-sf-promote', detail).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('/api/memory-global/surface/promote', {
        method: 'POST', body: JSON.stringify({ id: b.dataset.id, as: 'event', importance: 4 })
      });
      await loadGlobalMemoryDetail();
    } catch (e) { b.disabled = false; alert(`存入长期失败：${e.message}`); }
  }));
  $$('.gm-sf-del', detail).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`/api/memory-global/surface/${b.dataset.id}`, { method: 'DELETE' });
      await loadGlobalMemoryDetail();
    } catch (e) { b.disabled = false; alert(`删除失败：${e.message}`); }
  }));
}

/**
 * ⏰ 定时提醒详情页。
 * 管理端能做的事：看（含错过/已完成）、新建（手工）、改时间、立即提醒、取消、删除。
 */
async function loadRemindersDetail() {
  const detail = settingsMemoryDetail('reminder');
  if (!detail) return;
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  await refreshReminderState();
  if (detail !== settingsMemoryDetail('reminder')) return;
  const data = state.reminders;
  if (!data) {
    detail.innerHTML = '<div class="empty-hint">加载失败：提醒接口不可用</div>';
    return;
  }
  const st = data.stats || {};
  const FILTERS = [
    ['open', '待触发'],
    ['missed', '错过'],
    ['done', '已完成'],
    ['canceled', '已取消'],
    ['all', '全部']
  ];
  const filter = state.reminderFilter || 'open';
  const items = (data.items || []).filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'open') return e.status === 'pending' || e.status === 'running';
    return e.status === filter;
  });
  const STATUS_TEXT = { pending: '待触发', running: '正在发', done: '已完成', canceled: '已取消', missed: '错过' };
  const chats = (state.chats || []).map((c) => c.key);
  const rows = items.length
    ? items.map((e) => `
      <div style="padding:10px 0;border-bottom:1px solid var(--color-border-tertiary,#3333)">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
          <div>
            <span class="muted" style="font-size:12px">[${STATUS_TEXT[e.status] || esc(e.status)}]</span>
            <b>${esc(fmtDateTime(e.dueAt))}</b>
            <span class="muted" style="font-size:12px">${esc(chatNameOf(e.chatKey))}${e.targetName ? ` · 私聊 ${esc(e.targetName)}` : ''} · ${esc(repeatLabelUi(e.repeat))}${e.firedCount ? ` · 已触发 ${e.firedCount} 次` : ''}${e.source === 'manual' ? ' · 手工添加' : ''}</span>
          </div>
        </div>
        <div style="margin-top:4px">${esc(e.text)}</div>
        ${e.note ? `<div class="muted" style="font-size:12px">备注：${esc(e.note)}</div>` : ''}
        ${e.creatorName || e.creatorId ? `<div class="muted" style="font-size:12px">来自 ${esc(e.creatorName || e.creatorId)}</div>` : ''}
        ${e.lastError ? `<div class="hint" style="color:var(--color-text-danger,#f66)">${esc(e.lastError)}</div>` : ''}
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          ${e.status === 'pending' || e.status === 'running' ? `
            <button class="btn btn-small rem-fire" data-id="${esc(e.id)}" title="不等时间，立刻提醒一次">立即提醒</button>
            <button class="btn btn-small rem-edit" data-id="${esc(e.id)}" data-text="${esc(e.text)}" data-when="${esc(fmtDateTime(e.dueAt))}">改时间</button>
            <button class="btn btn-small rem-cancel" data-id="${esc(e.id)}">取消</button>` : `
            <button class="btn btn-small rem-reopen" data-id="${esc(e.id)}" title="改回待触发（时间保持原样）">恢复待触发</button>`}
          <button class="btn btn-small rem-del" data-id="${esc(e.id)}">删除</button>
        </div>
      </div>`).join('')
    : '<div class="muted" style="padding:10px">这个分类下没有记录。</div>';

  detail.innerHTML = `
    <div class="detail-header">
      <h2>⏰ 定时提醒</h2>
      <div class="sub">
        <span>她自己答应下来的提醒也在这里；到点会由调度器把她叫醒，用她的语气主动发消息。</span>
        <button class="btn btn-small" id="rem-refresh">刷新</button>
      </div>
    </div>
    <div class="muted" style="margin:10px 0">
      ${st.enabled === false ? '<b>功能已关闭</b>（设置 → 记忆 → 定时提醒）· ' : ''}
      待触发 ${st.pending ?? 0} · 正在发 ${st.running ?? 0} · 错过 ${st.missed ?? 0} · 已完成 ${st.done ?? 0} · 已取消 ${st.canceled ?? 0}
      ${st.nextDueAt ? ` · 下一条 ${esc(fmtDateTime(st.nextDueAt))}` : ''}
    </div>
    <h3>新建提醒（手工）</h3>
    <div class="field-row">
      <div class="field"><label>提醒内容</label><input type="text" id="rem-new-text" placeholder="例如：记得吃降压药" /></div>
      <div class="field"><label>时间</label><input type="text" id="rem-new-when" placeholder="2026-09-13 08:00 / 08:00 / 30分钟后" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>在哪个会话提醒</label>
        <select id="rem-new-chat">
          ${chats.map((k) => `<option value="${esc(k)}">${esc(formatChatTitle(k, chatNameOf(k)))}</option>`).join('') || '<option value="">（还没有可用会话）</option>'}
        </select></div>
      <div class="field"><label>重复</label>
        <select id="rem-new-repeat">
          <option value="none">一次性</option>
          <option value="daily">每天同一时刻</option>
          <option value="weekly">每周（按该时间点的星期）</option>
          <option value="interval">每隔一段时间（按间隔小时）</option>
        </select></div>
      <div class="field"><label>间隔小时（仅"每隔"用）</label><input type="number" id="rem-new-every" min="1" step="1" value="24" /></div>
      <div class="field" style="align-self:flex-end"><button class="btn btn-small btn-primary" id="rem-new-btn">添加</button></div>
    </div>
    <div class="hint" id="rem-new-result" style="margin-bottom:12px"></div>

    <h3>提醒列表</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
      ${FILTERS.map(([id, label]) => `<button class="btn btn-small rem-filter ${filter === id ? 'btn-primary' : ''}" data-filter="${id}">${label}</button>`).join('')}
    </div>
    ${rows}`;

  const out = () => $('#rem-new-result');
  $('#rem-refresh')?.addEventListener('click', () => loadRemindersDetail());
  $$('.rem-filter', detail).forEach((b) => b.addEventListener('click', () => {
    state.reminderFilter = b.dataset.filter;
    loadRemindersDetail();
  }));
  const newBtn = $('#rem-new-btn');
  if (newBtn) newBtn.addEventListener('click', async () => {
    const text = ($('#rem-new-text')?.value || '').trim();
    const when = ($('#rem-new-when')?.value || '').trim();
    const chatKey = $('#rem-new-chat')?.value || '';
    const kind = $('#rem-new-repeat')?.value || 'none';
    if (!text || !when || !chatKey) { if (out()) out().textContent = '提醒内容、时间、会话都要填'; return; }
    const repeat = kind === 'interval'
      ? { kind, intervalMs: Math.max(1, Number($('#rem-new-every')?.value) || 24) * 3600000 }
      : { kind };
    newBtn.disabled = true;
    try {
      await api('/api/reminders', { method: 'POST', body: JSON.stringify({ text, when, chatKey, repeat }) });
      await loadRemindersDetail();
      if (out()) out().textContent = '已添加';
    } catch (e) {
      if (out()) out().textContent = `失败：${e.message}`;
    } finally { newBtn.disabled = false; }
  });
  $$('.rem-fire', detail).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    if (out()) out().textContent = '正在触发…（会调一次模型，稍等几秒）';
    try {
      await api(`/api/reminders/${b.dataset.id}/fire`, { method: 'POST', body: JSON.stringify({}) });
      if (out()) out().textContent = '已触发：去看看会话页/存档里她发了什么';
      await loadRemindersDetail();
    } catch (e) { if (out()) out().textContent = `失败：${e.message}`; b.disabled = false; }
  }));
  $$('.rem-edit', detail).forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id;
    openTextPromptModal({
      head: '改提醒时间',
      label: '改成什么时间？',
      value: b.dataset.when || '',
      placeholder: '2026-09-13 08:00 / 08:00 / 30分钟后',
      hint: '支持 2026-09-13 08:00、08:00、30分钟后 三种写法。',
      okText: '改时间',
      onOk: async (when) => {
        if (!when) throw new Error('时间不能为空');
        await api(`/api/reminders/${id}`, { method: 'PATCH', body: JSON.stringify({ when }) });
        await loadRemindersDetail();
      }
    });
  }));
  $$('.rem-cancel', detail).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/reminders/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'canceled' }) });
      await loadRemindersDetail();
    } catch (e) { alert(`取消失败：${e.message}`); }
  }));
  $$('.rem-reopen', detail).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/reminders/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) });
      await loadRemindersDetail();
    } catch (e) { alert(`恢复失败：${e.message}`); }
  }));
  $$('.rem-del', detail).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除这条提醒？删掉就找不回来了。')) return;
    try {
      await api(`/api/reminders/${b.dataset.id}`, { method: 'DELETE' });
      await loadRemindersDetail();
    } catch (e) { alert(`删除失败：${e.message}`); }
  }));
}

/**
 * 🗣 说话风格库详情页：学到的条目 + 最近样本 + 手动补一条。
 */
async function loadStyleDetail() {
  const detail = settingsMemoryDetail('style');
  if (!detail) return;
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  await refreshStyleState();
  if (detail !== settingsMemoryDetail('style')) return;
  const data = state.style;
  if (!data) {
    detail.innerHTML = '<div class="empty-hint">加载失败：风格接口不可用</div>';
    return;
  }
  const st = data.stats || {};
  const items = data.items || [];
  const speech = items.filter((e) => e.kind === 'speech');
  const reactions = items.filter((e) => e.kind === 'reactions');
  const chatRows = Object.entries(st.byChat || {}).map(([k, v]) => `${esc(chatNameOf(k))}（说话 ${v.speech} / 反应 ${v.reaction}）`).join('、');
  const itemRow = (e) => `
    <div style="padding:8px 0;border-bottom:1px solid var(--color-border-tertiary,#3333);display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
      <div>
        <span class="muted" style="font-size:12px">[命中 ${e.hits}${e.pinned ? ' · 已置顶' : ''}${e.source === 'model' ? ' · 她自己的观察' : e.source === 'manual' ? ' · 手工添加' : ''}]</span>
        ${esc(e.text)}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-small st-pin" data-id="${esc(e.id)}" data-pin="${e.pinned ? '0' : '1'}">${e.pinned ? '取消置顶' : '置顶'}</button>
        <button class="btn btn-small st-del" data-id="${esc(e.id)}">删除</button>
      </div>
    </div>`;
  const sampleRows = (data.samples || []).length
    ? (data.samples || []).slice().reverse().slice(0, 30).map((s) => `
        <div class="muted" style="font-size:12px;padding:2px 0">
          ${esc(fmtDateTime(s.ts))} · ${esc(chatNameOf(s.chatKey))} · ${s.kind === 'speech' ? '说话' : '反应'}：${esc(s.text)}
        </div>`).join('')
    : '<div class="muted">还没有样本。</div>';

  detail.innerHTML = `
    <div class="detail-header">
      <h2>🗣 说话风格库</h2>
      <div class="sub">
        <span>从本机真人聊天记录里学到的语感规律，只作为她说话时的参考（开关在「设置 → 记忆 → 说话风格库」）。</span>
        <button class="btn btn-small" id="st-refresh">刷新</button>
      </div>
    </div>
    <div class="muted" style="margin:10px 0">
      ${st.enabled !== true ? '<b>当前未开启</b> · ' : (st.collecting ? '正在采集 · ' : '已暂停采集 · ')}
      样本 ${st.samples ?? 0} 条（待蒸馏 ${st.pendingSamples ?? 0}）· 说话逻辑 ${st.speechItems ?? 0} 条 · 图片表情反应 ${st.reactionItems ?? 0} 条
      ${st.distilledAt ? ` · 上次学习 ${esc(fmtTime(st.distilledAt))}` : ''}
    </div>
    ${chatRows ? `<div class="hint" style="margin-bottom:10px">样本来源：${chatRows}</div>` : ''}
    ${st.lastError ? `<div class="hint" style="color:var(--color-text-danger,#f66)">上次蒸馏失败：${esc(st.lastError)}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button class="btn btn-small btn-primary" id="st-distill">立即学习一次</button>
      <button class="btn btn-small" id="st-clear-samples">清空样本池</button>
      <button class="btn btn-small" id="st-clear-profile">清空风格库</button>
      <span class="muted" id="st-op-result"></span>
    </div>

    <h3>说话逻辑（${speech.length}）</h3>
    ${speech.length ? speech.map(itemRow).join('') : '<div class="muted" style="padding:8px 0">还没有学到。开总开关，让群里多聊几句，或点「立即学习一次」。</div>'}
    <h3 style="margin-top:16px">图片 / 表情反应（${reactions.length}）</h3>
    ${reactions.length ? reactions.map(itemRow).join('') : '<div class="muted" style="padding:8px 0">还没有学到。有人发图、真人跟着回话之后就会攒出样本。</div>'}

    <h3 style="margin-top:16px">手工补一条</h3>
    <div class="field-row">
      <div class="field"><label>类型</label>
        <select id="st-new-kind"><option value="speech">说话逻辑</option><option value="reactions">图片/表情反应</option></select></div>
      <div class="field"><label>内容（写"怎么说"，不要写"说了什么"）</label>
        <input type="text" id="st-new-text" placeholder="例如：夸人一般就回一个 6" /></div>
      <div class="field" style="align-self:flex-end"><button class="btn btn-small" id="st-new-btn">添加</button></div>
    </div>

    <h3 style="margin-top:16px">最近的样本（最多 30 条）</h3>
    ${sampleRows}`;

  const out = () => $('#st-op-result');
  $('#st-refresh')?.addEventListener('click', () => loadStyleDetail());
  const distill = $('#st-distill');
  if (distill) distill.addEventListener('click', async () => {
    distill.disabled = true;
    if (out()) out().textContent = '正在学习（要调一次模型）…';
    try {
      const r = await api('/api/style/distill', { method: 'POST', body: JSON.stringify({ force: true }) });
      await loadStyleDetail();
    } catch (e) {
      if (out()) out().textContent = `失败：${e.message}`;
      distill.disabled = false;
    }
  });
  $('#st-clear-samples')?.addEventListener('click', async () => {
    if (!confirm('清空样本池？')) return;
    try { await api('/api/style/samples', { method: 'DELETE' }); await loadStyleDetail(); }
    catch (e) { if (out()) out().textContent = `失败：${e.message}`; }
  });
  $('#st-clear-profile')?.addEventListener('click', async () => {
    if (!confirm('清空风格库？她将忘掉学到的说话方式。')) return;
    try { await api('/api/style/profile', { method: 'DELETE' }); await loadStyleDetail(); }
    catch (e) { if (out()) out().textContent = `失败：${e.message}`; }
  });
  const addBtn = $('#st-new-btn');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const text = ($('#st-new-text')?.value || '').trim();
    if (!text) { if (out()) out().textContent = '内容不能为空'; return; }
    try {
      await api('/api/style/items', {
        method: 'POST',
        body: JSON.stringify({ kind: $('#st-new-kind')?.value || 'speech', text })
      });
      await loadStyleDetail();
    } catch (e) { if (out()) out().textContent = `失败：${e.message}`; }
  });
  $$('.st-pin', detail).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/style/items/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: b.dataset.pin === '1' }) });
      await loadStyleDetail();
    } catch (e) { alert(`置顶失败：${e.message}`); }
  }));
  $$('.st-del', detail).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/style/items/${b.dataset.id}`, { method: 'DELETE' });
      await loadStyleDetail();
    } catch (e) { alert(`删除失败：${e.message}`); }
  }));
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
    const notes = cfg.memberNotes || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const members = Array.isArray(mem.members) ? mem.members : [];
    const membersHtml = kind === 'group'
      ? `<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>`
      : '';
    const rows = members.map((m) => {
      const who = notes[String(m.userId)] || m.name || m.userId || '某人';
      const qq = m.userId ? ` <span class="muted">(QQ ${esc(m.userId)})</span>` : '';
      const imps = m.impressions.map((e) => `- ${e.content}`).join('\n');
      return `<div class="collapsible" open>
        <summary>${esc(who)}${qq}（${m.impressions.length} 条）
          <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:8px">编辑</button>
          <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
        </summary>
        <div class="coll-body">${esc(imps)}</div>
      </div>`;
    }).join('');
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => loadGroupMembers(chatId, chatKey));
    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openMemberImpressModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name, impressions: [] });
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));
    // 针对单个群友更新记忆：有印象→整理合并；无印象→从聊天记录提炼
    $$('.mem-refresh-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        if (!/^\d{1,15}$/.test(uid)) { alert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
        el.disabled = true;
        const old = el.textContent;
        el.textContent = '更新中…';
        // 同样记进 state，切页签回来后仍能看到进行中
        state.consolidating[chatKey] = { startedAt: Date.now() };
        delete state.consolidateResult[chatKey];
        startConsolidateTicker();
        renderMemoryList();
        try {
          await api('/api/memory-files/consolidate', {
            method: 'POST',
            body: JSON.stringify({ chatKey, userIds: [uid] })
          });
          el.textContent = '已提交 ✓';
        } catch (err) {
          el.textContent = '失败';
          alert(`更新记忆失败：${err.message}`);
        }
        setTimeout(() => { el.disabled = false; el.textContent = old; }, 2500);
      });
    });
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友印象：${note || name || userId}` : '添加群友印象',
    body: `
      ${isEdit ? `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="mi-qq" value="${esc(userId)}" readonly /></div>
        <div class="field"><label>QQ 昵称</label><input type="text" id="mi-nickname" value="${esc(name)}" readonly /></div>
        <div class="field"><label>群内昵称</label><input type="text" id="mi-card" value="${esc(member?.card || '')}" readonly /></div>
      </div>
      <div class="field"><label>QQ agent 对群友的当前备注</label><input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则使用原群名片/昵称" /></div>` : `
      <div class="field"><label>QQ 号（必填）</label><input type="text" id="mi-qq" value="${esc(userId)}" /></div>
      <div class="field"><label>名字（备注名/群名片/昵称）</label><input type="text" id="mi-name" value="${esc(name)}" /></div>`}
      <div class="field"><label>印象内容（一行一条；留空 = 删除该成员全部印象）</label><textarea id="mi-imps" style="min-height:160px" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea></div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!/^\d{1,15}$/.test(qq)) { alert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines })
      });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除 ${note || name || userId} 的全部印象？`)) return;
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: '{}' });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<div class="collapsible" open><summary>群成员（${state.groupMembers.length} 人）</summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(m.userId)}</td>
            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></div>`;
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${oldNote || displayName || qq}`,
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    if (name) nextNotes[String(qq)] = name; else delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}
async function loadSettings() {
  const [cfg, tplData, provData, visionData, persData, globalData, reminderData, styleData, chatsData, catalogData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/personas').catch(() => ({ personas: [], activeId: '' })),
    api('/api/memory-global').catch(() => null),
    api('/api/reminders').catch(() => null),
    api('/api/style').catch(() => null),
    api('/api/chats').catch(() => ({ chats: [] })),
    api('/api/model-catalog').catch(() => ({ vendors: [] }))
  ]);
  state.config = cfg;
  state.providers = provData.providers || [];
  state.modelCatalog = catalogData.vendors || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  state.personas = persData.personas || [];
  state.personaActiveId = persData.activeId || '';
  state.globalMemory = globalData;
  state.reminders = reminderData;
  state.style = styleData;
  state.chats = chatsData.chats || [];
  renderSettings();
}

function renderPersonaPicker() {
  return `
    <div class="field">
      <label>人设（每个人设一套完全独立的记忆）</label>
      <div id="persona-list"><span class="muted">加载中…</span></div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-small" id="persona-refresh-btn">刷新</button>
        <button class="btn btn-small" id="persona-new-btn">＋ 新建空白人设</button>
        <button class="btn btn-small" id="persona-distill-btn">🎭 角色蒸馏</button>
      </div>
      <div class="hint" style="margin-top:6px">
        切换人设会<strong>连记忆一起切换</strong>：群友印象、跨群档案、长期事件按人设分别存放
        （<code>data/memory/&lt;人设目录&gt;/</code>），互不可见 —— 新人设从零开始，不认识上一个人设认识的人。
      </div>
      <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
    </div>`;
}

/** 人设列表：显示各自占用的记忆规模，让"哪份记忆属于谁"一眼可见。 */
function renderPersonaList() {
  const box = $('#persona-list');
  if (!box) return;
  const list = state.personas || [];
  if (!list.length) {
    box.innerHTML = '<span class="muted">人设列表为空</span>';
    return;
  }
  box.innerHTML = list.map((p) => {
    const s = p.stats || {};
    const memLine = `${s.chats || 0} 个会话 · ${s.impressions || 0} 条群友印象 · ${s.people || 0} 人跨群档案 · ${s.events || 0} 件长期事件`;
    return `
      <div class="persona-row" style="display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--color-border-tertiary,#3333);border-radius:6px;margin-bottom:6px;${p.active ? 'border-color:var(--color-border-info,#4a9);' : ''}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:6px;align-items:baseline;flex-wrap:wrap">
            <strong>${esc(p.name)}</strong>
            ${p.builtin ? '<span class="muted" style="font-size:12px">[内置]</span>' : ''}
            ${p.active ? '<span class="unread-pill" style="font-size:11px">使用中</span>' : ''}
          </div>
          <div class="muted" style="font-size:12px">记忆：${esc(memLine)}</div>
          <div class="muted" style="font-size:12px">目录 data/memory/${esc(p.memoryKey)}/ · 角色卡 ${p.textLength} 字</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          ${p.active ? '' : `<button class="btn btn-small persona-switch" data-id="${esc(p.id)}" data-name="${esc(p.name)}">切换</button>`}
          ${p.builtin ? '' : `<button class="btn btn-small persona-rename" data-id="${esc(p.id)}" data-name="${esc(p.name)}">改名</button>`}
          ${(p.builtin || p.active) ? '' : `<button class="btn btn-small persona-absorb" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="把这个角色的两份并成一份">并入…</button>`}
          ${(p.builtin || p.active) ? '' : `<button class="btn btn-small btn-danger persona-del" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-mem="${esc(memLine)}">删除</button>`}
        </div>
      </div>`;
  }).join('');

  $$('.persona-switch', box).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('/api/personas/active', { method: 'POST', body: JSON.stringify({ id: b.dataset.id }) });
      await loadSettings();
      const hint = $('#persona-pick-hint');
      if (hint) hint.textContent = `已切换到「${b.dataset.name}」。这个人的记忆是它自己那一份，与刚才那个完全隔离。`;
    } catch (e) {
      b.disabled = false;
      alert(`切换失败：${e.message}`);
    }
  }));

  $$('.persona-rename', box).forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id;
    const oldName = b.dataset.name || '';
    openTextPromptModal({
      head: '人设改名',
      label: '人设新名字',
      value: oldName,
      okText: '改名',
      onOk: async (name) => {
        if (!name) throw new Error('名字不能为空');
        if (name === oldName) return false;      // 没改，什么都不做
        await api(`/api/personas/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
        await loadPersonas();
      }
    });
  }));

  $$('.persona-absorb', box).forEach((b) => b.addEventListener('click', () => openPersonaAbsorbModal(b.dataset.id, b.dataset.name)));

  $$('.persona-del', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`删除人设「${b.dataset.name}」？\n\n它名下的记忆（${b.dataset.mem}）会保留在磁盘上，不会跟着删掉，\n但界面上将不再显示。内置人设与正在使用的人设不能删除。`)) return;
    b.disabled = true;
    try {
      await api(`/api/personas/${b.dataset.id}`, { method: 'DELETE' });
      await loadPersonas();
    } catch (e) { b.disabled = false; alert(`删除失败：${e.message}`); }
  }));
}

/** 「并入…」：把这个角色的两份合成一份，并选择并入谁。 */
async function openPersonaAbsorbModal(sourceId, sourceName) {
  await loadPersonas();
  const targets = (state.personas || []).filter((p) => p.id !== sourceId);
  if (!targets.length) { alert('没有可并入的其他人设'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:620px;width:92vw">
      <div class="modal-head">把人设「${esc(sourceName)}」并入…</div>
      <div style="padding:12px 16px">
        <div class="hint" style="margin-bottom:10px">
          合并规则：目标<b>没有记忆</b>时会接管这份记忆；两边都有记忆会被拒绝（避免混成一团）。
          被合并的记录会从列表移除，它的记忆目录留在磁盘上不删。
          如果被合并的正是"当前使用中"的那份，目标会连角色卡一起继承。
        </div>
        <div class="modal-list" style="max-height:300px">
          ${targets.map((p) => `
            <label class="pick-item">
              <input type="radio" name="absorb-target" value="${esc(p.id)}" ${p.active ? 'checked' : ''} />
              <span>${esc(p.name)}${p.builtin ? ' [内置]' : ''}${p.active ? ' （当前使用）' : ''}</span>
              <span class="muted">${p.stats.chats} 会话 / ${p.stats.people} 人</span>
            </label>`).join('')}
        </div>
        <div id="absorb-status" class="muted" style="margin-top:10px"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="absorb-run">确认合并</button>
        <button class="btn" id="absorb-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#absorb-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#absorb-run', overlay).addEventListener('click', async () => {
    const sel = $$('input[name=absorb-target]', overlay).find((el) => el.checked);
    if (!sel) { $('#absorb-status', overlay).textContent = '请选择要并入的人设'; return; }
    const btn = $('#absorb-run', overlay);
    btn.disabled = true;
    $('#absorb-status', overlay).textContent = '合并中…';
    try {
      await api(`/api/personas/${sel.value}/absorb`, { method: 'POST', body: JSON.stringify({ fromId: sourceId }) });
      overlay.remove();
      await loadSettings();
      const hint = $('#persona-pick-hint');
      if (hint) hint.textContent = `已把「${sourceName}」并入所选人设，记忆已归到它名下。`;
    } catch (e) {
      btn.disabled = false;
      $('#absorb-status', overlay).textContent = `合并失败：${e.message}`;
    }
  });
}

/** 单独刷新人设库（不重建整个设置页）。 */
async function loadPersonas() {
  try {
    const d = await api('/api/personas');
    state.personas = d.personas || [];
    state.personaActiveId = d.activeId || '';
  } catch { state.personas = []; }
  renderPersonaList();
}

async function switchPersonaById(id, name) {
  await api('/api/personas/active', { method: 'POST', body: JSON.stringify({ id }) });
  await loadSettings();
  const hint = $('#persona-pick-hint');
  if (hint) hint.textContent = `已切换到「${name}」。`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>
    <div class="hint">「保存人设修改」只改<strong>当前使用中</strong>的那个人设；改了角色卡再切走，切回来仍是新内容。</div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">打开 SnowLuma 设置</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  // 旧文案指向的"从 DSH 导入"功能早已移除，这里改成能实际操作的指引
  if (!provs.length) {
    return '<div class="muted" style="padding:10px;font-size:12px;line-height:1.7">'
      + '目录还是空的。先在右边「手动添加提供商」填上接口地址和 API Key，'
      + '点「获取列表」拉取模型，或直接手动填模型 id 后点「确认添加」。'
      + '不知道去哪弄？DeepSeek、智谱、Kimi、OpenAI 等官网的开放平台都能申请到 Key。'
      + '</div>';
  }
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新从 DSH 导入。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey) {
    $('#cfg-apikey').value = '******';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('该提供商已保存密钥（显示为 ******，点「显示」查看明文，输入新 Key 可替换）');
  } else {
    $('#cfg-apikey').value = '';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  if (p.anthropicOrigin) notes.push('DSH 中为 Anthropic 协议，已按 OpenAI 兼容模式调用，若报错请换用其他模型');
  const vr = (state.visionResults || {})[`${pid}|||${model}`];
  if (vr && (vr.verdict === 'vision' || vr.verdict === 'no-vision')) {
    notes.push(vr.verdict === 'vision' ? '✅ 该模型支持图片输入' : '🚫 该模型不支持图片输入');
  }
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['api', '模型 API'],
    ['search', '搜索服务'],
    ['image', '搜图服务'],
    ['memory', '记忆'],
    ['meme', '梗知识库'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['chat', '聊天设置'],
    ['desktop', '桌面端'],
    ['onebot', 'SnowLuma · OneBot'],
    ['about', '关于']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => id === 'memory'
        ? `<button class="settings-menu-item ${['memory', 'reminder', 'style'].includes(state.settingsSection) ? 'active' : ''}" data-section="memory" aria-expanded="${state.settingsMemoryExpanded}">${label} <span aria-hidden="true">${state.settingsMemoryExpanded ? '⌄' : '›'}</span></button>
           ${state.settingsMemoryExpanded ? `<div class="settings-submenu">
             <button class="settings-menu-item ${state.settingsSection === 'memory' ? 'active' : ''}" data-section="memory">跨群档案 · 长期记忆</button>
             <button class="settings-menu-item ${state.settingsSection === 'reminder' ? 'active' : ''}" data-section="reminder">定时提醒</button>
             <button class="settings-menu-item ${state.settingsSection === 'style' ? 'active' : ''}" data-section="style">说话风格库</button>
           </div>` : ''}`
        : `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.section === 'memory' && !el.closest('.settings-submenu')) {
        state.settingsMemoryExpanded = !state.settingsMemoryExpanded;
      }
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
  if (state.settingsSection === 'onebot') loadSnowlumaPage({ quiet: true });
  if (state.settingsSection === 'about') loadAboutInfo();
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    image: () => renderImageSearchSection(c),
    memory: () => renderMemorySettingsSection(c),
    reminder: () => renderReminderSection(c),
    style: () => renderStyleSection(c),
    meme: () => renderMemeSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c),
    about: () => renderAboutSection()
  };
  const render = sections[sec] || sections.api;
  return `
    ${sec === 'about' ? '' : `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>`}
    <div class="settings-content-card">${render()}</div>`;
}

function renderAboutSection() {
  return `<div class="about-intro"><div class="logo-mark" aria-hidden="true">◈</div><div><h2>QQ Agent</h2><span class="about-version" id="about-version">${esc(state.appInfo?.displayVersion || 'v0.5alpha')}</span></div></div>
    <p id="about-description">${esc(state.appInfo?.description || '基于 Kondius 的 QQ Agent 开发，由 wraaaaaa 维护。')}</p>
    <p class="hint">简洁的 QQ 机器人控制台 · MIT 开源许可</p>
    <section class="factory-reset-card" aria-labelledby="factory-reset-title"><h3 id="factory-reset-title">项目初始化</h3>
      <p>清除全部项目配置和使用数据，恢复为等待配置的全新状态。</p>
      <ul><li>所有 API 密钥、接口地址、自定义供应商和搜索/搜图源</li>
      <li>人设、白名单及全部用户设置，恢复默认值</li><li>聊天、会话、记忆、提醒、风格、梗库、表情缓存、用量、日志和旧配置备份</li>
      <li>内置 SnowLuma 的配置、账号数据及日志，断开机器人连接</li></ul>
      <p class="hint">确认后应用自动重启；程序、依赖和内置素材保留。电脑 QQ 客户端自身的登录不属于项目数据，不会删除。此操作无法撤销。</p>
      <button type="button" class="btn btn-danger" id="factory-reset-btn">初始化全部内容</button>
      <div id="factory-reset-result" class="hint" role="status" aria-live="polite"></div></section>`;
}

async function loadAboutInfo() {
  try {
    const info = await api('/api/version');
    state.appInfo = info;
    const version = $('#about-version');
    if (version) version.textContent = info.displayVersion || `v${info.version}`;
    const description = $('#about-description');
    if (description && info.description) description.textContent = info.description;
  } catch (error) {
    const result = $('#factory-reset-result');
    if (result) result.textContent = `版本信息读取失败：${error.message}`;
  }
}

function confirmFactoryResetFirst() {
  return new Promise(resolve => {
    const overlay = modelModalShell({ head: '初始化全部内容 · 第一次确认', danger: true,
      body: '<p>将删除所有 API 和用户配置，以及聊天、记忆、用量和内置 SnowLuma 数据，恢复首次配置状态。</p><p>不能撤销。电脑 QQ 客户端自身的登录文件保留。</p>',
      foot: '<button class="btn" id="reset-first-cancel">取消</button><button class="btn btn-danger" id="reset-first-next">继续，进入二次确认</button>' });
    const finish = accepted => { closeModelModal(overlay); resolve(accepted); };
    overlay.querySelector('#reset-first-next').addEventListener('click', () => finish(true));
    overlay.querySelector('#reset-first-cancel').addEventListener('click', () => finish(false));
    overlay.querySelector('.model-modal-close').addEventListener('click', () => finish(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') finish(false); });
    overlay.querySelector('#reset-first-cancel').focus();
  });
}

async function requestFactoryReset() {
  const button = $('#factory-reset-btn');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    if (!(await confirmFactoryResetFirst())) return;
    const challenge = await api('/api/factory-reset/prepare', { method: 'POST', body: '{}' });
    const overlay = modelModalShell({ head: '初始化全部内容 · 第二次确认', danger: true,
      body: `<p>即将清除：${esc(challenge.scope)}。</p><div class="field"><label for="reset-confirmation">请输入“初始化”，再点击下方按钮</label><input id="reset-confirmation" type="text" autocomplete="off" placeholder="初始化" /></div><p class="hint">确认后自动重启，并回到模型接入设置页。</p><div id="reset-progress" class="hint" role="status" aria-live="polite"></div>`,
      foot: '<button class="btn" id="reset-second-cancel">取消</button><button class="btn btn-danger" id="reset-second-confirm" disabled>确认清空并重启</button>' });
    const input = overlay.querySelector('#reset-confirmation');
    const confirm = overlay.querySelector('#reset-second-confirm');
    const progress = overlay.querySelector('#reset-progress');
    let busy = false;
    const cancel = () => { if (!busy) closeModelModal(overlay); };
    overlay.querySelector('#reset-second-cancel').addEventListener('click', cancel);
    input.addEventListener('input', () => { confirm.disabled = input.value.trim() !== challenge.phrase; });
    overlay.addEventListener('click', e => { if (busy && (e.target === overlay || e.target.closest('.model-modal-close'))) e.stopImmediatePropagation(); }, true);
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') cancel(); });
    input.focus();
    confirm.addEventListener('click', async () => {
      if (busy || input.value.trim() !== challenge.phrase) return;
      busy = true;
      overlay.querySelectorAll('button, input').forEach(node => { node.disabled = true; });
      progress.textContent = '正在提交初始化，等待应用重启…';
      try {
        const result = await api('/api/factory-reset/confirm', { method: 'POST', body: JSON.stringify({ token: challenge.token, confirmation: input.value.trim() }) });
        // 这里只是提交成功，真正清理发生在新进程；必须等完成状态再显示成功。
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          let status;
          try {
            const response = await fetch('/api/factory-reset/status', { headers: { 'x-console-token': 'qqa-ui' }, signal: AbortSignal.timeout(3000) });
            if (response.ok) status = await response.json();
          } catch { /* 重启时短暂不可用 */ }
          if (status?.state === 'failed') throw new Error(status.error);
          if (status?.state === 'complete' && status.id === result.id) {
            clearFactoryResetPreferences(status.id);
            window.location.href = new URL('/', window.location.href).href;
            return;
          }
        }
        throw new Error('初始化已提交，但自动重启尚未完成。请完整退出并重新打开 QQ Agent，启动时会继续执行初始化');
      } catch (error) {
        progress.textContent = `初始化未完成：${error.message}`;
        showNotice(progress.textContent, 'error');
        busy = false;
        overlay.querySelector('#reset-second-cancel').disabled = false;
        overlay.querySelector('.model-modal-close').disabled = false;
        // 已提交的请求不能反复确认；失败后重新打开入口取得新确认。
      }
    });
  } catch (error) {
    const result = $('#factory-reset-result');
    if (result) result.textContent = `初始化未执行：${error.message}`;
    showNotice(`初始化未执行：${error.message}`, 'error');
  } finally { button.disabled = false; }
}

function clearFactoryResetPreferences(id) {
  try {
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith('qqa-')) storage.removeItem(key);
      }
    }
    localStorage.setItem('qqa-reset-id', id);
    sessionStorage.setItem('qqa-reset-success', '1');
  } catch { /* 浏览器禁止存储时，服务端已完成清理 */ }
}

async function applyFactoryResetPreferences() {
  try {
    const status = await api('/api/factory-reset/status');
    if (status.state === 'complete' && localStorage.getItem('qqa-reset-id') !== status.id) {
      clearFactoryResetPreferences(status.id);
      window.location.reload();
      return true;
    }
  } catch { /* 兼容尚未重启的旧后端 */ }
  return false;
}

function apiVendorFor(c) {
  const base = String(c.api?.baseUrl || '').replace(/\/+$/, '');
  if (!base) return 'deepseek';
  return (state.modelCatalog || []).find((v) => v.baseUrl === base)?.id || 'other';
}

function currentModelName(c) {
  const provider = (state.providers || []).find((p) => p.id === c.api.provider);
  const preset = (state.modelCatalog || []).find((v) => v.id === apiVendorFor(c));
  return provider?.modelNames?.[c.api.model] || preset?.models.find((m) => m.id === c.api.model)?.name || c.api.model || '尚未选择模型';
}

function apiConnectionSummary(c) {
  const provider = (state.providers || []).find((p) => p.id === c.api.provider);
  const hasKey = provider ? provider.hasKey : c.api.hasKey || c.api.apiKey;
  const disabled = !c.api.model || !c.api.baseUrl ? 'disabled' : '';
  return `<div class="connection-summary"><div><span class="muted">当前使用</span><strong id="current-model-name">${esc(currentModelName(c))}</strong><span class="hint" id="provider-hint">${esc(c.api.baseUrl || '尚未设置地址')} · ${hasKey ? '已保存密钥' : '待填写密钥'}</span></div><div class="connection-actions"><button class="btn btn-small" id="edit-model-key-btn" ${disabled}>修改 API Key</button><button class="btn btn-small" id="test-provider-btn" ${disabled}>测试连通性</button></div></div><div id="provider-test-result" class="hint" role="status" aria-live="polite"></div>`;
}

function renderApiSection(c) {
  const vendor = state.modelVendor || apiVendorFor(c);
  return `
    <h3 id="settings-api">模型接入</h3>
    <p class="hint">选择厂商与模型，填写 API Key 即可使用。</p>
    <div id="api-connection-summary">${apiConnectionSummary(c)}</div>
    <div class="model-vendor-tabs" role="tablist" aria-label="模型厂商">
      ${[...((state.modelCatalog || []).map((v) => [v.id, v.name])), ['other', '其他']].map(([id, name]) => `<button type="button" class="model-vendor-btn${vendor === id ? ' active' : ''}" role="tab" id="vendor-${id}" aria-selected="${vendor === id}" aria-controls="vendor-panel-${id}" data-model-vendor="${id}">${name}</button>`).join('')}
    </div>
    ${!(state.modelCatalog || []).length ? '<p class="hint">模型目录未加载，请重启 QQ Agent 后刷新页面。</p>' : ''}
    ${(state.modelCatalog || []).map((v) => `<div class="model-vendor-panel" role="tabpanel" id="vendor-panel-${v.id}" aria-labelledby="vendor-${v.id}" ${vendor !== v.id ? 'hidden' : ''}><div class="model-choice-grid">${v.models.map((m) => `<button type="button" class="model-choice${c.api.model === m.id && apiVendorFor(c) === v.id ? ' selected' : ''}" data-model-vendor-id="${v.id}" data-model-id="${m.id}"><span class="model-choice-title">${esc(m.name)}</span><span class="hint">${esc(m.note)}</span><span class="model-choice-id">${esc(m.id)}</span></button>`).join('')}</div></div>`).join('')}
    <div class="model-vendor-panel" role="tabpanel" id="vendor-panel-other" aria-labelledby="vendor-other" ${vendor !== 'other' ? 'hidden' : ''}>
    <details class="advanced-submenu custom-settings" id="custom-model-settings"><summary>自定义模型接入 <span>添加与管理供应商</span></summary><div class="advanced-content">
      <div class="connection-actions"><button class="btn" id="cfg-model-pick">选择已添加的模型</button><button class="btn btn-small" id="fetch-current-models-btn">获取当前接口模型</button></div>
    <h3>手动添加提供商</h3>
    <div class="field"><label>Base URL（可填写）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-baseurl" placeholder="例如 https://api.deepseek.com/v1 或 https://open.bigmodel.cn/api/paas/v4" style="flex:1" />
        <button class="btn btn-small" id="fetch-models-btn">获取列表</button>
      </div></div>
    <div class="field"><label>API Key（手动添加时填写）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="new-apikey" placeholder="sk-..." autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="new-apikey-toggle" type="button">显示</button>
      </div></div>
    <div class="field"><label>模型 id（两列：左侧模型 ID，右侧模型目录中显示的名字；可添加多行）</label>
      <div id="model-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
      </div>
      <div class="hint">「获取列表」会从上面的 Base URL 拉取模型，并在弹窗里勾选加入列表。</div></div>
    <div class="field-row">
      <div class="field"><button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button></div>
      <div class="field"><button class="btn btn-danger" id="delete-model-btn">删除模型…</button></div>
    </div>
    </div></details>
    </div>
    <div class="hint" id="provider-action-hint" role="status" aria-live="polite"></div>
    <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
    <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    <input type="hidden" id="cfg-baseurl" value="${esc(c.api.baseUrl || '')}" />
    <input type="hidden" id="cfg-apikey" value="" />
    <div class="hint" id="model-vision-hint"></div>
    <details class="advanced-submenu"><summary>高级设置 <span>无需修改也能使用</span></summary><div class="advanced-content">
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /><div class="muted" style="font-size:12px;margin-top:4px">部分模型（如智谱 GLM 系列）上限为 1，超出会自动收敛到 1</div></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）</label>
      <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>

    <div class="settings-divider"></div>

    <h3>思考模式（延迟的最大头）</h3>
    <div class="hint">关闭思考通常响应更快；复杂任务可选低强度或跟随模型默认。GLM-5.2/5.3、GPT-6 Astra 和 GPT-6.1 Sol 无法关闭思考，关闭档位会自动使用最低支持强度。</div>
    <div class="field-row">
      <div class="field"><label>闲聊场景思考档位（群聊里没被 @）</label>
        <select id="cfg-thinking-casual">
          <option value="off" ${(c.api.thinkingCasual || 'off') === 'off' ? 'selected' : ''}>关掉思考（推荐，最快）</option>
          <option value="low" ${(c.api.thinkingCasual || 'off') === 'low' ? 'selected' : ''}>低强度</option>
          <option value="auto" ${(c.api.thinkingCasual || 'off') === 'auto' ? 'selected' : ''}>跟随模型默认</option>
        </select></div>
      <div class="field"><label>认真场景思考档位（私聊 / 被 @ / 定时提醒）</label>
        <select id="cfg-thinking">
          <option value="off" ${(c.api.thinking || 'low') === 'off' ? 'selected' : ''}>关掉思考（最省）</option>
          <option value="low" ${(c.api.thinking || 'low') === 'low' ? 'selected' : ''}>低强度（推荐）</option>
          <option value="auto" ${(c.api.thinking || 'low') === 'auto' ? 'selected' : ''}>跟随模型默认（不干预）</option>
        </select></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-thinkingsplit" ${c.api.thinkingSplit !== false ? 'checked' : ''} />
      <label for="cfg-thinkingsplit">按场景区分思考档位（取消勾选则所有场景都用"认真场景"档位，即旧行为）</label></div>
    <div class="field-row">
      <div class="field"><label>后台任务思考档位（记忆整理 / 看图 / 摘要）</label>
        <select id="cfg-thinking-bg">
          <option value="off" ${(c.api.thinkingBackground || 'off') === 'off' ? 'selected' : ''}>关掉思考（最省 token）</option>
          <option value="low" ${(c.api.thinkingBackground || 'off') === 'low' ? 'selected' : ''}>低强度</option>
          <option value="auto" ${(c.api.thinkingBackground || 'off') === 'auto' ? 'selected' : ''}>跟随模型默认</option>
        </select></div>
    </div>
    <div class="field"><label>思考参数适配（留空=自动识别）</label>
      <select id="cfg-thinking-provider">
        <option value="" ${!c.api.thinkingProvider ? 'selected' : ''}>自动识别（同时发多套参数名，最省事）</option>
        <option value="openai" ${c.api.thinkingProvider === 'openai' ? 'selected' : ''}>OpenAI 风格（reasoning_effort）</option>
        <option value="deepseek" ${c.api.thinkingProvider === 'deepseek' ? 'selected' : ''}>DeepSeek / 通义 / 智谱风格（thinking + enable_thinking）</option>
        <option value="thinking-type" ${c.api.thinkingProvider === 'thinking-type' ? 'selected' : ''}>仅 thinking.type（部分网关）</option>
        <option value="anthropic" ${c.api.thinkingProvider === 'anthropic' ? 'selected' : ''}>Anthropic Claude（thinking.budget_tokens）</option>
      </select>
      <div class="hint">拿不准就留「自动识别」。只有某个端点因为多发了参数名而报 400 时，才需要手动指定。</div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-thinking-unsupported" ${c.api.thinkingUnsupported ? 'checked' : ''} />
      <label for="cfg-thinking-unsupported">该接口不支持思考参数（勾选后完全不发，避免报错重试浪费一次请求）</label></div>
    <div class="settings-divider"></div>

    <h3>发言兜底（治"只思考不回复"）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-textfallback" ${c.api.textFallback !== false ? 'checked' : ''} />
      <label for="cfg-textfallback">模型没调用工具、但写出了回复文本时，直接当作发言发出去</label></div>
    <div class="hint">模型没有调用发送工具时，把正常回复文本作为发言发送，避免只思考不回复。</div>
    <div class="settings-divider"></div>

    <h3>发言后直接收尾（省掉一整轮等待）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-endaftersend" ${c.api.endAfterSend !== false ? 'checked' : ''} />
      <label for="cfg-endaftersend">发完话就直接结束，不再多跑一轮"收尾"</label></div>
    <div class="hint">仅发送消息、没有查询任务时直接结束，减少等待；需要补充内容时让模型在同一轮发送。</div>
    <div class="settings-divider"></div>

    </div></details>`;
}

function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-chat')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
      </div></div>

    <details class="advanced-submenu custom-settings" id="custom-search-settings"><summary>自定义搜索源 <span>地址与服务管理</span></summary><div class="advanced-content">
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>
    <h3>添加搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
    </div></details>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    ${renderMemoryRecordActions('__global__', '跨群档案与长期记忆')}
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <details class="advanced-submenu custom-settings" id="mem-model-box" style="${useChat ? 'display:none' : ''}"><summary>自定义记忆模型 <span>单独配置整理模型</span></summary><div class="advanced-content">
      <div class="field"><label>记忆整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div></details>
    <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>

    <h3 id="settings-memory-surface" style="margin-top:24px">⏳ 表层记忆（刚说过的话）</h3>
    <div class="hint" style="margin-bottom:10px">
      最新一层记忆：一句话刚说完就先暂存在这里，<b>任何会话都能立刻查到</b>——
      所以私聊里交代的事，机器人换个群就能马上接上/复述。超过保留时长自动清除；
      觉得值得长期留的，可以在「跨群档案」页点「存入长期」，或让机器人自己沉淀。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-surface" ${mem.surfaceEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-surface">启用表层记忆</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-surface-p2g" ${mem.surfacePrivateToGroup !== false ? 'checked' : ''} />
      <label for="cfg-mem-surface-p2g">允许私聊刚说的话立刻出现在群里（默认开启，这才有"立刻复述"）</label></div>
    <div class="field-row">
      <div class="field"><label>保留时长（分钟）</label><input type="number" id="cfg-mem-surface-ttl" min="1" step="1" value="${Math.round((mem.surfaceTtlMs ?? 600000) / 60000)}" /></div>
      <div class="field"><label>每人最多（条）</label><input type="number" id="cfg-mem-surface-max" min="1" step="1" value="${esc(mem.surfaceMaxPerPerson ?? 50)}" /></div>
      <div class="field"><label>每次注入（条）</label><input type="number" id="cfg-mem-surface-inject" min="0" step="1" value="${esc(mem.surfaceMaxInject ?? 6)}" /></div>
    </div>

    <h3 id="settings-memory-global" style="margin-top:24px">跨群聊 · 长期记忆</h3>
    <div class="hint" style="margin-bottom:10px">
      第三层记忆：同一个 QQ 号在不同群是同一个人。跨群档案与长期事件存在
      <code>data/memory/_global/</code>，与每个群自己的群友印象互不覆盖 ——
      某个群里删印象不会连带清空别的群记住的同一个人的信息。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-global" ${mem.globalEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-global">启用跨群聊长期记忆</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-crossgroup" ${mem.crossGroupEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-crossgroup">允许跨群引用（在 A 群学到的，能在 B 群用上）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-priv2group" ${mem.crossGroupPrivateToGroup !== false ? 'checked' : ''} />
      <label for="cfg-mem-priv2group">允许把私聊里知道的事带进群（长期记忆层；默认开启）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-events" ${mem.eventsEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-events">启用长期事件记忆（约定 / 梗 / 恩怨 / 长期话题）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-events-auto" ${mem.eventsAutoExtract !== false ? 'checked' : ''} />
      <label for="cfg-mem-events-auto">整理记忆时自动抽取长期事件（模型平时很少主动记）</label></div>
    <div class="field"><label>不外泄记忆的会话（逗号分隔，如 group:123）</label>
      <input type="text" id="cfg-mem-exclude" value="${esc((mem.crossGroupExclude || []).join(','))}" /></div>

    <h4 style="margin:18px 0 8px">遗忘曲线</h4>
    <div class="hint" style="margin-bottom:10px">
      不靠定时扣分：读取时按半衰期实时折算权重。基准半衰期随重要度放大
      （重要度 1 → 1×，3 → 2.5×，5 → 4×）；重要度 ≥「永不遗忘阈值」的记忆不会被淘汰。
    </div>
    <div class="field-row">
      <div class="field"><label>基准半衰期（天）</label><input type="number" id="cfg-mem-halflife" min="1" step="5" value="${esc(mem.decayHalfLifeDays ?? 30)}" /></div>
      <div class="field"><label>永不遗忘阈值（重要度）</label><input type="number" id="cfg-mem-keepimp" min="1" max="5" step="1" value="${esc(mem.keepImportance ?? 4)}" /></div>
      <div class="field"><label>淡出阈值（有效权重）</label><input type="number" id="cfg-mem-minweight" min="0" max="1" step="0.01" value="${esc(mem.decayMinWeight ?? 0.08)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每人最多保留事实（条）</label><input type="number" id="cfg-mem-maxfacts" min="3" step="1" value="${esc(mem.maxFactsPerPerson ?? 12)}" /></div>
      <div class="field"><label>每次注入几个人</label><input type="number" id="cfg-mem-peopleinject" min="0" step="1" value="${esc(mem.peopleMaxInject ?? 6)}" /></div>
      <div class="field"><label>每次注入几件事</label><input type="number" id="cfg-mem-eventsinject" min="0" step="1" value="${esc(mem.eventsMaxInject ?? 6)}" /></div>
      <div class="field"><label>注入字符预算</label><input type="number" id="cfg-mem-budget" min="300" step="100" value="${esc(mem.crossGroupMaxChars ?? 1400)}" /></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-small" id="mem-global-rebuild">从已有印象重建跨群档案</button>
      <button class="btn btn-small" id="mem-global-preview">预览将淡忘什么</button>
      <button class="btn btn-small" id="mem-global-decay">立即执行遗忘清理</button>
      <span class="muted" id="mem-global-op-result"></span>
    </div>`;
}

/**
 * 设置 → 定时提醒。
 * 开关之外还给一个"最近的提醒"概览 —— 用户最想知道的是"她到底答应了我什么"。
 */
function renderReminderSection(c) {
  const r = c.reminder || {};
  const st = state.status?.orchestrator?.reminders || null;
  const items = (state.reminders?.items || []).filter((e) => e.status === 'pending' || e.status === 'running').slice(0, 6);
  const rows = items.length
    ? items.map((e) => `<div class="muted" style="font-size:12px;padding:2px 0">· ${esc(fmtDateTime(e.dueAt))} · ${esc(chatNameOf(e.chatKey))} · ${esc(e.text)}${e.repeat?.kind && e.repeat.kind !== 'none' ? `（${esc(repeatLabelUi(e.repeat))}）` : ''}</div>`).join('')
    : '<div class="hint">还没有待触发的提醒。等她在聊天里答应你"到点叫你"就会出现，也可以展开本页的「查看和管理记录」手工添加。</div>';
  return `
    ${renderMemoryRecordActions('__reminders__', '提醒记录')}
    <h3 id="settings-reminder">定时提醒</h3>
    <div class="hint" style="margin-bottom:10px">
      她可以定一个时间点，到点由系统把她叫醒，用自己的语气主动来找你（哪怕群里一直没人说话）。
      提醒存在长期记忆库里：<code>data/memory/&lt;人设&gt;/_global/reminders.json</code>，跟人设走，可手改可备份。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rem-enabled" ${r.enabled !== false ? 'checked' : ''} />
      <label for="cfg-rem-enabled">启用定时提醒（关掉后不再到点发消息，已有提醒原样保留）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rem-fallback" ${r.fallbackRawText !== false ? 'checked' : ''} />
      <label for="cfg-rem-fallback">兜底直发：模型坏了/没配置时，直接把提醒原文发出去（承诺不落空）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rem-inject" ${r.injectUpcoming !== false ? 'checked' : ''} />
      <label for="cfg-rem-inject">把"还没到点的提醒"放进她的上下文（聊天时心里有数，不会重复定）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rem-missed" ${r.missedNoteInPrompt !== false ? 'checked' : ''} />
      <label for="cfg-rem-missed">离线导致没赶上的提醒，在她下次聊天时自然提一句（不单独开一次对话）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rem-private" ${r.allowPrivateTarget !== false ? 'checked' : ''} />
      <label for="cfg-rem-private">允许"到点私聊某个人"（目标必须在本会话近期发过言，防乱发骚扰消息）</label></div>

    <div class="field-row" style="margin-top:10px">
      <div class="field"><label>提醒方式</label>
        <select id="cfg-rem-delivery">
          <option value="natural" ${(r.delivery || 'natural') === 'natural' ? 'selected' : ''}>让她用自己的话说（推荐）</option>
          <option value="verbatim" ${r.delivery === 'verbatim' ? 'selected' : ''}>直接复读提醒原文（省 token）</option>
        </select></div>
      <div class="field"><label>启动补发窗口（分钟）</label><input type="number" id="cfg-rem-catchup" min="0" step="30" value="${esc(r.catchUpMinutes ?? 720)}" /></div>
      <div class="field"><label>到点检查间隔（毫秒）</label><input type="number" id="cfg-rem-interval" min="5000" step="5000" value="${esc(r.checkIntervalMs ?? 20000)}" /></div>
    </div>
    <div class="hint">应用没开的时候到点的提醒：窗口内（默认 12 小时）开机就补发；超窗口只记一条"错过"，等她下次聊天时提一句。</div>
    <div class="field-row">
      <div class="field"><label>最短提前量（秒）</label><input type="number" id="cfg-rem-mindelay" min="0" step="10" value="${esc(r.minDelaySec ?? 30)}" /></div>
      <div class="field"><label>单日最多新建（条）</label><input type="number" id="cfg-rem-maxday" min="1" step="5" value="${esc(r.maxPerDay ?? 20)}" /></div>
      <div class="field"><label>单会话待触发上限</label><input type="number" id="cfg-rem-maxchat" min="1" step="5" value="${esc(r.maxPendingPerChat ?? 20)}" /></div>
      <div class="field"><label>历史记录保留（天）</label><input type="number" id="cfg-rem-ttl" min="1" step="30" value="${esc(r.ttlDays ?? 400)}" /></div>
    </div>

    <h4 style="margin:18px 0 8px">最近待触发${st ? `（共 ${st.pending} 条${st.nextDueAt ? ` · 下一条 ${esc(fmtDateTime(st.nextDueAt))}` : ''}）` : ''}</h4>
    ${rows}
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-small" id="rem-cleanup">清理已完成记录</button>
      <span class="muted" id="rem-op-result"></span>
    </div>`;
}

/**
 * 设置 → 风格学习（真人说话逻辑 / 图片表情反应）。
 * 总开关默认关：打开才开始采集、蒸馏、注入，一个字节都不提前写。
 */
function renderStyleSection(c) {
  const s = c.styleLearn || {};
  const st = state.style?.stats || null;
  const byChat = st?.byChat || {};
  const chatRows = Object.entries(byChat).slice(0, 8)
    .map(([k, v]) => `<div class="muted" style="font-size:12px;padding:2px 0">· ${esc(chatNameOf(k))}：说话 ${v.speech} 条 / 图片表情反应 ${v.reaction} 条</div>`)
    .join('');
  return `
    ${renderMemoryRecordActions('__style__', '风格记录')}
    <h3 id="settings-style">真人说话风格学习</h3>
    <div class="hint" style="margin-bottom:10px">
      让它在群里<b>偷学真人怎么说话</b>：句长、语气词、标点习惯、接话方式，以及
      <b>看到图片/表情包时真人一般怎么反应</b>。样本只从本机已存档的聊天记录里取（不额外请求），
      攒够一批才用模型蒸馏成"风格库"，再作为语感参考注入它的提示词。
      <br />默认关闭 —— 关着的时候不采集、不蒸馏、不注入，也不写任何文件。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-enabled" ${s.enabled === true ? 'checked' : ''} />
      <label for="cfg-style-enabled"><b>开启风格学习</b>（总开关）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-speech" ${s.learnSpeech !== false ? 'checked' : ''} />
      <label for="cfg-style-speech">学说话逻辑（句式 / 语气词 / 长短句 / 标点 / 口头禅）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-image" ${s.learnImageReaction !== false ? 'checked' : ''} />
      <label for="cfg-style-image">学"看见图片"的反应（发图后真人回了什么）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-sticker" ${s.learnSticker !== false ? 'checked' : ''} />
      <label for="cfg-style-sticker">学"看见表情包"的反应（包括"直接回一张表情包"）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-emoji" ${s.learnEmoji !== false ? 'checked' : ''} />
      <label for="cfg-style-emoji">学"看见 QQ 表情 / emoji"的反应</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-collect" ${s.collectEnabled !== false ? 'checked' : ''} />
      <label for="cfg-style-collect">采集新样本（关掉 = 只用已有样本，不再新增）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-auto" ${s.autoDistill !== false ? 'checked' : ''} />
      <label for="cfg-style-auto">后台自动蒸馏（攒够样本 + 过了冷却就自动学一次；关掉则只在你点按钮时学）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-style-caption" ${s.captionImages === true ? 'checked' : ''} />
      <label for="cfg-style-caption">给"被回应的图片"生成一句内容描述（<b>额外花钱</b>：每张图一次视觉调用）</label></div>
    <div class="hint">不打开的话，它只能学到"看到图 → 哈哈"，学不到"看到猫图 → 好可爱"。额度见下方"每日描述上限"。</div>

    <div class="field-row" style="margin-top:10px">
      <div class="field"><label>蒸馏触发样本数</label><input type="number" id="cfg-style-minsamples" min="10" step="10" value="${esc(s.distillMinSamples ?? 80)}" /></div>
      <div class="field"><label>蒸馏冷却（毫秒）</label><input type="number" id="cfg-style-interval" min="60000" step="600000" value="${esc(s.distillIntervalMs ?? 21600000)}" /></div>
      <div class="field"><label>反应判定窗口（秒）</label><input type="number" id="cfg-style-window" min="10" step="10" value="${esc(s.reactionWindowSec ?? 180)}" /></div>
      <div class="field"><label>样本池上限（条）</label><input type="number" id="cfg-style-maxsamples" min="100" step="100" value="${esc(s.maxSamples ?? 3000)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>说话逻辑保留上限</label><input type="number" id="cfg-style-maxspeech" min="1" step="1" value="${esc(s.maxSpeechItems ?? 18)}" /></div>
      <div class="field"><label>反应保留上限</label><input type="number" id="cfg-style-maxreact" min="1" step="1" value="${esc(s.maxReactionItems ?? 18)}" /></div>
      <div class="field"><label>每次注入条数</label><input type="number" id="cfg-style-injectitems" min="0" step="1" value="${esc(s.injectMaxItems ?? 8)}" /></div>
      <div class="field"><label>注入字符预算</label><input type="number" id="cfg-style-injectchars" min="100" step="100" value="${esc(s.injectMaxChars ?? 900)}" /></div>
      <div class="field"><label>每日图片描述上限</label><input type="number" id="cfg-style-captionmax" min="0" step="10" value="${esc(s.captionMaxPerDay ?? 30)}" /></div>
    </div>
    <div class="field"><label>不学习的会话（逗号分隔，如 group:123）</label>
      <input type="text" id="cfg-style-exclude" value="${esc((s.chatExclude || []).join(','))}" /></div>

    <h4 style="margin:18px 0 8px">当前进度</h4>
    <div class="muted" style="margin-bottom:6px">
      ${st
        ? `样本 ${st.samples} 条（待蒸馏 ${st.pendingSamples}）· 风格库：说话逻辑 ${st.speechItems} 条 / 图片表情反应 ${st.reactionItems} 条 ·
           ${st.distilledAt ? `上次学习 ${esc(fmtTime(st.distilledAt))}（第 ${st.distilledCount} 次）` : '还没学习过'}`
        : '尚未加载统计'}
    </div>
    ${chatRows}
    ${st?.lastError ? `<div class="hint" style="color:var(--color-text-danger,#f66)">上次蒸馏失败：${esc(st.lastError)}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-small btn-primary" id="style-distill-now">立即学习一次</button>
      <button class="btn btn-small" id="style-clear-samples">清空样本池</button>
      <button class="btn btn-small" id="style-clear-profile">清空风格库</button>
      <span class="muted" id="style-op-result"></span>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   设置 → 搜图服务（section id: image）
   ══════════════════════════════════════════════════════════════
   她能"找张图发到群里"。内置图源都是免登录的公开接口；图片先下载校验、
   再由发送层决定直链还是内嵌，不会把外部图床链接直接甩给 OneBot。
   自定义图源与"按群覆盖"都在本页维护，保存时随 config.imageSearch 提交。
*/

/** 内置图源：[值, 下拉里的说明]。 */
const IMAGE_PROVIDER_PRESETS = [
  ['pixiv', 'pixiv —— 免登录搜公开作品，也可直接给作品号'],
  ['safebooru', 'safebooru —— 免登录，全年龄图库'],
  ['konachan', 'konachan —— 免登录，多为二次元壁纸'],
  ['yandere', 'yande.re —— 免登录，多为二次元壁纸']
];

/** 发送方式的中文说明（值必须与后端 sendMode 一致）。 */
const IMAGE_SEND_MODE_LABEL = {
  auto: 'auto —— 优先直链，发不出去改内嵌（推荐）',
  url: 'url —— 只发图片直链（省流量，个别图床会失败）',
  base64: 'base64 —— 一律内嵌发送（最稳，费带宽）'
};

/** 分级的中文显示（后端给的是 safe / r18 / unknown）。 */
const RATING_LABEL = { safe: '全年龄', r18: 'R18', unknown: '分级未知' };

/** 逗号 / 顿号 / 分号 / 换行分隔的短列表（别名、标签、AI 屏蔽标签共用）。 */
function parseCommaList(s) {
  return String(s || '').split(/[,，、;；\n\r]+/).map((x) => x.trim()).filter(Boolean);
}

/*
 * ── 新增设置页的模块级状态 ──
 * ⚠ 必须声明在**所有用到它们的函数之前**：这些是 let/const，靠后声明时前面的函数
 *   一旦在初始化前被调用就直接 TDZ 报错（整个设置页打不开，而 node --check 查不出来）。
 */
// 搜图服务：自定义图源的密钥缓存 + "列表改过没有"
let imageProviderKeys = {};      // 图源 id -> 本会话里输入过的明文 Key（不回填到界面）
let imageProvidersDirty = false; // 本页是否增删过图源/重填过 Key
// 梗知识库：列表数据放 state.memes（异步拉取的结果），其余是界面状态
let memeLoadError = '';     // 拉取失败时的错误文案
let memeLoadSeq = 0;        // 请求序号：只认最后一次返回，避免乱序覆盖
let memeEditingId = null;   // 正在编辑的梗 id；null = 新建
let memeNotice = null;      // 一次性提示 { text, kind: 'ok' | 'error' }
let memeFilterText = '';    // 列表里的关键词过滤（纯前端）
let memeFilterKind = '';    // 列表里的类型过滤（纯前端）

/** 一行一条（也容忍"；"分隔）：适用场景 / 范例句共用。 */
function parseLineList(s) {
  return String(s || '').split(/[\n\r；;]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 图源下拉的 <option>（内置 + 自定义）。
 * value 用 `custom:<id>`；selected 传 'custom:xxx' 也能命中。
 */
function imageProviderOptions(selected, customs, followLabel = '') {
  const sel = String(selected || '');
  const known = new Set(IMAGE_PROVIDER_PRESETS.map(([v]) => v));
  for (const p of customs || []) known.add(`custom:${p.id}`);
  return (followLabel ? `<option value="" ${sel ? '' : 'selected'}>${esc(followLabel)}</option>` : '')
    + IMAGE_PROVIDER_PRESETS.map(([v, label]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${esc(label)}</option>`).join('')
    // 配置里指向一个已经删掉的图源时，也把它显示出来，别让人以为"跟随全局"
    + (sel && !known.has(sel) ? `<option value="${esc(sel)}" selected>${esc(sel)}（已不在列表里）</option>` : '')
    + (customs || []).map((p) => `<option value="custom:${esc(p.id)}" ${sel === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl || p.id)}（自定义）</option>`).join('');
}

/** 自定义图源列表的一行（删除按钮靠 data-id 定位）。 */
function imageCustomRowHtml(p) {
  const known = !!imageProviderKeys[p.id];
  const hasKey = known || p.hasApiKey === true;
  // 密钥框永远不回填明文：后端 /api/config 不回显 apiKey，
  // 这里只用来"重填一次"，好让保存时能把 Key 一起带上。
  const ph = known ? '密钥已记录（留空即不变）' : (p.hasApiKey ? '密钥已存在但不回显 —— 重填可保留' : 'API Key（可选）');
  return `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;font-size:12px">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        <b>${esc(p.name || p.id)}</b>
        <span class="muted"> · ${esc(p.baseUrl || '（未填接口地址）')}${hasKey ? ' · 已设密钥' : ''}${p.cookie ? ' · 带 Cookie' : ''} · 超时 ${esc(p.timeoutMs ?? 15000)}ms</span>
      </span>
      <input type="password" class="img-custom-key" data-id="${esc(p.id)}" placeholder="${esc(ph)}" autocomplete="new-password"
        title="后端不回显密钥，所以这里永远是空的；重填一次即可在保存时保留/更新它" style="width:200px;font-size:12px" />
      <button class="btn btn-small btn-danger img-custom-del" data-id="${esc(p.id)}" type="button">删除</button>
    </div>`;
}

/**
 * 归一化一条自定义图源：只留后端认识的字段。
 * apiKey 不进这里 —— 见 imageProviderKeys 的说明。
 */
function normImageProvider(p) {
  return {
    id: String(p?.id || '').trim(),
    name: String(p?.name || '').trim(),
    type: 'custom',
    baseUrl: String(p?.baseUrl || '').trim(),
    cookie: String(p?.cookie || '').trim(),
    timeoutMs: clampInt(p?.timeoutMs, 3000, 120000, 15000),
    ...(p?.hasApiKey ? { hasApiKey: true } : {})
  };
}

/**
 * 自定义图源的"唯一真相"= 隐藏字段里的 JSON。
 * 增删都即时写回这里（与「分群档位」同一个套路），保存时由 saveConfig 读取提交 ——
 * 避免"界面加了但保存时读了旧配置"。
 *
 * ⚠ 密钥例外：后端的 /api/config 会把 providers[].apiKey 脱敏成 hasApiKey（不回显明文），
 *   而 providers 数组在保存时是**整体替换**的 —— 直接回传这个 JSON 会把已有的 Key 清掉。
 *   所以密钥单独缓存在 imageProviderKeys（本会话里输入过的），
 *   并且只有真的改过列表（imageProvidersDirty）才会提交 providers。
 */
function imageCustomProviders() {
  try {
    const list = JSON.parse($('#cfg-img-providers-json')?.value || '[]');
    return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object' && p.id) : [];
  } catch { return []; }
}

function writeImageCustomProviders(list) {
  const el = $('#cfg-img-providers-json');
  if (el) el.value = JSON.stringify((list || []).map(normImageProvider));
}

/** 按群覆盖的唯一真相：同样是隐藏字段里的 JSON。 */
function imagePerChatMap() {
  try {
    const m = JSON.parse($('#cfg-img-perchat-json')?.value || '{}');
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch { return {}; }
}

function writeImagePerChatMap(m) {
  const el = $('#cfg-img-perchat-json');
  if (el) el.value = JSON.stringify(m || {});
}

/** 布尔覆盖项在下拉里的取值：'' = 跟随全局 / '1' = 开 / '0' = 关。 */
function imageTriValue(v) {
  if (v === undefined || v === null) return '';
  return v ? '1' : '0';
}

/** 「按群覆盖」里的一行：每项都能留空（留空 = 跟随全局设置）。 */
function imagePerChatRowHtml(key, over, customs) {
  const o = over || {};
  const tri = (field, label, text) => `
    <label class="muted" style="font-size:11.5px">${esc(label)}</label>
    <select class="img-perchat-sel" data-perchat-key="${esc(key)}" data-perchat-field="${field}" style="font-size:12px;padding:2px 6px;max-width:150px">
      <option value="" ${imageTriValue(o[field]) === '' ? 'selected' : ''}>跟随全局</option>
      <option value="1" ${imageTriValue(o[field]) === '1' ? 'selected' : ''}>${esc(text[0])}</option>
      <option value="0" ${imageTriValue(o[field]) === '0' ? 'selected' : ''}>${esc(text[1])}</option>
    </select>`;
  return `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0;border-bottom:1px solid var(--color-border-tertiary,#3333)">
      <b style="font-size:12px;min-width:130px">${esc(formatChatTitle(key, chatNameOf(key)))}</b>
      ${tri('enabled', '启用', ['启用', '停用'])}
      ${tri('hideAi', '屏蔽 AI 图', ['屏蔽', '不屏蔽'])}
      <label class="muted" style="font-size:11.5px">图源</label>
      <select class="img-perchat-sel" data-perchat-key="${esc(key)}" data-perchat-field="provider" style="font-size:12px;padding:2px 6px;max-width:190px">
        ${imageProviderOptions(String(o.provider || ''), customs, '跟随全局')}
      </select>
      <label class="muted" style="font-size:11.5px">发送方式</label>
      <select class="img-perchat-sel" data-perchat-key="${esc(key)}" data-perchat-field="sendMode" style="font-size:12px;padding:2px 6px;max-width:150px">
        <option value="" ${!o.sendMode ? 'selected' : ''}>跟随全局</option>
        ${['auto', 'url', 'base64'].map((v) => `<option value="${v}" ${o.sendMode === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <button class="btn btn-small btn-danger img-perchat-del" data-key="${esc(key)}" type="button" style="margin-left:auto">删除</button>
    </div>`;
}

/** 重画「按群覆盖」列表（增删后调用；下拉选项跟着自定义图源变）。 */
function renderImagePerChatList() {
  const box = $('#cfg-img-perchat-list');
  if (!box) return;
  const customs = imageCustomProviders();
  const map = imagePerChatMap();
  const keys = Object.keys(map);
  box.innerHTML = keys.length
    ? keys.map((k) => imagePerChatRowHtml(k, map[k], customs)).join('')
    : '<div class="muted" style="font-size:12px">还没有按群覆盖 —— 所有会话都用上面的全局设置。</div>';
}

/** 重画自定义图源列表 + 同步两个图源下拉（增删图源后都要调一次）。 */
function syncImageProviderSelects() {
  const customs = imageCustomProviders();
  const main = $('#cfg-img-provider');
  if (main) main.innerHTML = imageProviderOptions(main.value, customs);
  const test = $('#cfg-img-test-provider');
  if (test) test.innerHTML = imageProviderOptions(test.value, customs, '跟随当前配置');
  const listBox = $('#cfg-img-custom-list');
  if (listBox) {
    listBox.innerHTML = customs.length
      ? customs.map(imageCustomRowHtml).join('')
      : '<div class="muted" style="font-size:12px">还没有自定义图源。</div>';
  }
  renderImagePerChatList();   // 覆盖项里的图源下拉同样要更新
}

/** 排序方式的中文名（试搜结果顶部用；后端没回传就按界面/配置上的值猜）。 */
const IMAGE_SORT_LABEL = { popular: '按收藏数排序', newest: '按发布时间' };
function imageSortLabel(v) {
  const k = String(v || 'popular') === 'newest' ? 'newest' : 'popular';
  return IMAGE_SORT_LABEL[k];
}

/** 试搜结果：缩略图网格 + 过滤统计。thumb 是同源中转地址（后端已带 referer 取图）。 */
function renderImageTestResult(data) {
  const box = $('#cfg-img-test-result');
  if (!box) return;
  const d = data.dropped || {};
  const dropBits = [];
  if (Number(d.ai)) dropBits.push(`已屏蔽 ${Number(d.ai)} 张 AI 图`);
  if (Number(d.r18)) dropBits.push(`已屏蔽 ${Number(d.r18)} 张 R18`);
  if (Number(d.seen)) dropBits.push(`已发过 ${Number(d.seen)} 张`);
  if (Number(d.bad)) dropBits.push(`链接不可用 ${Number(d.bad)} 张`);
  // 排序方式：接口没回传就退回界面上选的那个，再退回已保存的配置。
  // 不显示的话，用户看不懂"为什么结果顺序怪怪的"（尤其是补查收藏数失败时会退回原顺序）。
  const sortBy = String(data.sortBy || $('#cfg-img-sortby')?.value || state.config?.imageSearch?.sortBy || 'popular');
  const head = `
    <div class="muted" style="font-size:12px;margin-bottom:6px">
      图源 ${esc(data.provider || '?')} · 实际搜索词「${esc(data.query || '')}」
      ${(data.attempts || []).length ? ` · 逐级尝试：${esc((data.attempts || []).join(' → '))}` : ''}
    </div>
    <div class="hint" style="margin-bottom:6px">
      ${dropBits.length ? `${esc(dropBits.join(' · '))} · ` : ''}当前${esc(imageSortLabel(sortBy))}${sortBy === 'popular' ? '（已给候选补查过收藏数，所以慢一点）' : ''}
    </div>`;
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    box.innerHTML = `${head}<div class="hint">这次一张都没搜到。换个词试试，或者把「屏蔽 AI 图」放宽再搜。</div>`;
    return;
  }
  box.innerHTML = `${head}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
      ${items.map((it) => {
        // 收藏数：pixiv 搜索接口不返回，只有补查过详情的候选才有；查不到就是 null，显示 "—"。
        // 颜色只看档次：>=1000 醒目（橙 + 加粗）、>=100 正常、<100 灰一点，方便一眼挑图。
        const bmRaw = it.bookmarkCount;
        const bmNum = (bmRaw === null || bmRaw === undefined || bmRaw === '') ? NaN : Number(bmRaw);
        const bmOk = Number.isFinite(bmNum);
        const bmStyle = !bmOk ? 'opacity:.6'
          : (bmNum >= 1000 ? 'color:var(--orange);font-weight:700' : (bmNum >= 100 ? '' : 'opacity:.6'));
        return `
        <div>
          <img class="img-thumb" src="${esc(it.thumb || '')}" loading="lazy" alt="${esc(it.title || '')}"
            style="width:100%;height:150px;object-fit:cover;border-radius:6px;border:1px solid var(--border);background:var(--bg-3);display:block" />
          <div style="font-size:12px;margin-top:4px;word-break:break-word">${esc(it.title || '（无标题）')}</div>
          <div class="muted" style="font-size:11.5px">${esc(it.author || '未知作者')} · ${esc(it.width || '?')}×${esc(it.height || '?')} · <span style="${bmStyle}" title="${bmOk ? '收藏数' : '收藏数未知（这个候选没补查详情，或站点不提供）'}">❤ ${bmOk ? esc(bmNum) : '—'}</span> · ${it.ai === true ? 'AI 生成' : it.ai === false ? '人工' : 'AI 未知'}${it.rating ? ` · ${esc(RATING_LABEL[it.rating] || it.rating)}` : ''}</div>
          <div class="muted" style="font-size:11px;word-break:break-word">${(it.tags || []).slice(0, 5).map((t) => `#${esc(t)}`).join(' ')}</div>
          ${it.pageUrl ? `<a href="${esc(it.pageUrl)}" target="_blank" rel="noopener" style="font-size:11px">作品页</a>` : ''}
        </div>`; }).join('')}
    </div>`;
  // 缩略图挂了就换成一行提示，别在页面上留个破图
  $$('.img-thumb', box).forEach((img) => img.addEventListener('error', () => {
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.style.cssText = 'height:150px;display:flex;align-items:center;justify-content:center;font-size:11.5px;border:1px dashed var(--border);border-radius:6px;text-align:center;padding:6px';
    tip.textContent = '缩略图加载失败（点"作品页"看原图）';
    img.replaceWith(tip);
  }));
}

/**
 * 试搜：拿当前配置问一次图源，把结果画成缩略图网格（不发图、不写记录）。
 * 从 bindSettingsEvents 的按钮点击进来（按钮可选，不传就自己找 #cfg-img-test-btn）。
 */
async function runImageSearchTest(btn = null) {
  const testBtn = btn || $('#cfg-img-test-btn');
  const hint = $('#cfg-img-test-hint');
  const box = $('#cfg-img-test-result');
  const query = ($('#cfg-img-test-query')?.value || '').trim();
  if (!query) { if (hint) hint.textContent = '先填个搜索词'; return; }
  const label = testBtn ? testBtn.textContent : '试搜';
  if (testBtn) { testBtn.disabled = true; testBtn.textContent = '搜索中…'; }
  if (hint) hint.textContent = '正在问图源…';
  try {
    const r = await api('/api/image-search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        provider: $('#cfg-img-test-provider')?.value || '',   // 空 = 跟随当前配置
        limit: clampInt($('#cfg-img-test-limit')?.value, 1, 10, 3),
        stage: 'auto',
        hideAi: !!$('#cfg-img-test-hideai')?.checked,
        allowR18: !!$('#cfg-img-test-r18')?.checked
      })
    });
    if (r.ok) {
      if (hint) hint.textContent = `搜到 ${(r.items || []).length} 张${Number(r.totalFound) > Number((r.items || []).length) ? `（共 ${r.totalFound} 张候选，这里按人气显示前 ${(r.items || []).length} 张）` : ''}`;
      renderImageTestResult(r);
    } else {
      if (hint) hint.textContent = '';
      if (box) box.innerHTML = `<div class="hint" style="color:var(--red)">试搜失败：${esc(r.error || '未知错误')}</div>`;
    }
  } catch (e) {
    if (hint) hint.textContent = '';
    if (box) box.innerHTML = `<div class="hint" style="color:var(--red)">试搜失败：${esc(e.message)}</div>`;
  } finally {
    if (testBtn) { testBtn.disabled = false; testBtn.textContent = label; }
  }
}

/** 设置 → 搜图服务。 */
function renderImageSearchSection(c) {
  const is = c.imageSearch || {};
  const customs = Array.isArray(is.providers) ? is.providers : [];
  const perChat = (is.perChat && typeof is.perChat === 'object' && !Array.isArray(is.perChat)) ? is.perChat : {};
  const sendMode = String(is.sendMode || 'auto');
  // 排序方式只认两个值，别的（含 undefined）一律当默认的按收藏数排序
  const sortBy = String(is.sortBy || 'popular') === 'newest' ? 'newest' : 'popular';
  // 密钥框永远不回填：留空 = 不变。这里只用来决定 placeholder 提示哪一句。
  const sauceKeyPresent = is.hasSauceNaoKey === true || !!String(is.sauceNaoKey || '').trim();
  const perChatKeys = Object.keys(perChat);
  // 刚保存过的响应里可能带明文 Key（POST /api/config 不回脱敏），顺手补进缓存；
  // 常规 GET 拿到的只有 hasApiKey，此时只能靠用户在本页重填一次。
  for (const p of customs) {
    if (p && p.id && p.apiKey) imageProviderKeys[p.id] = String(p.apiKey);
  }
  imageProvidersDirty = false;   // 本次渲染出来的列表就是配置现状：还没改过
  const unknownKeyProvs = customs.filter((p) => p.hasApiKey === true && !imageProviderKeys[p.id]);
  return `
    <h3 id="settings-image">搜图服务</h3>
    <div class="hint" style="margin-bottom:10px">
      让她在聊天里"找张图发出来"。内置图源都是<b>免登录</b>的公开接口；图片会先下载校验、再由发送层决定发直链还是内嵌，
      不会把外部图床链接直接甩给协议端。默认屏蔽 AI 生成图、默认不允许 R18。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-img-enabled" ${is.enabled !== false ? 'checked' : ''} />
      <label for="cfg-img-enabled">启用搜图（关掉后 search_image / send_image 两个工具直接不可用）</label></div>
    <div class="field"><label>默认图源</label>
      <select id="cfg-img-provider">${imageProviderOptions(String(is.provider || 'pixiv'), customs)}</select>
      <div class="hint">
        pixiv：免登录可搜公开作品，也可以直接把作品号当搜索词（例如 1234567）；
        safebooru：免登录、全年龄图库；konachan / yande.re：免登录，但内容多为二次元壁纸。
        自己搭的接口可展开下面「自定义搜图源」设置。
      </div></div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-img-hideai" ${is.hideAi !== false ? 'checked' : ''} />
      <label for="cfg-img-hideai"><b>屏蔽 AI 生成图</b>（推荐开着）</label></div>
    <details class="advanced-submenu custom-settings" id="custom-image-tags-settings"><summary>自定义屏蔽标签 <span>追加图片过滤规则</span></summary><div class="advanced-content">
    <div class="field"><label>额外屏蔽标签（逗号分隔，留空即只用内置表）</label>
      <input type="text" id="cfg-img-aitags" value="${esc((is.aiBlockTags || []).join(','))}" placeholder="例如：ai生成,aiイラスト,novelai" />
      <div class="hint">
        原理：pixiv 用官方 aiType 标注判定；图库站按标签（ai生成 / aiイラスト / -ai 这类）过滤；
        最后本地还会把结果按标签再统一过一遍 —— 不依赖站点有没有标对。这里填的标签追加在内置表之后。
      </div></div>
    </div></details>

    <div class="checkbox-row"><input type="checkbox" id="cfg-img-r18" ${is.allowR18 === true ? 'checked' : ''} />
      <label for="cfg-img-r18">允许 R18 / 成人内容</label></div>
    <div class="hint" style="color:var(--red);font-weight:600">⚠ 开启后可能搜到成人内容，请自行确认合规（并确认只在合适的会话里用）。</div>

    <h3 style="margin-top:22px">画质 / 人气</h3>
    <div class="hint" style="margin-bottom:8px">
      决定"发出去的图好不好看、清不清晰"。前提：pixiv 的搜索接口<b>不返回收藏数</b>（未登录时 order=popular_d 也不生效），
      所以"按收藏数排序 / 收藏数门槛"只能给候选<b>逐个补查一次详情</b>，这一步省不掉 —— 慢的量级见下面各条说明。
    </div>
    <div class="field-row">
      <div class="field"><label>排序方式</label>
        <select id="cfg-img-sortby">
          <option value="popular" ${sortBy === 'popular' ? 'selected' : ''}>按收藏数排序（默认）</option>
          <option value="newest" ${sortBy === 'newest' ? 'selected' : ''}>按发布时间</option>
        </select>
        <div class="hint">
          按收藏数排序 = 发出来的图更可能是真好图，代价是<b>要给每个候选补查一次详情：20 个候选约 1 秒</b>
          （pixiv 搜索接口就是不返回收藏数，所以这步省不掉）。选「按发布时间」则不打这些额外请求，最快。
        </div></div>
      <div class="field"><label>收藏数门槛</label>
        <input type="number" id="cfg-img-minbm" min="0" max="1000000" step="10" value="${esc(is.minBookmarks ?? 0)}" />
        <div class="hint">
          0 = 不过滤；填 100 能挡掉大部分没人气的新图；填 1000 只看热门。
          填了非 0 值就会自动补查收藏数（即使排序选了「按发布时间」也会变慢），查不到收藏数的图按"未知"放行。
        </div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>最多给几个候选查人气（4~60）</label>
        <input type="number" id="cfg-img-rankpool" min="4" max="60" step="1" value="${esc(is.rankPool ?? 20)}" />
        <div class="hint">越大越准但越慢（60 个约 3 秒，20 个约 1 秒）。只影响"补查收藏数"的那一批候选。</div></div>
      <div class="field"><label>原图体积上限（MB，1~30）</label>
        <input type="number" id="cfg-img-maximgmb" min="1" max="30" step="1" value="${esc(is.maxImageMb ?? 12)}" />
        <div class="hint">
          发原图时先探一下体积，超过这个数就自动降级成大图，防止把 20MB 巨图塞进群里。
          注意它和下面那个「单张大小上限」不是一回事：这里是"原图太大就换小一档"，下面那个是"超过就干脆不发"。
        </div></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-img-preferorig" ${is.preferOriginal !== false ? 'checked' : ''} />
      <label for="cfg-img-preferorig"><b>优先发原图</b></label></div>
    <div class="hint">
      pixiv 原图常有 1~5MB，但比 540px 缩略图清晰得多；关掉会发中等尺寸（更省流量、更快）。
      开着也不会失控：超过上面「原图体积上限」会自动换成大图。
    </div>
    <div class="field"><label>最短边下限（px）</label>
      <input type="number" id="cfg-img-minpx" min="0" max="100000" step="50" value="${esc(is.minPixels ?? 0)}" />
      <div class="hint">0 = 不限；填 800 可挡掉小图。尺寸未知的候选会被放行（图库站经常不报尺寸）。</div></div>

    <div class="field-row" style="margin-top:10px">
      <div class="field"><label>一次搜几张（1~10）</label><input type="number" id="cfg-img-limit" min="1" max="10" step="1" value="${esc(is.defaultLimit ?? 3)}" /></div>
      <div class="field"><label>单张大小上限（MB）</label><input type="number" id="cfg-img-maxmb" min="0.5" max="30" step="0.5" value="${esc(is.maxDownloadMb ?? 8)}" />
        <div class="hint">超过就不发：太大发不出去，还占内存。</div></div>
      <div class="field"><label>超时（毫秒）</label><input type="number" id="cfg-img-timeout" min="3000" step="1000" value="${esc(is.timeoutMs ?? 15000)}" /></div>
    </div>
    <div class="field"><label>发送方式</label>
      <select id="cfg-img-sendmode">
        ${Object.entries(IMAGE_SEND_MODE_LABEL).map(([v, t]) => `<option value="${v}" ${sendMode === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select></div>
    <div class="field"><label>pixiv Cookie（可选）</label>
      <input type="password" id="cfg-img-cookie" value="" placeholder="${(is.hasCookie === true || is.cookieConfigured === true) ? '已保存 Cookie（留空即不变）' : '留空 = 游客身份搜公开作品'}" autocomplete="new-password" />
      <div class="hint">可选，但**很推荐填**：游客身份下 pixiv 的搜索接口容易被人机验证挡住（会看到"要求人机验证"），而且 R18 作品拿不到原图地址。<br />
        填法：浏览器登录 pixiv → F12 → 网络(Network) → 随便点一个 pixiv 的请求 → 把请求头里 <code>Cookie</code> 那一行**整行**复制过来。<br />
        出于安全，后端不回显 Cookie：这里永远是空的，<b>留空 = 保持不变</b>；要换成别的 Cookie 就整行重填一次。</div></div>

    <details class="advanced-submenu custom-settings" id="custom-image-settings"><summary>自定义搜图源 <span>添加与管理图源</span></summary><div class="advanced-content">
    <div class="hint" style="margin-bottom:8px">
      界面会以 GET 请求你的接口，并自动带上 <code>q</code> / <code>word</code> / <code>limit</code> / <code>page</code> 四个查询参数；
      返回的 JSON 可以是数组，也可以是 <code>data</code> / <code>results</code> / <code>posts</code> 字段里的数组。
      每项要能取到图片地址（url / file_url / sample_url / large / original / preview_url 都认）。填了 API Key 会按 <code>Authorization: Bearer</code> 发送。
    </div>
    <div id="cfg-img-custom-list">${customs.length ? customs.map(imageCustomRowHtml).join('') : '<div class="muted" style="font-size:12px">还没有自定义图源。</div>'}</div>
    <input type="hidden" id="cfg-img-providers-json" value="${esc(JSON.stringify(customs.map(normImageProvider)))}" />
    ${unknownKeyProvs.length ? `<div class="hint" style="color:var(--orange);font-weight:600">
      ⚠ ${unknownKeyProvs.map((p) => esc(p.name || p.id)).join('、')} 已经有 API Key，但后端不回显密钥。
      只要你改动这个列表（增删图源），保存时它们会被清空 —— 请在该行的密钥框里重填一次再保存。
      （只改本页其它设置、不动列表的话，密钥不受影响。）
    </div>` : ''}
    <div class="hint">密钥不回显是后端的策略：框里永远是空的，只有你重新输入才会更新。想清掉某个 Key，删掉这个图源再加一次即可。</div>
    <div class="field-row" style="margin-top:8px">
      <div class="field"><label>名称（自己辨认用）</label><input type="text" id="cfg-img-new-name" placeholder="例如：自建图库" /></div>
      <div class="field"><label>接口地址（GET）</label><input type="text" id="cfg-img-new-baseurl" placeholder="https://example.com/api/search" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label><input type="password" id="cfg-img-new-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" /></div>
      <div class="field"><label>Cookie（可选）</label><input type="password" id="cfg-img-new-cookie" placeholder="要登录的站点填这里" autocomplete="new-password" /></div>
      <div class="field"><label>超时（毫秒）</label><input type="number" id="cfg-img-new-timeout" min="3000" step="1000" value="15000" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:4px 0 8px;flex-wrap:wrap">
      <button class="btn btn-small" id="cfg-img-custom-add" type="button">＋ 添加到列表</button>
      <span id="cfg-img-custom-hint" class="muted" style="font-size:12px"></span>
    </div>
    </div></details>

    <details class="advanced-submenu custom-settings" id="custom-image-perchat-settings"><summary>自定义会话搜图设置 <span>按群覆盖</span></summary><div class="advanced-content">
    <div class="hint" style="margin-bottom:8px">
      个别群想用别的图源 / 单独关掉搜图时，在这里加一条。每项都能留空 —— <b>留空的项表示跟随全局设置</b>。
      会话名格式：群 <code>group:123456789</code>，私聊 <code>private:QQ号</code>。
    </div>
    <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:220px;margin-bottom:0"><label>会话（group:群号）</label>
        <input type="text" id="cfg-img-perchat-key" placeholder="group:123456789" /></div>
      <button class="btn btn-small" id="cfg-img-perchat-add" type="button">＋ 添加 / 覆盖</button>
      <span id="cfg-img-perchat-hint" class="muted" style="font-size:12px"></span>
    </div>
    <div id="cfg-img-perchat-list" style="margin-top:8px">
      ${perChatKeys.length ? perChatKeys.map((k) => imagePerChatRowHtml(k, perChat[k], customs)).join('') : '<div class="muted" style="font-size:12px">还没有按群覆盖 —— 所有会话都用上面的全局设置。</div>'}
    </div>
    <input type="hidden" id="cfg-img-perchat-json" value="${esc(JSON.stringify(perChat))}" />
    <div class="hint">删掉某条覆盖 = 该群恢复成完全跟随全局。这些改动都要点上面的「保存设置」才会生效。</div>
    </div></details>

    <h3 style="margin-top:22px">以图搜图</h3>
    <div class="hint" style="margin-bottom:8px">
      群里有人发图、她拿不准这张图的来源时用这个反查（工具 <code>reverse_image_search</code>）。
      <b>现在开箱可用</b>的是 <b>iqdb</b>（找同款 / 更高清版本）和 <b>trace.moe</b>（判断是不是动画截图、是第几集）—— 这两个<b>免 key</b>。
      <b>SauceNAO 是最准的反查</b>，能直接给出 pixiv 作品号，但<b>必须注册免费 key</b>：匿名调用会被官方拒绝。
      去 saucenao.com 注册后，在账号页（Account → API Key）能看到 key，填到下面即可。
    </div>
    <div class="field"><label>SauceNAO API Key（可选）</label>
      <input type="password" id="cfg-img-saucenaokey" value="" placeholder="${esc(sauceKeyPresent ? '已设置密钥（留空即不变；要重填请完整输入一次）' : '留空 = 不用 SauceNAO（iqdb / trace.moe 仍然可用）')}" autocomplete="new-password" />
      <div class="hint">
        跟自定义图源的 API Key 一样，<b>后端不回显密钥</b>：这个框永远是空的，只有你真输入了非空值才会写进配置 ——
        <b>留空 = 不变</b>；要重填就重新完整输入一次（不是补几位，是整串重打）。
      </div></div>
    <div class="hint" style="margin-bottom:8px">
      以图搜图<b>没有试搜按钮</b>：它吃的是群里的图片消息，本页没法凭空造一张图出来验，所以不做按钮。
      要验证就去群里发一张图、让她反查一次，再按那条消息的 <code>#编号</code> 去会话详情里看她到底查到了什么。
    </div>

    <h3 style="margin-top:22px">试搜</h3>
    <div class="hint" style="margin-bottom:8px">
      只是拿当前配置试一下能不能搜到、会不会被过滤掉，不会发图、不写记录。
      注意<b>试搜只能验图源</b>（能不能搜到、AI 过滤和尺寸过滤对不对）；<b>以图搜图不在这里试</b> —— 那要用群里的图片消息验证（用那条消息的 #编号）。
    </div>
    <div class="field-row">
      <div class="field"><label>搜索词</label><input type="text" id="cfg-img-test-query" placeholder="例如：猫 ／ 初音ミク ／ 1234567（pixiv 作品号）" /></div>
      <div class="field"><label>图源</label><select id="cfg-img-test-provider">${imageProviderOptions('', customs, '跟随当前配置')}</select></div>
      <div class="field"><label>张数</label><input type="number" id="cfg-img-test-limit" min="1" max="10" step="1" value="${esc(is.defaultLimit ?? 3)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-img-test-hideai" ${is.hideAi !== false ? 'checked' : ''} />
      <label for="cfg-img-test-hideai">这次试搜屏蔽 AI 图</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-img-test-r18" ${is.allowR18 === true ? 'checked' : ''} />
      <label for="cfg-img-test-r18">这次试搜允许 R18（还要先在上面打开「允许 R18」并保存，否则无效）</label></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-small btn-primary" id="cfg-img-test-btn" type="button">试搜</button>
      <span id="cfg-img-test-hint" class="muted" style="font-size:12px"></span>
    </div>
    <div id="cfg-img-test-result" style="margin-top:10px"></div>`;
}

/* ══════════════════════════════════════════════════════════════
   设置 → 梗知识库（section id: meme）
   ══════════════════════════════════════════════════════════════
   列表数据来自 /api/memes（不是 state.config）：进入页面拉一次，之后每次
   增删改再拉一次，保证页面显示的是后端的真实状态。
   只有上面那组开关/数字走 state.config + saveConfig 的 patch.meme。
*/

const MEME_KIND_LABEL = { game: '游戏梗', net: '网梗', group: '群内黑话', anime: '二次元', other: '其他' };
const MEME_KIND_ORDER = ['game', 'net', 'group', 'anime', 'other'];

/** 拉一次最新梗库数据，然后重画动态区（进入页面、增删改、导入之后都走这里）。 */
async function loadMemes() {
  const seq = ++memeLoadSeq;
  try {
    const d = await api('/api/memes');
    if (seq !== memeLoadSeq) return;    // 有更新的请求在路上，丢弃这次结果
    state.memes = d || null;
    memeLoadError = '';
  } catch (e) {
    if (seq !== memeLoadSeq) return;
    memeLoadError = String(e?.message || e);
  }
  refreshMemeDynamic();
}

/** 只重画 #meme-dynamic（不动上面的开关/数字，也就不会打断用户正在编辑的配置项）。 */
function refreshMemeDynamic() {
  const box = $('#meme-dynamic');
  if (!box) return;   // 已经切到别的设置页：什么都不做
  box.innerHTML = memeDynamicHtml();
  bindMemeDynamicEvents();   // 事件必须在渲染后绑定
}

function memeStatsLineHtml() {
  const s = state.memes?.stats || null;
  if (!s) return '<div class="muted" style="font-size:12px">统计不可用（梗库模块可能未加载）。</div>';
  const byKind = MEME_KIND_ORDER
    .filter((k) => Number(s.byKind?.[k]))
    .map((k) => `${MEME_KIND_LABEL[k]} ${Number(s.byKind[k])}`)
    .join(' · ');
  return `<div class="muted" style="font-size:12.5px">
    共 ${Number(s.total) || 0} 条（启用 ${Number(s.enabled) || 0}，置顶 ${Number(s.pinned) || 0}，用过 ${Number(s.used) || 0}）
    ${byKind ? ` · ${esc(byKind)}` : ''}
  </div>`;
}

/** 一条梗在列表里的一行。 */
function memeRowHtml(e) {
  const aliases = (e.aliases || []).length ? `（也叫 ${(e.aliases || []).join(' / ')}）` : '';
  const useCases = (e.useCases || []).slice(0, 2);
  const examples = (e.examples || []).slice(0, 2);
  const badge = (text, color = '') => `<span class="status-badge" style="background:var(--bg-3);border:1px solid var(--border);${color}">${esc(text)}</span>`;
  return `
    <div style="padding:8px 0;border-bottom:1px solid var(--color-border-tertiary,#3333)">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div style="min-width:0">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <b>${esc(e.text)}</b>
            ${aliases ? `<span class="muted" style="font-size:12px">${esc(aliases)}</span>` : ''}
            ${badge(MEME_KIND_LABEL[e.kind] || e.kind || '其他')}
            <span class="muted" style="font-size:11.5px">优先级 ${esc(e.priority ?? 3)}</span>
            ${e.scope === 'chat' ? badge(`只在 ${formatChatTitle(e.chatKey, chatNameOf(e.chatKey))}`) : '<span class="muted" style="font-size:11.5px">全局</span>'}
            ${e.pinned ? badge('已置顶') : ''}
            ${e.enabled === false ? badge('已停用', 'color:var(--red)') : ''}
            ${e.origin === 'model' ? badge('机器人自记') : (e.origin === 'import' ? badge('导入') : '')}
          </div>
          <div class="muted" style="font-size:12px;margin-top:2px">${esc(e.means || '（没有填意思）')}</div>
          ${useCases.length ? `<div class="muted" style="font-size:11.5px">用法：${esc(useCases.join('；'))}</div>` : ''}
          ${examples.length ? `<div class="muted" style="font-size:11.5px">例：${esc(examples.join('；'))}</div>` : ''}
          <div class="muted" style="font-size:11.5px">
            用过 ${Number(e.useCount) || 0} 次${e.lastUsedAt ? ` · 上次 ${esc(fmtTime(e.lastUsedAt))}${e.lastContext ? `（${esc(e.lastContext)}）` : ''}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-small" data-act="edit" data-id="${esc(e.id)}">编辑</button>
          <button class="btn btn-small" data-act="toggle" data-id="${esc(e.id)}">${e.enabled === false ? '启用' : '停用'}</button>
          <button class="btn btn-small" data-act="pin" data-id="${esc(e.id)}">${e.pinned ? '取消置顶' : '置顶'}</button>
          <button class="btn btn-small btn-danger" data-act="del" data-id="${esc(e.id)}">删除</button>
        </div>
      </div>
    </div>`;
}

/** 列表区（过滤后）。过滤是纯前端的，不重新请求接口。 */
function memeListHtml() {
  if (memeLoadError) {
    return `<div class="hint" style="color:var(--red)">梗库加载失败：${esc(memeLoadError)}</div>
      <div class="hint">确认应用后端在运行；若刚重启过后端，切走再切回本页会重新拉取。</div>`;
  }
  if (!state.memes) return '<div class="muted" style="font-size:12px">加载中…</div>';
  const all = Array.isArray(state.memes.memes) ? state.memes.memes : [];
  const kw = memeFilterText.trim().toLowerCase();
  const list = all.filter((e) => {
    if (memeFilterKind && e.kind !== memeFilterKind) return false;
    if (!kw) return true;
    return [e.text, ...(e.aliases || []), e.means, e.source, e.avoid, ...(e.tags || []), ...(e.useCases || []), ...(e.examples || [])]
      .join(' ').toLowerCase().includes(kw);
  });
  if (!all.length) {
    return '<div class="muted" style="font-size:12px;padding:6px 0">库里还没有梗。用下面的表单加一条，或者把梗写进 memes.md 再点「从 memes.md 导入」。</div>';
  }
  if (!list.length) return '<div class="muted" style="font-size:12px;padding:6px 0">没有匹配的梗（换个关键词或类型）。</div>';
  return `<div class="muted" style="font-size:11.5px;margin-bottom:4px">显示 ${list.length} / ${all.length} 条</div>${list.map(memeRowHtml).join('')}`;
}

/** 新建 / 编辑表单（编辑时把该条数据填进来）。 */
function memeFormHtml() {
  const editing = memeEditingId ? (state.memes?.memes || []).find((e) => e.id === memeEditingId) || null : null;
  const e = editing || {};
  const scope = e.scope === 'chat' ? 'chat' : 'global';
  return `
    <h4 style="margin:18px 0 8px">${editing ? `编辑「${esc(editing.text)}」` : '新建一条梗'}</h4>
    ${editing ? '<div class="hint" style="margin-bottom:6px">改完点「保存修改」。点「取消编辑」清空表单，回到新建。</div>' : ''}
    <div class="field-row">
      <div class="field"><label>梗名（必填，短）</label><input type="text" id="meme-f-text" value="${esc(e.text || '')}" placeholder="例如：yyds" /></div>
      <div class="field"><label>别名（逗号分隔，可选）</label><input type="text" id="meme-f-aliases" value="${esc((e.aliases || []).join(','))}" placeholder="例如：永远的神,永远滴神" /></div>
      <div class="field"><label>类型</label>
        <select id="meme-f-kind">
          ${MEME_KIND_ORDER.map((k) => `<option value="${k}" ${(e.kind || 'net') === k ? 'selected' : ''}>${esc(MEME_KIND_LABEL[k])}</option>`).join('')}
        </select></div>
    </div>
    <div class="field"><label>意思（1~2 句，说清是什么）</label>
      <textarea id="meme-f-means" style="min-height:56px" placeholder="例如：永远的神，用来夸某人/某物强到没话说">${esc(e.means || '')}</textarea></div>
    <div class="field-row">
      <div class="field"><label>出处（可选）</label><input type="text" id="meme-f-source" value="${esc(e.source || '')}" placeholder="例如：某主播直播间" /></div>
      <div class="field"><label>别用场景（可选，单行）</label><input type="text" id="meme-f-avoid" value="${esc(e.avoid || '')}" placeholder="例如：严肃话题、有人真的在难过时" /></div>
    </div>
    <div class="field"><label style="color:var(--accent)"><b>适用场景（一行一条）—— 最重要的一栏</b>：什么话题 / 什么情绪下能用</label>
      <textarea id="meme-f-usecases" style="min-height:86px" placeholder="有人吹某个东西很厉害时&#10;有人自嘲菜的时候">${esc((e.useCases || []).join('\n'))}</textarea>
      <div class="hint">她按这一栏判断"现在能不能用这个梗"。写得越具体越不容易尬用。</div></div>
    <div class="field"><label style="color:var(--accent)"><b>范例句（一行一条）—— 照这个语气说，别照抄</b></label>
      <textarea id="meme-f-examples" style="min-height:86px" placeholder="这也太 yyds 了吧&#10;行，你是 yyds，我服">${esc((e.examples || []).join('\n'))}</textarea></div>
    <div class="field-row">
      <div class="field"><label>标签（逗号分隔，可选）</label><input type="text" id="meme-f-tags" value="${esc((e.tags || []).join(','))}" placeholder="例如：夸奖,直播" /></div>
      <div class="field"><label>优先级</label>
        <select id="meme-f-priority">
          ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${Number(e.priority ?? 3) === n ? 'selected' : ''}>${n}${n === 3 ? '（默认）' : n === 5 ? '（最高）' : n === 1 ? '（最低）' : ''}</option>`).join('')}
        </select>
        <div class="hint">越高越容易被注入提示词：常用梗填 4~5，冷门填 2。</div></div>
      <div class="field"><label>作用范围</label>
        <select id="meme-f-scope">
          <option value="global" ${scope === 'global' ? 'selected' : ''}>全局（所有会话可用）</option>
          <option value="chat" ${scope === 'chat' ? 'selected' : ''}>只在某个群</option>
        </select></div>
    </div>
    <div class="field" id="meme-f-chatkey-wrap" style="${scope === 'chat' ? '' : 'display:none'}">
      <label>群号（格式 <code>group:群号</code>）</label>
      <input type="text" id="meme-f-chatkey" value="${esc(e.chatKey || '')}" placeholder="group:123456789" />
      <div class="hint">只在群内黑话这种"出了这个群没人懂"的梗上用；全局梗不用填。</div></div>
    <div class="checkbox-row"><input type="checkbox" id="meme-f-enabled" ${e.enabled !== false ? 'checked' : ''} />
      <label for="meme-f-enabled">启用这条梗</label></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-primary btn-small" id="meme-f-submit" type="button">${editing ? '保存修改' : '＋ 新建'}</button>
      ${editing ? '<button class="btn btn-small" id="meme-f-cancel" type="button">取消编辑</button>' : ''}
      <span class="muted" id="meme-f-hint" style="font-size:12px"></span>
    </div>`;
}

/** 动态区（统计 + 过滤 + 列表 + 表单 + 文件区）。 */
function memeDynamicHtml() {
  const files = state.memes?.files || null;
  const notice = memeNotice
    ? `<div class="hint" style="margin-bottom:8px;font-size:12.5px;${memeNotice.kind === 'error' ? 'color:var(--red)' : 'color:var(--accent)'}">${esc(memeNotice.text)}</div>`
    : '';
  const fileLine = (label, p) => `<div class="muted" style="font-size:11.5px">${esc(label)}：<code style="user-select:text">${esc(p || '（未知）')}</code></div>`;
  return `
    ${notice}
    <h4 style="margin:16px 0 8px">梗列表</h4>
    ${memeStatsLineHtml()}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0">
      <input type="text" id="meme-filter-text" value="${esc(memeFilterText)}" placeholder="按梗名 / 别名 / 意思 / 场景筛…" style="flex:1;min-width:200px" />
      <select id="meme-filter-kind" style="max-width:150px">
        <option value="">全部类型</option>
        ${MEME_KIND_ORDER.map((k) => `<option value="${k}" ${memeFilterKind === k ? 'selected' : ''}>${esc(MEME_KIND_LABEL[k])}</option>`).join('')}
      </select>
      <button class="btn btn-small" id="meme-reload" type="button">刷新</button>
    </div>
    <div id="meme-list-box">${memeListHtml()}</div>
    ${memeFormHtml()}

    <h4 style="margin:18px 0 8px">导入 / 文件</h4>
    <div class="hint" style="margin-bottom:6px">
      可以直接手改 <code>memes.json</code>，也可以把梗按 markdown 格式写进 <code>memes.md</code> 再点「从 memes.md 导入」。
      导入是<b>同名合并</b>的：同名的梗只补充更新，不会重复建条目。格式模板见同目录的 <code>README.md</code>。
    </div>
    ${fileLine('数据文件', files?.data)}
    ${fileLine('导入文件', files?.import)}
    ${fileLine('格式说明', files?.readme)}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-small" id="meme-import-btn" type="button">从 memes.md 导入</button>
      <button class="btn btn-small" id="meme-initfiles-btn" type="button">重新生成说明文件</button>
      <span class="muted" id="meme-file-hint" style="font-size:12px"></span>
    </div>`;
}

/** 设置 → 梗知识库。 */
function renderMemeSection(c) {
  const m = c.meme || {};
  memeNotice = null;   // 重新进页面时不要把上次的提示再翻出来
  // 列表数据是异步的：先渲染骨架（若有缓存则直接带出列表），紧接着拉一次最新数据填进去
  setTimeout(() => { loadMemes(); }, 0);
  return `
    <h3 id="settings-meme">梗知识库</h3>
    <div class="hint" style="margin-bottom:10px">
      她的"梗词典"。聊天时按当前话题相关度挑几条注入提示词，也可以随时用 <code>meme_search</code> 工具翻；
      每条梗的<b>适用场景</b>和<b>范例句</b>就是给她的使用说明书 —— 这两栏写清楚，她才用得对、不尬用。
      数据存在本地文件里，可手改、可从 markdown 导入，机器人自己也能用 <code>meme_note</code> 往里记。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-meme-enabled" ${m.enabled !== false ? 'checked' : ''} />
      <label for="cfg-meme-enabled"><b>启用梗知识库</b>（关掉后不注入、也记不进新梗）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-meme-inject" ${m.injectEnabled !== false ? 'checked' : ''} />
      <label for="cfg-meme-inject">把挑出来的梗注入提示词（关掉就只剩 meme_search 工具可查）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-meme-autonote" ${m.autoNote !== false ? 'checked' : ''} />
      <label for="cfg-meme-autonote">允许机器人自己记梗（用 meme_note 记，列表里会标"机器人自记"）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-meme-recordusage" ${m.recordUsage !== false ? 'checked' : ''} />
      <label for="cfg-meme-recordusage">记录使用次数与上次语境（用来判断哪些梗真的在用）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-meme-chatscope" ${m.chatScopeEnabled !== false ? 'checked' : ''} />
      <label for="cfg-meme-chatscope">允许"只在某个群使用"的梗（scope = chat，比如群内黑话）</label></div>
    <div class="field-row" style="margin-top:10px">
      <div class="field"><label>单次注入几条（0~30）</label><input type="number" id="cfg-meme-injectmax" min="0" max="30" step="1" value="${esc(m.injectMax ?? 8)}" /></div>
      <div class="field"><label>注入字符预算</label><input type="number" id="cfg-meme-injectchars" min="200" step="100" value="${esc(m.injectMaxChars ?? 1200)}" />
        <div class="hint">超过预算就少注入几条，省 token。</div></div>
      <div class="field"><label>meme_search 默认返回条数</label><input type="number" id="cfg-meme-searchmax" min="1" max="50" step="1" value="${esc(m.searchMax ?? 8)}" /></div>
    </div>
    <div class="hint">注入条数填 0 = 一条都不注入（只留 meme_search 工具让她按需查）。</div>

    <div id="meme-dynamic">${memeDynamicHtml()}</div>`;
}

/** 梗库动态区的事件绑定（每次重画 #meme-dynamic 后都要调一次）。 */
function bindMemeDynamicEvents() {
  // 列表按钮：编辑 / 启停 / 置顶 / 删除（委托到列表容器，过滤重画后依然有效）
  const listBox = $('#meme-list-box');
  if (listBox) listBox.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const item = (state.memes?.memes || []).find((x) => x.id === id) || null;
    const act = btn.dataset.act;
    if (act === 'edit') {
      memeEditingId = id;
      memeNotice = null;
      refreshMemeDynamic();
      $('#meme-f-text')?.focus();
      return;
    }
    if (act === 'del') {
      if (!confirm(`确定删除「${item?.text || id}」？删了就没了（memes.json 里的这条会被移除）。`)) return;
      try {
        await api(`/api/memes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (memeEditingId === id) memeEditingId = null;
        memeNotice = { text: `已删除「${item?.text || id}」`, kind: 'ok' };
        await loadMemes();
      } catch (e) {
        memeNotice = { text: `删除失败：${e.message}`, kind: 'error' };
        refreshMemeDynamic();
      }
      return;
    }
    // 启停 / 置顶：局部更新
    const patchBody = act === 'toggle'
      ? { enabled: !(item?.enabled !== false) }
      : { pinned: !(item?.pinned === true) };
    try {
      await api(`/api/memes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patchBody) });
      memeNotice = null;
      await loadMemes();
    } catch (e) {
      memeNotice = { text: `操作失败：${e.message}`, kind: 'error' };
      refreshMemeDynamic();
    }
  });

  // 过滤（纯前端，不重新请求接口）
  const filterText = $('#meme-filter-text');
  if (filterText) filterText.addEventListener('input', () => {
    memeFilterText = filterText.value;
    const box = $('#meme-list-box');
    if (box) box.innerHTML = memeListHtml();
  });
  const filterKind = $('#meme-filter-kind');
  if (filterKind) filterKind.addEventListener('change', () => {
    memeFilterKind = filterKind.value;
    const box = $('#meme-list-box');
    if (box) box.innerHTML = memeListHtml();
  });
  $('#meme-reload')?.addEventListener('click', () => { memeNotice = null; loadMemes(); });

  // 表单：作用范围切换 → 显隐群号
  const scopeSel = $('#meme-f-scope');
  if (scopeSel) scopeSel.addEventListener('change', () => {
    const wrap = $('#meme-f-chatkey-wrap');
    if (wrap) wrap.style.display = scopeSel.value === 'chat' ? '' : 'none';
  });
  $('#meme-f-submit')?.addEventListener('click', () => submitMemeForm());
  $('#meme-f-cancel')?.addEventListener('click', () => {
    memeEditingId = null;
    memeNotice = null;
    refreshMemeDynamic();
  });

  // 导入 / 重新生成模板文件
  const importBtn = $('#meme-import-btn');
  if (importBtn) importBtn.addEventListener('click', async () => {
    const out = $('#meme-file-hint');
    importBtn.disabled = true;
    if (out) out.textContent = '导入中…';
    try {
      const r = await api('/api/memes/import', { method: 'POST', body: '{}' });
      memeNotice = {
        text: `导入完成：新增 ${Number(r.added) || 0} 条，合并更新 ${Number(r.merged) || 0} 条${Number(r.failed) ? `，失败 ${Number(r.failed)} 条（${(r.errors || []).join('；')}）` : ''} · 现在共 ${Number(r.total) || 0} 条`,
        kind: 'ok'
      };
      await loadMemes();
    } catch (e) {
      memeNotice = { text: `导入失败：${e.message}`, kind: 'error' };
      refreshMemeDynamic();
    } finally {
      const btn2 = $('#meme-import-btn');
      if (btn2) btn2.disabled = false;
    }
  });
  const initBtn = $('#meme-initfiles-btn');
  if (initBtn) initBtn.addEventListener('click', async () => {
    const out = $('#meme-file-hint');
    initBtn.disabled = true;
    if (out) out.textContent = '生成中…';
    try {
      const r = await api('/api/memes/init-files', { method: 'POST', body: '{}' });
      memeNotice = { text: `已重新生成：${r.files?.readme || 'README.md'} / ${r.files?.import || 'memes.md'}`, kind: 'ok' };
      await loadMemes();
    } catch (e) {
      memeNotice = { text: `生成失败：${e.message}`, kind: 'error' };
      refreshMemeDynamic();
    } finally {
      const btn2 = $('#meme-initfiles-btn');
      if (btn2) btn2.disabled = false;
    }
  });
}

/** 提交新建 / 编辑表单。同名同作用域会被后端自动合并，这里提示"已补充更新"。 */
async function submitMemeForm() {
  const hint = $('#meme-f-hint');
  const btn = $('#meme-f-submit');
  const text = ($('#meme-f-text')?.value || '').trim();
  if (!text) { if (hint) hint.textContent = '梗名（text）不能为空'; return; }
  const scope = $('#meme-f-scope')?.value === 'chat' ? 'chat' : 'global';
  const chatKey = ($('#meme-f-chatkey')?.value || '').trim();
  if (scope === 'chat' && !/^(group|private):\d{1,15}$/.test(chatKey)) {
    if (hint) hint.textContent = '群号要写成 group:123456789 这种格式';
    return;
  }
  const body = {
    text,
    aliases: parseCommaList($('#meme-f-aliases')?.value),
    kind: $('#meme-f-kind')?.value || 'net',
    means: ($('#meme-f-means')?.value || '').trim(),
    source: ($('#meme-f-source')?.value || '').trim(),
    useCases: parseLineList($('#meme-f-usecases')?.value),
    examples: parseLineList($('#meme-f-examples')?.value),
    avoid: ($('#meme-f-avoid')?.value || '').trim(),
    tags: parseCommaList($('#meme-f-tags')?.value),
    priority: clampInt($('#meme-f-priority')?.value, 1, 5, 3),
    scope,
    chatKey: scope === 'chat' ? chatKey : '',
    enabled: !!$('#meme-f-enabled')?.checked
  };
  const editingId = memeEditingId;
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const r = editingId
      ? await api(`/api/memes/${encodeURIComponent(editingId)}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await api('/api/memes', { method: 'POST', body: JSON.stringify(body) });
    memeEditingId = null;
    memeNotice = editingId
      ? { text: `已保存「${text}」的修改`, kind: 'ok' }
      : (r?.merged
        ? { text: `已存在同名同作用域的梗，这次是补充更新（没有重复建条目）`, kind: 'ok' }
        : { text: `已新建「${text}」`, kind: 'ok' });
    await loadMemes();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = editingId ? '保存修改' : '＋ 新建'; }
    if (hint) hint.textContent = `保存失败：${e.message}`;
  }
}

/** 提醒时间显示（列表与设置共用）。 */
function fmtDateTime(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 重复说明（与后端 repeatLabel 保持一致的文案）。 */
function repeatLabelUi(rep) {
  const r = rep || { kind: 'none' };
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  switch (r.kind) {
    case 'daily': return '每天';
    case 'weekly': return (r.weekdays || []).length ? `每周${(r.weekdays || []).map((d) => names[d - 1] || d).join('、')}` : '每周';
    case 'interval': {
      const iv = Number(r.intervalMs) || 0;
      if (iv % 86400000 === 0) return `每 ${iv / 86400000} 天`;
      if (iv % 3600000 === 0) return `每 ${iv / 3600000} 小时`;
      return `每 ${Math.max(1, Math.round(iv / 60000))} 分钟`;
    }
    default: return '一次性';
  }
}

function renderPersonaSection(c) {
  // 人设列表是异步数据，renderSettings 之后单独填一次
  setTimeout(() => { try { renderPersonaList(); } catch { /* ignore */ } }, 0);
  return `
    <div class="section-intro"><div class="eyebrow">PERSONA</div><h2>让机器人像你想要的那样说话</h2><p>先选一份人设，再改名字、参与度和角色设定。其余选项保持默认即可。</p></div>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="field"><label>角色设定</label><div class="hint">用日常语言描述性格、语气和禁忌；留原样即沿用当前人设。</div>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是群里说话简洁、会适度开玩笑的朋友……">${esc(c.persona.roleText || '')}</textarea></div>
    <details class="advanced-submenu"><summary>高级设置 <span>可选 · 未修改则保持当前默认</span></summary>
      <div class="advanced-content">
        <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
        <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
          <textarea id="cfg-customrules" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
        ${renderBodyAndLimitsSection(c)}
      </div>
    </details>
    ${renderPersonaSaveBar()}`;
}

function memoryRecordSummary(key) {
  if (key === '__global__') {
    const s = state.globalMemory?.stats;
    return s ? `${s.people} 人 · ${s.facts} 条事实 · ${s.events} 件长期事件 · ${s.surface || 0} 条表层记忆` : '尚未加载记录';
  }
  if (key === '__reminders__') {
    const s = state.reminders?.stats;
    return s ? `已保存 ${s.total || 0} 条 · 待触发 ${s.pending || 0} 条 · 错过 ${s.missed || 0} 条` : '尚未加载记录';
  }
  const s = state.style?.stats;
  return s ? `样本 ${s.samples || 0} 条 · 说话逻辑 ${s.speechItems || 0} 条 · 图片表情反应 ${s.reactionItems || 0} 条` : '尚未加载记录';
}

function memoryRecordPreview(key) {
  if (key === '__global__') {
    const people = state.globalMemory?.people || [];
    const events = state.globalMemory?.events || [];
    const rows = [
      ...people.slice(0, 10).map((p) => `<div><b>${esc(p.name || p.userId)}</b>：${esc((p.facts || []).map((f) => f.content).join('；') || '暂无事实')}</div>`),
      ...events.slice(0, 10).map((e) => `<div><b>长期事件</b>：${esc(e.text)}</div>`)
    ];
    return rows.length ? rows.join('') : '<div>还没有保存跨群档案或长期事件。</div>';
  }
  if (key === '__reminders__') {
    const items = state.reminders?.items || [];
    return items.length
      ? items.slice(0, 20).map((e) => `<div>${esc(fmtDateTime(e.dueAt))} · ${esc(e.text)} · ${esc(e.status)}</div>`).join('')
      : '<div>还没有保存提醒。</div>';
  }
  const items = state.style?.items || [];
  const samples = state.style?.samples || [];
  const rows = [
    ...items.slice(0, 20).map((e) => `<div><b>${e.kind === 'speech' ? '说话逻辑' : '图片/表情反应'}</b>：${esc(e.text)}</div>`),
    ...samples.slice(-10).reverse().map((s) => `<div><b>样本</b>：${esc(s.text)}</div>`)
  ];
  return rows.length ? rows.join('') : '<div>还没有保存风格样本或规则。</div>';
}

function renderMemoryRecordActions(key, label) {
  return `<div class="memory-record-actions">
    <h4>${esc(label)} · 已保存内容</h4>
    <div id="memory-record-summary" class="muted">${esc(memoryRecordSummary(key))}</div>
    <details class="memory-record-preview"><summary>在此查看已保存内容</summary>
      <div id="memory-record-preview-content">${memoryRecordPreview(key)}</div>
      <div class="hint">这里只显示部分记录；完整列表和单条管理可在下方展开。</div>
    </details>
    <div class="memory-record-buttons">
      <button class="btn btn-small" type="button" id="memory-record-open" data-key="${key}" aria-expanded="false" aria-controls="settings-memory-records">查看和管理记录</button>
      <button class="btn btn-small btn-danger" type="button" id="memory-record-reset" data-key="${key}">初始化记录（清空已保存内容）</button>
    </div>
    <div class="hint">初始化会清空当前人设的${esc(label)}，之后可以重新积累；功能开关和参数会保留。</div>
  </div><div id="settings-memory-records" class="settings-record-manager hidden"></div>`;
}

function settingsMemoryDetail(section) {
  if (state.tab !== 'settings' || state.settingsSection !== section) return null;
  const panel = $('#settings-memory-records');
  return panel && !panel.classList.contains('hidden') ? panel : null;
}

async function loadSettingsMemoryDetail() {
  const load = { memory: loadGlobalMemoryDetail, reminder: loadRemindersDetail, style: loadStyleDetail }[state.settingsSection];
  if (load) await load();
}

// 只刷新摘要与展开的管理面板，保留功能设置中尚未保存的输入。
async function refreshSettingsMemoryState(section, { force = false } = {}) {
  const key = { memory: '__global__', reminder: '__reminders__', style: '__style__' }[section];
  if (!key) return;
  if (section === 'memory') {
    try { state.globalMemory = await api('/api/memory-global'); } catch { return; }
  } else if (section === 'reminder') await refreshReminderState();
  else await refreshStyleState();
  if (state.tab !== 'settings' || state.settingsSection !== section) return;
  const summary = $('#memory-record-summary');
  if (summary) summary.textContent = memoryRecordSummary(key);
  const preview = $('#memory-record-preview-content');
  if (preview) preview.innerHTML = memoryRecordPreview(key);
  const panel = settingsMemoryDetail(section);
  if (panel && (force || !panel.contains(document.activeElement))) await loadSettingsMemoryDetail();
}

/**
 * 身体反应 + 分寸（R18）设置区。
 * 单独抽成函数：这段文案比较长，内联在 renderPersonaSection 里会淹没上面的核心字段。
 */
function renderBodyAndLimitsSection(c) {
  const p = c.persona || {};
  const touch = p.touchReaction !== false;
  const depth = p.touchDepth === 'deep' ? 'deep' : 'light';
  const nsfw = p.nsfw === true;
  const scope = (p.nsfwScope === 'all' || p.nsfwScope === 'whitelist') ? p.nsfwScope : 'private';
  const wlText = (Array.isArray(p.nsfwWhitelist) ? p.nsfwWhitelist : []).join(', ');
  // 白名单输入框只在"开了 R18 且范围选了白名单"时显示
  const showWl = nsfw && scope === 'whitelist';
  return `
    <h3 style="margin-top:18px">身体反应与分寸</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-touch-reaction" ${touch ? 'checked' : ''} />
      <label for="cfg-touch-reaction">触碰反应</label></div>
    <div class="hint" style="margin:-4px 0 8px 22px">群友在文字里描写触碰（摸头、捏脸、牵手、抱一下…）时，按部位和关系亲疏给出反应，而不是没反应或每次都脸红。</div>
    <div class="field" id="touch-depth-box" style="${touch ? '' : 'display:none'}"><label>反应细致度</label>
      <select id="cfg-touch-depth">
        <option value="light" ${depth === 'light' ? 'selected' : ''}>含蓄（只用言语、表情、动作）</option>
        <option value="deep" ${depth === 'deep' ? 'selected' : ''}>细致（可描写身体反应，如心跳、发烫）</option>
      </select>
      <div class="hint" style="margin-top:6px">只管"被触碰时"的反应写多细：含蓄档只写躲开/拍开这类外部动作；细致档允许写身体内部感受（心跳、发烫、发软），并放宽这条消息的长度限制。<br />注意：它<b>不控制</b>成人向内容的尺度 —— 想聊得更放开请用下面的「成人向对话」。</div></div>

    <div class="checkbox-row" style="margin-top:12px"><input type="checkbox" id="cfg-nsfw" ${nsfw ? 'checked' : ''} />
      <label for="cfg-nsfw">成人向对话（R18）</label></div>
    <div class="hint" style="margin:-4px 0 8px 22px">开启后遇到成人话题 / 性暗示时，会<b>正面回应并允许主动推进</b>（可写情欲与身体细节），不再只是嘴硬推开。<b>未成年人、非自愿 / 胁迫 / 暴力 / 药物、真实个人信息与线下见面，无论开关与否一律拒绝。</b></div>
    <div class="field" id="nsfw-scope-box" style="${nsfw ? '' : 'display:none'}"><label>生效范围</label>
      <select id="cfg-nsfw-scope">
        <option value="private" ${scope === 'private' ? 'selected' : ''}>仅私聊（推荐）</option>
        <option value="whitelist" ${scope === 'whitelist' ? 'selected' : ''}>仅白名单里的会话</option>
        <option value="all" ${scope === 'all' ? 'selected' : ''}>私聊与群聊都生效（全部）</option>
      </select></div>
    <div class="field" id="nsfw-whitelist-box" style="${showWl ? '' : 'display:none'}">
      <label>白名单会话（逗号分隔）</label>
      <input type="text" id="cfg-nsfw-whitelist" value="${esc(wlText)}" placeholder="group:123456, private:987654" />
    </div>
    <div class="hint" id="nsfw-whitelist-hint" style="${showWl ? '' : 'display:none'}">只在这里列出的会话里解除回避，其余会话照常回避。写 <code>group:群号</code> 或 <code>private:QQ号</code>；只写号码（如 <code>123456</code>）则群和私聊都算命中。</div>
    <div class="hint" id="nsfw-scope-hint" style="${nsfw ? '' : 'display:none'}">群聊里发这类内容容易违规并影响群，除非确认群成员都是成年人且群规允许，否则保持"仅私聊"或改用白名单。</div>`;
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * ⚠️ 必须与 src/tier-slider.js 保持完全一致 —— 后端保存配置时会用它
 *    **重新权威换算**档位与概率，所以前端即使算错也不会影响实际行为；
 *    但两边不一致会让"界面显示的档位"和"实际生效的档位"对不上，造成困惑。
 *    ui/app.js 是普通 script（非 ES module），无法 import，只能镜像一份。
 */
const TIER_SLIDER_BANDS = { tier1End: 10, tier2End: 20, tier3End: 90 };

function sliderToTierUI(pos) {
  const b = TIER_SLIDER_BANDS;
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));
  if (p <= b.tier1End) return { tier: 1, randomPercent: 0 };
  if (p <= b.tier2End) return { tier: 2, randomPercent: 0 };
  if (p <= b.tier3End) {
    const pct = ((p - b.tier2End) / (b.tier3End - b.tier2End)) * 100;
    return { tier: 3, randomPercent: Math.round(pct * 10) / 10 };
  }
  return { tier: 4, randomPercent: 100 };
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const b = TIER_SLIDER_BANDS;
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  const t = Math.min(4, Math.max(1, Number(st?.contextTier) || 4));
  const pct = Math.min(100, Math.max(0, Number(st?.randomPercent) || 0));
  if (t === 1) return b.tier1End / 2;
  if (t === 2) return (b.tier1End + b.tier2End) / 2;
  // ⚠️ 与 src/tier-slider.js 的 tierToSlider 保持一致：3 档下边界必须严格落进第 3 段
  //    （pos=20 按 sliderToTier 属于 2 档，否则"3 档/0%"会被显示成 2 档）
  if (t === 3) return Math.max(b.tier2End + 1, Math.min(b.tier3End, b.tier2End + (pct / 100) * (b.tier3End - b.tier2End)));
  return (b.tier3End + 100) / 2;
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）<br><span class="muted">私聊始终响应，不受本档位影响</span>';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应<br><span class="muted">私聊始终响应，不受本档位影响</span>';
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应<br><span class="muted">私聊始终响应，不受本档位影响</span>`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）。私聊始终响应，不受本档位影响',
  2: '在 1 档基础上，命中关键词也响应。私聊始终响应，不受本档位影响',
  3: '在 2 档基础上，再按概率随机响应一些消息。私聊始终响应，不受本档位影响',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderChatSection(c) {
    const st = c.store || {};
  // 滑条位置是唯一真相；档位与概率都由它派生（与后端 tier-slider.js 同一套规则）
  const sliderPos = sliderToTierUI_tierToSlider(st);
  const { tier: curTier, randomPercent: curPct } = sliderToTierUI(sliderPos);
  // 模板里要按各段占比画刻度条，这里简写成 B 供下方 ${B.xxx} 使用。
  // ⚠️ 这个别名不能删 —— 曾经漏掉它，导致模板里 B 未定义，
  //    整个 renderChatSection 抛 ReferenceError，聊天设置页直接打不开。
  const B = TIER_SLIDER_BANDS;
return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>防抖聚批窗口（毫秒）—— 等连发消息聚成一批再开运行</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>
    <div class="field">
      <label>暂停后恢复时，积压消息怎么处理</label>
      <select id="cfg-resumebacklog">
        <option value="tier"${(c.resumeBacklogMode || 'tier') === 'tier' ? ' selected' : ''}>按档位判定（省 token）—— 低档位群里积压很可能被整批跳过</option>
        <option value="force"${c.resumeBacklogMode === 'force' ? ' selected' : ''}>一律补处理 —— 暂停期间的话都会被看到并逐条判断要不要回</option>
      </select>
      <div class="hint">只影响「暂停 → 恢复」这一次补处理，不改变日常档位设置。选「一律补处理」时，这批消息会按"全部响应"那一档带上上下文交给模型，由它自己决定说不说话（不说也是正常选项）。</div>
    </div>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每小时最多发送</label><input type="number" id="cfg-maxperhour" min="1" value="${esc(c.send.maxPerHour ?? 500)}" /></div>
      <div class="field"><label>按字数附加间隔（毫秒/字）</label><input type="number" id="cfg-bylength" min="0" value="${esc(c.send.byLengthMs ?? 20)}" /></div>
      <div class="field"><label>QQ 硬限制切分长度（0 = 不切）</label><input type="number" id="cfg-hardsplit" min="0" value="${esc(c.send.hardSplitAt ?? 4000)}" /></div>
    </div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
      <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>

    <h3>表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <div class="field">
      <label>发表情包的积极程度</label>
      <select id="cfg-sticker-encourage">
        ${STICKER_LEVELS.map(([v, label], i) =>
          `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
        ).join('')}
      </select>
      <div class="hint">
        这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
      </div>
    </div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker-autonote" ${c.sticker?.autoNote !== false ? 'checked' : ''} />
      <label for="cfg-sticker-autonote">允许机器人自己给表情写备注（攒够备注才能挑得准）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker-ctxaware" ${c.sticker?.contextAwarePick !== false ? 'checked' : ''} />
      <label for="cfg-sticker-ctxaware">按当前话题相关度挑表情注入（关掉则按使用次数挑）</label></div>
    <div class="field">
      <label>每次注入提示词的表情条数</label>
      <input type="number" id="cfg-sticker-max" min="1" max="30" value="${esc(c.sticker?.promptMaxStickers ?? 10)}" />
      <div class="hint">表情越多、token 越多。10 条左右通常够用。</div>
    </div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-small" id="sticker-open-mgr-btn">打开表情库管理（备注 / 新增 / 删除）</button>
      <span class="hint" id="sticker-stat-hint">正在统计…</span>
    </div>

    <h3>响应档位</h3>

    <div class="checkbox-row"><input type="checkbox" id="cfg-unifiedtier" ${st.unifiedTier !== false ? 'checked' : ''} />
      <label for="cfg-unifiedtier">统一设置全部响应档位（关掉就能给每个白名单群聊单独拖档位）</label></div>

    <!-- 统一模式：一个滑条管所有会话（原行为） -->
    <div id="tier-unified-wrap"${st.unifiedTier === false ? ' style="display:none"' : ''}>
    <div class="tier-slider-wrap">
      <input type="range" id="ctx-tier-slider" class="tier-slider"
             min="0" max="100" step="0.5" value="${esc(sliderPos)}"
             aria-label="响应档位滑条" />
      <div class="tier-scale" id="tier-scale">
        <span class="tier-seg seg1${curTier === 1 ? ' on' : ''}" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
        <span class="tier-seg seg2${curTier === 2 ? ' on' : ''}" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
        <span class="tier-seg seg3${curTier === 3 ? ' on' : ''}" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
        <span class="tier-seg seg4${curTier === 4 ? ' on' : ''}" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
      </div>
    </div>

    <div class="hint" id="ctx-tier-note" style="margin-top:8px">${sliderDesc(sliderPos)}</div>
    </div>

    <!-- 分群模式：下拉选群，各拖各的。滑条实时值是 DOM，切换群时先收进隐藏 JSON 再换 -->
    <details class="advanced-submenu custom-settings" id="tier-pergroup-wrap"${st.unifiedTier === false ? '' : ' style="display:none"'}><summary>自定义群聊响应档位 <span>各群单独设置</span></summary><div class="advanced-content">
      <div class="field"><label>选择要单独设置的群聊（来自白名单）</label>
        <select id="tier-group-select"></select>
      </div>
      <input type="hidden" id="tier-group-json" value="${esc(JSON.stringify(st.groupSliderPos || {}))}" />
      <div class="tier-slider-wrap">
        <input type="range" id="ctx-tier-slider-g" class="tier-slider"
               min="0" max="100" step="0.5" value="${esc(sliderPos)}"
               aria-label="该群响应档位滑条" />
        <div class="tier-scale" id="tier-scale-g">
          <span class="tier-seg seg1" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
          <span class="tier-seg seg2" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
          <span class="tier-seg seg3" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
          <span class="tier-seg seg4" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
        </div>
      </div>
      <div class="hint" id="ctx-tier-note-g" style="margin-top:8px"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-small btn-danger" id="tier-group-clear-btn">清除该群的单独设置</button>
        <span class="hint" style="margin:0">没单独设置过的群聊和所有私聊，跟随上方统一档位的滑条位置。</span>
      </div>
    </div></details>

    <div class="tier-params">
      <div class="tier-param${curTier === 1 ? '' : ' dim'}">
        <label>① 被艾特时：发未读 + <input type="number" id="cfg-atcount" min="0" max="500" value="${esc(st.atCount ?? 20)}" /> 条已读</label>
        <div class="hint">有人 @机器人时才响应。<b>任何档位下被艾特都会响应</b>。</div>
      </div>
      <div class="tier-param${curTier === 2 ? '' : ' dim'}">
        <label>② 命中关键词时：发未读 + <input type="number" id="cfg-kwcount" min="0" max="500" value="${esc(st.keywordCount ?? 15)}" /> 条已读</label>
        <details class="advanced-submenu custom-settings" id="custom-chat-keywords-settings"><summary>自定义响应关键词 <span>每行一个</span></summary><div class="advanced-content">
        <div class="hint">关键词（每行一个，不区分大小写）：</div>
        <textarea id="cfg-keywords" rows="3" placeholder="小鲸鱼&#10;bot">${esc((st.keywords || []).join('\n'))}</textarea>
        </div></details>
      </div>
      <div class="tier-param${curTier === 3 ? '' : ' dim'}">
        <label>③ 随机命中时：发未读 + <input type="number" id="cfg-randcount" min="0" max="500" value="${esc(st.randomCount ?? 8)}" /> 条已读</label>
      </div>
      <div class="tier-param${curTier >= 4 ? '' : ' dim'}">
        <label>④ 其余情况也响应：发未读 + <input type="number" id="cfg-allcount" min="0" max="500" value="${esc(st.allCount ?? 80)}" /> 条已读</label>
        <div class="hint"><b>任何消息都响应</b>。</div>
      </div>
    </div>

    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">被屏蔽群员的消息不会存档、不会触发回复，也不会作为聊天背景发给模型。机器人自己的发言不受影响。</div>
    </div>

    <h3>群禁言</h3>
    <div class="field">
      <button class="btn btn-small" id="mutegroups-btn">管理禁言群聊</button>
      <div class="hint" style="margin-top:6px">被禁言的群聊：消息照常存档，但<b>完全不触发模型调用</b>——不烧 token。</div>
      <div class="hint" id="mute-stat-hint" style="margin-top:4px"></div>
    </div>

    <h3>管理员指令</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-admin-enabled" ${c.admin?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-admin-enabled">启用群管理员指令（群内发「禁言 / 解除」即可开关机器人发言）</label></div>
    <div class="field">
      <button class="btn btn-small" id="admins-btn">管理群管理员</button>
      <div class="hint" style="margin-top:6px">
        给某个群指定一个管理员 QQ：他在群里发「<b>禁言</b>」，机器人立刻闭嘴（<b>不再调用任何算力</b>）；
        被 @ 时只回一句固定话术，不装死。发「<b>解除</b>」即恢复发言。<br />
        这两条指令本身<b>不会触发对话</b>；只有指定管理员发的才算，别人发同样的话只是普通聊天。
      </div>
      <div class="hint" id="admin-stat-hint" style="margin-top:4px"></div>
    </div>
    <details class="advanced-submenu custom-settings" id="custom-admin-reply-settings"><summary>自定义禁言回复 <span>留空使用默认话术</span></summary><div class="advanced-content">
    <div class="field"><label>禁言期间被 @ 时的固定话术</label>
      <input type="text" id="cfg-admin-mutereply" placeholder="留空使用默认：${esc('（已禁言，暂时不说话啦，等管理员喊解除～）')}"
        value="${esc(c.admin?.muteReply || '')}" />
      <div class="hint" style="margin-top:4px">禁言时被 @，机器人只回这一句（本地直接发送，不调用模型）。</div>
    </div>
    </div></details>

    <h3>发言人身份</h3>
    <div class="field">
      <button class="btn btn-small" id="identity-btn">查看昵称记录（改名识别）</button>
      <div class="hint" style="margin-top:6px">机器人给每个人标记 <b>昵称(QQ号)</b>，并记住曾用名。改名后仍能认出同一个人。</div>
      <div class="hint" id="identity-stat-hint" style="margin-top:4px"></div>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closeask" ${c.server?.closeAsk !== false ? 'checked' : ''} />
      <label for="cfg-closeask">点关闭时先询问一次（最小化到托盘 / 彻底退出）</label></div>
    <div class="hint" style="margin-top:4px">取消勾选「先询问」后，点 X 将按上面那条设置直接执行；
      弹窗里勾过「记住我的选择」也会自动把这里关掉。想彻底退出：取消勾选「最小化到托盘」，或右键托盘图标 →「退出」。</div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${['dark', 'light', 'system', '?'].map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">SnowLuma · OneBot</h3>
    <div class="hint" style="margin-bottom:10px">在这里查看运行状态、日志，并管理连接配置。修改连接地址后请重启应用。</div>
    <div id="snowluma-page" class="snowluma-pane"><div class="muted">正在读取 SnowLuma 状态…</div></div>
    <h3>连接配置</h3>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

function bindSettingsEvents(c) {
  $('#factory-reset-btn')?.addEventListener('click', requestFactoryReset);
  $$('[data-model-vendor]').forEach((button) => button.addEventListener('click', () => {
    state.modelVendor = button.dataset.modelVendor;
    $$('[data-model-vendor]').forEach((item) => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); });
    $$('.model-vendor-panel').forEach((panel) => { panel.hidden = panel.id !== `vendor-panel-${state.modelVendor}`; });
  }));
  $$('[data-model-id]').forEach((button) => button.addEventListener('click', () => {
    openModelConnection({ vendor: button.dataset.modelVendorId, model: button.dataset.modelId });
  }));
  $('#edit-model-key-btn')?.addEventListener('click', () => openModelConnection({ providerId: state.config.api.provider || '', baseUrl: state.config.api.baseUrl, model: state.config.api.model }));
  const recordKey = { memory: '__global__', reminder: '__reminders__', style: '__style__' }[state.settingsSection];
  $('#memory-record-open')?.addEventListener('click', async (event) => {
    const panel = $('#settings-memory-records');
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    event.currentTarget.setAttribute('aria-expanded', String(opening));
    event.currentTarget.textContent = opening ? '收起记录管理' : '查看和管理记录';
    if (opening) await loadSettingsMemoryDetail();
  });
  $('#memory-record-reset')?.addEventListener('click', () => {
    const label = { memory: '跨群档案、长期事件和表层记忆', reminder: '全部提醒记录', style: '全部风格样本和已学规则' }[state.settingsSection];
    deleteUserRecords('memory', { ids: [recordKey], scopeLabel: `当前人设的${label}` });
  });
  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      const res = $('#cfg-save-result');
      res.textContent = '已保存 ✓';
      res.classList.remove('saved-flash');
      void res.offsetWidth;
      res.classList.add('saved-flash');
      refreshStatus();
      startListPoller();   // 刷新间隔可能刚被改过，用新值重启轮询
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
  });

  // ── 自定义搜索服务：添加 / 测试 / 删除 ──
  $('#add-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#add-search-provider-hint');
    const baseUrl = ($('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: ($('#new-sp-name')?.value || '').trim(),
          type: $('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: ($('#new-sp-apikey')?.value || '').trim(),
          model: ($('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      for (const id of ['#new-sp-name', '#new-sp-baseurl', '#new-sp-apikey', '#new-sp-model']) {
        const el = $(id);
        if (el) el.value = '';
      }
      await loadSettings();
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!confirm(`确定删除搜索服务「${name}」？`)) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 响应档位滑条：拖动时即时反馈（档位 + 概率 + 参数高亮）──
  // ⚠️ 档位的唯一真相是滑条的 value（DOM 实时值），不用全局变量记录 ——
  //   曾经用过 window.__ctxTier，结果每次重渲染重新绑定事件时被"未保存的旧配置"
  //   无条件覆盖（选了 2 档，切走再切回就变回 4 档），还踩了 `|| 4` 的 falsy 陷阱。
  const tierSlider = $('#ctx-tier-slider');
  if (tierSlider) {
    const sync = () => {
      const pos = Number(tierSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      // 提示行：显示当前档位与概率
      const note = $('#ctx-tier-note');
      if (note) note.innerHTML = sliderDesc(pos);
      // 参数区高亮：只点亮"当前真正会用到的那一档"
      // 1档→只亮①；2档→亮②；3档→亮③；4档→亮④（且①②③失效）
      const params = document.querySelectorAll('.tier-param');
      params.forEach((el, idx) => {
        const n = idx + 1;
        el.classList.toggle('dim', n !== t);
      });
      // 刻度段高亮：滑到哪一档，那一档的标签 + 上边线一起变色。
      // ⚠️ 之前这段完全没做，颜色全靠 CSS 写死（.s1 永远亮、.s4 永远橙），
      //    所以拖动滑条时刻度毫无反应 —— 看起来就像"没生效"。
      const segs = document.querySelectorAll('#tier-scale .tier-seg');
      segs.forEach((el) => {
        el.classList.toggle('on', Number(el.dataset.seg) === t);
      });
      // 滑条填充色（用 CSS 变量告诉样式当前百分比）
      tierSlider.style.setProperty('--pos', pos + '%');
    };
    tierSlider.addEventListener('input', sync);
    sync();   // 初始同步一次
  }

  // ── 统一/分群开关：切换两块 UI 的显隐 ──
  const unifiedChk = $('#cfg-unifiedtier');
  if (unifiedChk) unifiedChk.addEventListener('change', () => {
    const on = unifiedChk.checked;
    const uw = $('#tier-unified-wrap'); if (uw) uw.style.display = on ? '' : 'none';
    const pw = $('#tier-pergroup-wrap'); if (pw) pw.style.display = on ? 'none' : '';
  });

  // ── 分群档位：下拉选群 + 每群一条滑条 ──
  // ⚠️ 唯一真相是隐藏 input 里的 JSON（tier-group-json），滑条每次 input 都即时写回 ——
  //    不用全局变量（这个文件里"全局变量被重渲染覆盖"的坑已经踩过两次了）。
  const groupSel = $('#tier-group-select');
  if (groupSel) {
    const jsonEl = $('#tier-group-json');
    const gSlider = $('#ctx-tier-slider-g');
    const gNote = $('#ctx-tier-note-g');
    const readMap = () => { try { return JSON.parse(jsonEl.value || '{}'); } catch { return {}; } };
    const writeMap = (m) => { jsonEl.value = JSON.stringify(m); };

    // 群列表 = 白名单群 ∪ 已单独设置过的群（后者标"已不在白名单"，留着让用户能清理）
    const allowIds = (c.allow?.groups || []).map(String);
    const extraIds = Object.keys(readMap()).filter((id) => !allowIds.includes(id));
    const ids = [...allowIds, ...extraIds];
    groupSel.innerHTML = ids.length
      ? ids.map((id) => `<option value="${esc(id)}">${esc(id)}${extraIds.includes(id) ? '（已不在白名单）' : ''}</option>`).join('')
      : '<option value="">（白名单为空，先去「白名单」页签加群）</option>';
    // 异步补群名（协议端不在线就保持纯 QQ 号，不影响使用）
    api('/api/onebot/groups').then((d) => {
      const names = new Map((d.groups || []).map((g) => [String(g.id), g.name]));
      groupSel.querySelectorAll('option').forEach((o) => {
        const n = names.get(o.value);
        if (n) o.textContent = `${n}（${o.value}）${extraIds.includes(o.value) ? ' · 已不在白名单' : ''}`;
      });
    }).catch(() => {});

    const syncG = () => {
      const pos = Number(gSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      if (gNote) gNote.innerHTML = sliderDesc(pos);
      document.querySelectorAll('#tier-scale-g .tier-seg')
        .forEach((el) => el.classList.toggle('on', Number(el.dataset.seg) === t));
      gSlider.style.setProperty('--pos', pos + '%');
    };
    const loadGroup = () => {
      const gid = groupSel.value;
      const m = readMap();
      // 没单独设置过的群：从全局滑条当前值起步，所见即所得
      gSlider.value = m[gid] !== undefined ? m[gid] : (Number($('#ctx-tier-slider')?.value) || 100);
      syncG();
    };
    groupSel.addEventListener('change', loadGroup);
    gSlider.addEventListener('input', () => {
      syncG();
      const gid = groupSel.value;
      if (!gid) return;
      const m = readMap(); m[gid] = Number(gSlider.value); writeMap(m);
    });
    $('#tier-group-clear-btn')?.addEventListener('click', () => {
      const gid = groupSel.value;
      if (!gid) return;
      const m = readMap(); delete m[gid]; writeMap(m); loadGroup();
    });
    loadGroup();
  }

  // ── 表情库管理 ──
  $('#sticker-open-mgr-btn')?.addEventListener('click', () => openStickerManagerModal());
  $('#sticker-stat-hint') && refreshStickerStatHint();

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());
  // ── 群禁言 ──
  $('#mutegroups-btn')?.addEventListener('click', () => openMuteGroupsModal());
  $('#mute-stat-hint') && refreshMuteStatHint();
  // ── 管理员指令 ──
  $('#admins-btn')?.addEventListener('click', () => openAdminsModal());
  $('#admin-stat-hint') && refreshAdminStatHint();
  // ── 发言人身份 ──
  $('#identity-btn')?.addEventListener('click', () => openIdentityModal());
  $('#identity-stat-hint') && refreshIdentityStatHint();

  // ── 主题选择器（设置页「界面」区）──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        themePicker.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === el));
      };
      el.addEventListener('click', pick);
      // 键盘可达：Enter / Space 等价点击
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) box.style.display = memUseChat.checked ? 'none' : '';
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 人设：身体反应与分寸（勾选后才展开附属选项）──
  const touchChk = $('#cfg-touch-reaction');
  if (touchChk) touchChk.addEventListener('change', () => {
    const box = $('#touch-depth-box');
    if (box) box.style.display = touchChk.checked ? '' : 'none';
  });
  const nsfwChk = $('#cfg-nsfw');
  // R18 的三个联动控件：总开关 → 生效范围下拉 → 白名单输入框。
  // 抽成一个函数统一刷新，避免"只改下拉却不显示输入框"这类半联动。
  const syncNsfwBoxes = () => {
    const on = !!nsfwChk?.checked;
    const scope = $('#cfg-nsfw-scope')?.value || 'private';
    const box = $('#nsfw-scope-box');
    const hint = $('#nsfw-scope-hint');
    const d = on ? '' : 'none';
    if (box) box.style.display = d;
    if (hint) hint.style.display = d;
    const showWl = on && scope === 'whitelist';
    const wlBox = $('#nsfw-whitelist-box');
    const wlHint = $('#nsfw-whitelist-hint');
    if (wlBox) wlBox.style.display = showWl ? '' : 'none';
    if (wlHint) wlHint.style.display = showWl ? '' : 'none';
  };
  if (nsfwChk) nsfwChk.addEventListener('change', syncNsfwBoxes);
  $('#cfg-nsfw-scope')?.addEventListener('change', syncNsfwBoxes);
  syncNsfwBoxes();

  // 遗忘曲线：预览（dryRun，绝不改数据）与立即执行
  const memDecayOut = () => $('#mem-global-op-result');
  // 一次性迁移：把各群已有的群友印象汇总进跨群档案（幂等，可重复点）
  const memGlobalRebuild = $('#mem-global-rebuild');
  if (memGlobalRebuild) memGlobalRebuild.addEventListener('click', async () => {
    const out = memDecayOut();
    if (out) out.textContent = '重建中…';
    try {
      const r = await api('/api/memory-global/rebuild', { method: 'POST', body: JSON.stringify({}) });
      const s = r.stats || {};
      if (out) {
        out.textContent = `已从 ${r.chats} 个会话汇总 ${r.syncedMembers} 位群友 → 跨群档案共 ${s.people} 人 / ${s.facts} 条事实`;
      }
      try { state.globalMemory = await api('/api/memory-global'); } catch { /* 忽略 */ }
      if (state.tab === 'memory') renderMemoryList();
    } catch (e) {
      if (out) out.textContent = `失败：${e.message}`;
    }
  });

  const memGlobalPreview = $('#mem-global-preview');
  if (memGlobalPreview) memGlobalPreview.addEventListener('click', async () => {
    const out = memDecayOut();
    if (out) out.textContent = '预览中…';
    try {
      const r = await api('/api/memory-global/decay', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
      const x = r.result || {};
      if (out) out.textContent = `将淡忘：事实 ${x.facts || 0} 条、事件 ${x.events || 0} 条、档案 ${x.peopleRemoved || 0} 个（未改动任何数据）`;
    } catch (e) {
      if (out) out.textContent = `失败：${e.message}`;
    }
  });
  const memGlobalDecay = $('#mem-global-decay');
  if (memGlobalDecay) memGlobalDecay.addEventListener('click', async () => {
    const out = memDecayOut();
    if (out) out.textContent = '执行中…';
    try {
      const before = state.globalMemory?.stats;
      const r = await api('/api/memory-global/decay', { method: 'POST', body: JSON.stringify({}) });
      const x = r.result || {};
      const after = r.stats;
      if (out) {
        out.textContent = `已淡忘：事实 ${x.facts || 0} 条、事件 ${x.events || 0} 条、档案 ${x.peopleRemoved || 0} 个`
          + (before && after ? `（保留 ${after.people} 人 / ${after.facts} 条事实 / ${after.events} 件事）` : '');
      }
      try { state.globalMemory = await api('/api/memory-global'); } catch { /* 忽略 */ }
      if (state.tab === 'memory') renderMemoryList();
    } catch (e) {
      if (out) out.textContent = `失败：${e.message}`;
    }
  });

  // ── 定时提醒区块事件 ──
  const remOpOut = () => $('#rem-op-result');
  const remCleanup = $('#rem-cleanup');
  if (remCleanup) remCleanup.addEventListener('click', async () => {
    const out = remOpOut();
    if (out) out.textContent = '清理中…';
    try {
      const r = await api('/api/reminders/prune', { method: 'POST', body: JSON.stringify({}) });
      if (out) out.textContent = r.removed ? `已清理 ${r.removed} 条历史记录` : '没有需要清理的记录';
      await refreshReminderState();
    } catch (e) {
      if (out) out.textContent = `失败：${e.message}`;
    }
  });

  // ── 风格学习区块事件 ──
  const styleOut = () => $('#style-op-result');
  const styleNow = $('#style-distill-now');
  if (styleNow) styleNow.addEventListener('click', async () => {
    const out = styleOut();
    if (out) out.textContent = '正在学习（要调一次模型）…';
    styleNow.disabled = true;
    try {
      const r = await api('/api/style/distill', { method: 'POST', body: JSON.stringify({ force: true }) });
      if (out) {
        out.textContent = `学到：说话逻辑 +${r.added?.speech ?? 0}（强化 ${r.reinforced?.speech ?? 0}）、图片表情反应 +${r.added?.reactions ?? 0}（强化 ${r.reinforced?.reactions ?? 0}）`;
      }
      await refreshStyleState();
      renderSettings();
    } catch (e) {
      if (out) out.textContent = `失败：${e.message}`;
    } finally {
      styleNow.disabled = false;
    }
  });
  const styleClearSamples = $('#style-clear-samples');
  if (styleClearSamples) styleClearSamples.addEventListener('click', async () => {
    if (!confirm('清空样本池？风格库保留，但以后只能靠新样本继续学。')) return;
    const out = styleOut();
    try {
      await api('/api/style/samples', { method: 'DELETE' });
      if (out) out.textContent = '样本池已清空';
      await refreshStyleState();
    } catch (e) { if (out) out.textContent = `失败：${e.message}`; }
  });
  const styleClearProfile = $('#style-clear-profile');
  if (styleClearProfile) styleClearProfile.addEventListener('click', async () => {
    if (!confirm('清空风格库？她将忘掉学到的说话方式（样本池保留，可以重新学）。')) return;
    const out = styleOut();
    try {
      await api('/api/style/profile', { method: 'DELETE' });
      if (out) out.textContent = '风格库已清空';
      await refreshStyleState();
    } catch (e) { if (out) out.textContent = `失败：${e.message}`; }
  });

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 替换成真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['new-apikey-toggle', 'new-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：显示真实 Key（若之前是掩码/空占位）
          input.type = 'text';
          input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住；用户改了的新 Key 也盖住
          const current = input.value || '';
          input.type = 'password';
          if (real && (current === real || current === '' || current === '******')) {
            input.value = '******';
          } else if (!real && current === '') {
            input.value = '';
          } else if (current) {
            // 用户输入了新 Key：保持新值（密码态下浏览器会显示圆点）
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': 'deepseek',
    'cfg-zhipu-key': 'zhipu',
    'cfg-bocha-key': 'bocha',
    'cfg-baidu-key': 'baidu',
    'cfg-metaso-key': 'metaso'
  };

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId];
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      return String(r.apiKey || '');
    }
    return '';
  }
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  async function currentApiKey() {
    const input = $('#cfg-apikey');
    const raw = (input?.value || '').trim();
    if (raw && raw !== '******') return raw;          // 用户明文输入的新 Key / 刚点过“显示”的明文
    return await fetchRealKey('cfg-apikey');          // 掩码/空 → 用后端真实 Key
  }

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与模型区块的 test-provider-btn 做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const input = $('#cfg-apikey');
      const raw = (input?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', () => runConnectivityTest(testProviderBtn, $('#provider-test-result'), '测试连通性'));

  // 健康卡片上的「测试一下」：此前 renderHealthCard 渲染后从未绑定事件
  // （绑的是 test-provider-btn，id 不匹配），按钮点了完全没反应。
  const testApiBtn = $('#test-api-btn');
  if (testApiBtn) testApiBtn.addEventListener('click', () => runConnectivityTest(testApiBtn, $('#test-api-result'), '测试一下'));

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const key = await currentApiKey();
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!apiKey) { $('#provider-action-hint').textContent = '请填写 API Key（提供商必须带密钥才能测试连通性/在线探测图片能力）'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      await api('/api/model-connection', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      await refreshModelConnection('已添加提供商，首个模型已生效。');
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    const vhint = $('#model-vision-hint');
    if (box) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && r.verdict === 'no-vision') {
        box.checked = false;
        box.disabled = true;
        hint.textContent = '此模型不支持图片输入';
      } else {
        box.disabled = false;
        box.checked = state.config.api.vision !== false;
        hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
      }
    }
    if (vhint) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
        vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
      } else {
        vhint.textContent = '';
      }
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const personaRefreshBtn = $('#persona-refresh-btn');
  if (personaRefreshBtn) personaRefreshBtn.addEventListener('click', () => loadPersonas());
  const personaNewBtn = $('#persona-new-btn');
  if (personaNewBtn) personaNewBtn.addEventListener('click', () => openPersonaBlankCreateModal());
  const personaDistillBtn = $('#persona-distill-btn');
  if (personaDistillBtn) personaDistillBtn.addEventListener('click', () => openPersonaDistillModal());

  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 本地版本信息（桌面端区块） ──
  const curVerEl = $('#update-current');
  if (curVerEl) {
    api('/api/version').then((d) => { curVerEl.textContent = `v${d.version || '?'}`; })
      .catch(() => { curVerEl.textContent = ''; });
  }
  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });

  // ── 搜图服务区块事件 ──
  // 自定义图源：添加 / 删除 / 重填密钥。前两者只改隐藏 JSON，再由「保存设置」统一提交。
  const imgCustomAdd = $('#cfg-img-custom-add');
  if (imgCustomAdd) imgCustomAdd.addEventListener('click', () => {
    const hint = $('#cfg-img-custom-hint');
    const name = ($('#cfg-img-new-name')?.value || '').trim();
    const baseUrl = ($('#cfg-img-new-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (!/^https?:\/\//i.test(baseUrl)) { if (hint) hint.textContent = '接口地址要以 http:// 或 https:// 开头'; return; }
    const list = imageCustomProviders();
    // id 只要求在本配置里唯一：'c' + 36 进制时间戳（与后端约定无关）
    let id = `c${Date.now().toString(36)}`;
    while (list.some((p) => p.id === id)) id += 'x';
    const apiKey = ($('#cfg-img-new-apikey')?.value || '').trim();
    list.push({
      id,
      name: name || `自定义图源 ${list.length + 1}`,
      type: 'custom',
      baseUrl,
      apiKey,
      cookie: ($('#cfg-img-new-cookie')?.value || '').trim(),
      timeoutMs: clampInt($('#cfg-img-new-timeout')?.value, 3000, 120000, 15000)
    });
    if (apiKey) imageProviderKeys[id] = apiKey;   // 明文只留在这里，不回填界面
    writeImageCustomProviders(list);
    for (const sel of ['#cfg-img-new-name', '#cfg-img-new-baseurl', '#cfg-img-new-apikey', '#cfg-img-new-cookie']) {
      const node = $(sel);
      if (node) node.value = '';
    }
    imageProvidersDirty = true;
    syncImageProviderSelects();
    if (hint) hint.textContent = '已加入列表 —— 记得点上面的「保存设置」才会生效';
  });

  const imgCustomList = $('#cfg-img-custom-list');
  if (imgCustomList) {
    // 重填密钥：只进内存缓存，保存时一起带上（后端不回显，所以框里不写明文）
    imgCustomList.addEventListener('input', (ev) => {
      const input = ev.target.closest('.img-custom-key');
      if (!input) return;
      const v = input.value.trim();
      if (v) imageProviderKeys[input.dataset.id] = v; else delete imageProviderKeys[input.dataset.id];
      imageProvidersDirty = true;
    });
    imgCustomList.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.img-custom-del');
      if (!btn) return;
      const id = btn.dataset.id;
      const list = imageCustomProviders();
      const hit = list.find((p) => p.id === id);
      if (!confirm(`确定删除自定义图源「${hit?.name || id}」？（保存后生效，它的 API Key 也会一起删掉）`)) return;
      delete imageProviderKeys[id];
      writeImageCustomProviders(list.filter((p) => p.id !== id));
      imageProvidersDirty = true;
      syncImageProviderSelects();
      const hint = $('#cfg-img-custom-hint');
      if (hint) hint.textContent = '已从列表移除 —— 点「保存设置」后正式生效';
    });
  }

  // 按群覆盖：每改一项就写回隐藏 JSON；删除同理
  const imgPerChatList = $('#cfg-img-perchat-list');
  if (imgPerChatList) {
    imgPerChatList.addEventListener('change', (ev) => {
      const sel = ev.target.closest('select[data-perchat-key]');
      if (!sel) return;
      const key = sel.dataset.perchatKey;
      const field = sel.dataset.perchatField;
      const map = imagePerChatMap();
      const over = { ...(map[key] || {}) };
      const v = sel.value;
      if (!v) delete over[field];                                   // 留空 = 跟随全局
      else if (field === 'provider' || field === 'sendMode') over[field] = v;
      else over[field] = v === '1';                                  // enabled / hideAi 存布尔
      if (Object.keys(over).length) map[key] = over; else delete map[key];
      writeImagePerChatMap(map);
    });
    imgPerChatList.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.img-perchat-del');
      if (!btn) return;
      const key = btn.dataset.key;
      const map = imagePerChatMap();
      delete map[key];
      writeImagePerChatMap(map);
      renderImagePerChatList();
      const hint = $('#cfg-img-perchat-hint');
      if (hint) hint.textContent = `已移除 ${key} 的覆盖 —— 点「保存设置」后生效`;
    });
  }

  const imgPerChatAdd = $('#cfg-img-perchat-add');
  if (imgPerChatAdd) imgPerChatAdd.addEventListener('click', () => {
    const hint = $('#cfg-img-perchat-hint');
    const key = ($('#cfg-img-perchat-key')?.value || '').trim();
    if (!/^(group|private):\d{1,15}$/.test(key)) {
      if (hint) hint.textContent = '格式要像 group:123456789（私聊用 private:QQ号）';
      return;
    }
    const map = imagePerChatMap();
    if (!map[key]) map[key] = {};
    writeImagePerChatMap(map);
    const input = $('#cfg-img-perchat-key');
    if (input) input.value = '';
    renderImagePerChatList();
    if (hint) hint.textContent = '已加入 —— 每项都可以留空（留空 = 跟随全局），改完点「保存设置」';
  });

  // 试搜：只查不发，用来验证图源与过滤配置（逻辑见 runImageSearchTest）
  const imgTestBtn = $('#cfg-img-test-btn');
  if (imgTestBtn) imgTestBtn.addEventListener('click', () => runImageSearchTest(imgTestBtn));

  // ── 梗知识库区块事件 ──
  // 动态区（列表 / 表单 / 文件）的事件都绑在 bindMemeDynamicEvents 里，
  // 因为它每次重画都会重建 DOM —— 绑在这里会随重画一起失效。
  const memeEnabledChk = $('#cfg-meme-enabled');
  if (memeEnabledChk) memeEnabledChk.addEventListener('change', () => {
    // 关掉总开关后新建会直接被后端拒绝，提前说一声，别让人白填一遍表单
    const hint = $('#meme-f-hint');
    if (hint && !memeEnabledChk.checked) hint.textContent = '注意：总开关关着时新建/导入都不会生效，保存后请先打开。';
  });

  // 进入本页时若动态区还没数据，补一次拉取（renderMemeSection 里已经排过一次，这里只是兜底）
  if ($('#meme-dynamic') && !state.memes) loadMemes();
  // 动态区在 renderMemeSection 里就渲染好了，这里给它补上事件绑定；
  // 之后每次重画动态区都会由 refreshMemeDynamic 重新绑定。
  if ($('#meme-dynamic')) bindMemeDynamicEvents();
}

// ── 模型选择/添加/删除 模态框 ──
async function refreshModelConnection(message = '模型与密钥已保存，立即生效。') {
  const [config, providers, vision] = await Promise.all([api('/api/config'), api('/api/providers'), api('/api/vision/results')]);
  state.config = config;
  state.providers = providers.providers || [];
  state.visionResults = vision.results || {};
  renderSettingsSidebar();
  // 保留尚未保存的高级参数，不重新渲染设置表单。
  if (!$('#cfg-model')) return;
  $('#cfg-model').value = config.api.model || '';
  $('#cfg-provider').value = config.api.provider || '';
  $('#cfg-baseurl').value = config.api.baseUrl || '';
  $('#cfg-apikey').value = '';
  $('#edit-model-key-btn').disabled = false;
  $('#test-provider-btn').disabled = false;
  $('#current-model-name').textContent = currentModelName(config);
  const p = state.providers.find((item) => item.id === config.api.provider);
  $('#provider-hint').textContent = `${config.api.baseUrl} · ${p?.hasKey || config.api.hasKey ? '已保存密钥' : '待填写密钥'}`;
  $('#provider-action-hint').textContent = message;
  $('#provider-test-result').textContent = '';
  $$('[data-model-id]').forEach((button) => button.classList.toggle('selected', button.dataset.modelId === config.api.model && button.dataset.modelVendorId === apiVendorFor(config)));
  const result = state.visionResults[`${config.api.provider}|||${config.api.model}`];
  if ($('#cfg-vision')) {
    $('#cfg-vision').disabled = result?.verdict === 'no-vision';
    if (result?.verdict === 'no-vision') $('#cfg-vision').checked = false;
    else $('#cfg-vision').checked = config.api.vision !== false;
    $('#vision-switch-hint').textContent = result?.verdict === 'no-vision' ? '此模型不支持图片输入' : '';
  }
}

function openModelConnection(selection) {
  const preset = (state.modelCatalog || []).find((v) => v.id === selection.vendor);
  const baseUrl = preset?.baseUrl || selection.baseUrl || (state.providers || []).find((p) => p.id === selection.providerId)?.baseURL;
  const provider = (state.providers || []).find((p) => p.id === selection.providerId || p.baseURL === baseUrl);
  const sameLegacyEndpoint = !state.config.api.provider && state.config.api.baseUrl === baseUrl;
  const hasKey = provider?.hasKey || (sameLegacyEndpoint && state.config.api.hasKey);
  const name = preset?.models.find((m) => m.id === selection.model)?.name || provider?.modelNames?.[selection.model] || selection.model;
  const overlay = modelModalShell({
    head: esc(name || '填写 API Key'),
    body: `<div class="field"><label for="model-connect-key">API Key</label><div class="connection-key-row"><input type="password" id="model-connect-key" autocomplete="new-password" placeholder="${hasKey ? '留空使用已保存的密钥，填写可替换' : '填写该供应商的 API Key'}" /><button class="btn btn-small" id="model-connect-show" type="button">显示</button></div></div><div class="hint" id="model-connect-error" role="alert"></div>`,
    foot: '<button class="btn" id="model-connect-cancel">取消</button><button class="btn btn-primary" id="model-connect-save">保存并使用</button>'
  });
  overlay.querySelector('.model-modal').setAttribute('role', 'dialog');
  overlay.querySelector('.model-modal').setAttribute('aria-modal', 'true');
  overlay.querySelector('.model-modal').setAttribute('aria-label', name || '填写 API Key');
  const keyInput = overlay.querySelector('#model-connect-key');
  const error = overlay.querySelector('#model-connect-error');
  const save = overlay.querySelector('#model-connect-save');
  overlay.querySelector('#model-connect-show').addEventListener('click', (event) => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    event.currentTarget.textContent = keyInput.type === 'password' ? '显示' : '隐藏';
  });
  overlay.querySelector('#model-connect-cancel').addEventListener('click', () => closeModelModal(overlay));
  save.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey && !hasKey) { error.textContent = '请填写该供应商的 API Key'; keyInput.focus(); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    error.textContent = '';
    try {
      await api('/api/model-connection', { method: 'POST', body: JSON.stringify({ ...selection, apiKey }) });
      keyInput.value = '';
      closeModelModal(overlay);
      try { await refreshModelConnection(); }
      catch (e) { $('#provider-action-hint').textContent = `模型已保存，但状态刷新失败：${e.message}。请刷新页面。`; }
    } catch (e) { error.textContent = `保存失败：${e.message}`; }
    finally { save.disabled = false; save.textContent = '保存并使用'; }
  });
  keyInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !save.disabled) save.click(); });
  overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !save.disabled) closeModelModal(overlay); });
  keyInput.focus();
}

function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

/**
 * 弹窗外壳。
 * 主体方向判定：body **以 `<div class="model-modal-left"` 开头**才加 .row（横向），
 * 其余一律纵向堆叠。
 * ⚠️ 曾经只要 body 里"包含" model-modal-left 就加 row —— 但复合结构的弹窗
 *    （顶部工具栏 + 中部双栏 + 底部提示，如模型添加）需要的是
 *    外层纵向、双栏在 .ma-body 内部横向。误判成 row 后，工具栏与提示文
 *    两个 flex 项把宽度吃光，.ma-body（flex:1, basis 0）被挤成 0 宽，
 *    整个内容区隐形。
 */
function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body${/^\s*<div class="model-modal-left"/.test(String(body)) ? ' row' : ''}">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 文本输入弹窗 —— window.prompt 的替代品。
 *
 * ⚠️ 为什么不能用 prompt：控制台是跑在 Electron 的 BrowserWindow 里的，
 *    而 Electron 从未实现 window.prompt —— 调用它会**直接抛异常**
 *    （"prompt() is and will not be supported."），整个点击回调当场中断，
 *    用户看到的现象就是"按钮点了没任何反应"。
 *    alert / confirm 是支持的，所以只有 prompt 需要替换。
 *
 * 回调约定：onOk(value)
 *   - 正常返回 → 关窗
 *   - 返回 false → 留在弹窗里（回调自己已经给过提示了）
 *   - 抛错 → 错误信息显示在弹窗底部，窗口不关（例如接口报错）
 *
 * @param {{head:string, label?:string, value?:string, placeholder?:string,
 *          hint?:string, okText?:string, onOk?:(v:string)=>any}} opts
 */
function openTextPromptModal({ head, label = '', value = '', placeholder = '', hint = '', okText = '确定', onOk } = {}) {
  const overlay = modelModalShell({
    head: esc(head),
    body: `
      <div class="field" style="flex:1;min-width:0">
        ${label ? `<label>${esc(label)}</label>` : ''}
        <input type="text" id="tpm-input" value="${esc(value)}" placeholder="${esc(placeholder)}" />
      </div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
      <div class="hint" id="tpm-error" style="color:var(--color-text-danger,#f66);display:none"></div>`,
    foot: `<button class="btn" id="tpm-cancel">取消</button>
           <button class="btn btn-primary" id="tpm-ok">${esc(okText)}</button>`
  });
  const input = overlay.querySelector('#tpm-input');
  const err = overlay.querySelector('#tpm-error');
  const submit = async () => {
    const v = String(input.value ?? '').trim();
    try {
      const keep = await onOk?.(v);
      if (keep === false) return;
      closeModelModal(overlay);
    } catch (e) {
      if (err) { err.textContent = String(e?.message ?? e); err.style.display = ''; }
    }
  };
  overlay.querySelector('#tpm-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#tpm-ok').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.focus();
  input.select();
  return overlay;
}

/**
 * 调用明细弹窗：点「调用次数」卡片打开，列出各类工具分别被调用了多少次。
 *
 * 让纯数字的用量表更容易理解，
 * 而"机器人这周发了 133 条消息、戳了 6 次、翻了 3 次聊天记录"这类数字
 * 恰恰是最能反映它"活成什么样"的。所以做出来，纯粹因为好看又好玩。
 */
function openToolBreakdown() {
  const counts = (state.usageStats && state.usageStats.toolCounts) || {};
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);

  if (!total) {
    modelModalShell({
      head: '调用明细',
      body: '<div class="empty-hint">这个时间区间内还没有任何工具调用记录。</div>'
    });
    return;
  }

  const max = Math.max(...entries.map(([, n]) => n));

  // 按分类分组，分类内按次数降序
  const byCat = new Map();
  for (const [key, n] of entries) {
    const meta = TOOL_META[key] || { name: key, cat: '其他', icon: '🔧' };
    if (!byCat.has(meta.cat)) byCat.set(meta.cat, []);
    byCat.get(meta.cat).push({ key, n, ...meta });
  }
  const cats = TOOL_CAT_ORDER.filter((c) => byCat.has(c));
  for (const c of byCat.keys()) if (!cats.includes(c)) cats.push(c);

  const rows = cats.map((cat) => {
    const items = byCat.get(cat).sort((a, b) => b.n - a.n);
    const catTotal = items.reduce((a, x) => a + x.n, 0);
    return `
      <div class="tb-cat">
        <div class="tb-cat-head">
          <span>${esc(cat)}</span>
          <span class="tb-cat-sum">${catTotal} 次 · ${(catTotal / total * 100).toFixed(0)}%</span>
        </div>
        ${items.map((it) => `
          <div class="tb-row">
            <span class="tb-icon">${it.icon}</span>
            <span class="tb-name">${esc(it.name)}</span>
            <span class="tb-code">${esc(it.key)}</span>
            <span class="tb-bar"><i style="width:${(it.n / max * 100).toFixed(1)}%"></i></span>
            <span class="tb-n">${it.n}</span>
          </div>`).join('')}
      </div>`;
  }).join('');

  // 一句话小结（让这堆数字有个"人味"的结论）
  const say = counts.send_message ? `发了 ${counts.send_message} 条消息` : '一条都没发';
  const poke = counts.send_poke ? `、戳了 ${counts.send_poke} 次` : '';
  const sticker = counts.send_sticker ? `、贴了 ${counts.send_sticker} 张表情` : '';
  const search = (Number(counts.web_search) || 0) + (Number(counts.web_fetch) || 0);
  const searchTxt = search ? `、联网查了 ${search} 次` : '';

  modelModalShell({
    head: `调用明细（${state.usageStats?.rangeLabel || ''} · 共 ${total} 次）`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">这段时间里，机器人${say}${poke}${sticker}${searchTxt}。</div>
        ${rows}
      </div>`,
    foot: '<div class="muted" style="font-size:11.5px">按当前时间范围汇总工具调用次数。</div>'
  });
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `
      <div class="model-modal-right" id="persona-list" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${(state.personaTemplates[id]?.text === ($('#cfg-roletext')?.value ?? '')) ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      if (tpl) {
        $('#cfg-roletext').value = tpl.text;
        $('#cfg-customrules').value = tpl.customRules || '';
        const input = $('#cfg-persona-pick');
        if (input) input.value = tpl.name;
      }
      closeModelModal(overlay);
      syncPersonaButtons();
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 「＋ 新建空白人设」：只填名字就能建，角色设定可以留空。
 *
 * 注意它和下面 openPersonaCreateModal 不是一回事：
 *   - openPersonaCreateModal（「添加人设」）是"把一段卡片文本填进当前『角色设定』框"，属于模板。
 *   - 这里建的是**新的人设**：独立 id + 独立记忆目录，不会动当前人设的卡片。
 *
 * ⚠️ 这里原来是两个 window.prompt —— Electron 不支持 prompt，点了直接抛异常、毫无反应。
 *    改成模态框（与「添加人设」同一套外壳），空白人设才真的建得出来。
 */
function openPersonaBlankCreateModal() {
  const overlay = modelModalShell({
    head: '新建空白人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称（必填）</label>
        <input type="text" id="blank-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定（可留空，之后再补）</label>
        <textarea id="blank-persona-text" class="persona-role-text" style="min-height:160px" placeholder="留空也行：先建好人设，切过去再慢慢写；也可以用「🎭 角色蒸馏」自动生成一张卡"></textarea>
      </div>
      <div class="hint">新建的人设自带一套<b>独立记忆</b>（不认识旧人设认识的人）。建好后点它的「切换」即可启用。</div>
      <div class="hint" id="blank-persona-error" style="color:var(--color-text-danger,#f66);display:none"></div>`,
    foot: `<button class="btn" id="blank-persona-cancel">取消</button>
           <button class="btn btn-primary" id="blank-persona-apply">创建</button>`
  });
  const err = overlay.querySelector('#blank-persona-error');
  const fail = (msg) => { err.textContent = msg; err.style.display = ''; };
  overlay.querySelector('#blank-persona-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#blank-persona-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#blank-persona-name').value.trim();
    const text = overlay.querySelector('#blank-persona-text').value.trim();
    if (!name) { fail('人设名称不能为空'); return; }
    try {
      await api('/api/personas', { method: 'POST', body: JSON.stringify({ name, text }) });
      closeModelModal(overlay);
      await loadPersonas();
      const hint = $('#persona-pick-hint');
      if (hint) {
        hint.textContent = `已创建「${name}」。点它的「切换」即可启用（记忆从零开始）`
          + (text ? '。' : '；角色设定还是空的，切过去后在「角色设定」框里补上即可。');
      }
    } catch (e) { fail(`创建失败：${e.message}`); }
  });
  overlay.querySelector('#blank-persona-name').focus();
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules })
      });
      closeModelModal(overlay);
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点「保存人设修改」使当前填写生效。`;
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '暂无已添加的模型，请在“其他”中添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        closeModelModal(overlay);
        openModelConnection({ providerId: pid, model, baseUrl: p.baseURL });
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 选择记忆整理专用模型：复用模型目录选择器，保存到 config.memory.provider/model。 */
function openMemoryModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#mem-model-hint').textContent = '模型目录为空：请先到「模型 API」页签添加提供商。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择记忆整理模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从 DOM 的隐藏字段读当前值（而非 state.config）：
  // 用户可能刚选过但还没保存，或 state 还没刷新，DOM 才是最新真相。
  const currentProvider = $('#cfg-mem-provider')?.value || state.config?.memory?.provider || '';
  const currentModel = $('#cfg-mem-model')?.value || state.config?.memory?.model || '';
  let activePid = currentProvider || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel && p.id === currentProvider ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 必须把"是否跟随聊天模型"的当前勾选状态一并提交。
          // 否则：用户取消勾选（→ 只改了 DOM，state.config 仍是 true）后直接点模型，
          // 这次提交不带 useChatModel，随后 loadSettings() 又按 state.config(true)
          // 重新渲染 —— 复选框被打回"已勾选"，迫使必须先保存一次才能选模型。
          const useChatBox = $('#cfg-mem-usechat');
          const useChatModel = useChatBox ? !!useChatBox.checked
            : (state.config?.memory?.useChatModel !== false);
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ memory: { provider: pid, model, useChatModel } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#mem-model-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
/**
 * “获取列表”后的勾选添加弹窗。
 *
 * 两个针对中转站的优化：
 *   1. 搜索框：中转站常返回几百上千个模型，没有搜索就没法用
 *   2. 双列模式：若模型 id 普遍带 "/"（OpenRouter 风格的 vendor/model），
 *      拆成左厂商 / 右模型两列，比一长条列表好找得多；否则保持单列 + 搜索
 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const all = (remoteModels || []).slice();

  // 有多少比例的 id 是 vendor/model 形式？超过一半就启用双列
  const slashed = all.filter((m) => String(m).includes('/'));
  const dual = all.length > 0 && slashed.length / all.length >= 0.5;

  // 预先按厂商分组（仅双列模式用）
  const groups = new Map();
  for (const m of all) {
    const s = String(m);
    const vendor = dual ? (s.includes('/') ? s.slice(0, s.indexOf('/')) : '(其他)') : '';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(s);
  }
  const vendorList = [...groups.keys()].sort((a, b) => {
    if (a === '(其他)') return 1;
    if (b === '(其他)') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  const countText = `共 ${all.length} 个模型${dual ? ` · ${vendorList.length} 个厂商` : ''}`;

  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="ma-search" placeholder="搜索模型或厂商…" autocomplete="off" />
        <span class="muted" id="ma-count" style="font-size:12px;white-space:nowrap">${esc(countText)}</span>
      </div>
      <div class="ma-body ${dual ? 'dual' : 'single'}">
        ${dual ? '<div class="model-modal-left" id="ma-left"></div>' : ''}
        <div class="model-modal-right" id="ma-right"></div>
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });

  const searchEl = overlay.querySelector('#ma-search');
  const countEl = overlay.querySelector('#ma-count');
  const right = overlay.querySelector('#ma-right');
  const left = dual ? overlay.querySelector('#ma-left') : null;

  let activeVendor = dual ? vendorList[0] : '';
  let keyword = '';

  // 渲染成 checkbox 行
  const rowHtml = (m) => {
    const added = existingIds.has(m);
    const modelPart = dual && String(m).includes('/') ? String(m).slice(String(m).indexOf('/') + 1) : String(m);
    return `
      <label class="mm-model">
        <input type="checkbox" class="ma-check" value="${esc(m)}" ${added ? 'checked disabled' : ''} />
        <span class="mm-model-text">${esc(modelPart)}</span>
        ${added ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
      </label>`;
  };

  function matches(m) {
    if (!keyword) return true;
    return String(m).toLowerCase().includes(keyword);
  }

  function renderRight() {
    const pool = dual ? (groups.get(activeVendor) || []) : all;
    const list = pool.filter(matches);
    right.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="muted" style="padding:10px">没有匹配的模型</div>';
    // 更新计数：显示当前筛选出来的数量
    countEl.textContent = keyword
      ? `${list.length} / ${dual ? pool.length : all.length}`
      : countText;
  }

  function renderLeft() {
    if (!left) return;
    const vendors = vendorList.filter((v) => (groups.get(v) || []).some(matches));
    left.innerHTML = vendors.length
      ? vendors.map((v) => `
          <div class="mm-prov ${v === activeVendor ? 'active' : ''}" data-vendor="${esc(v)}">
            ${esc(v)} <span class="muted" style="font-size:11px">${(groups.get(v) || []).filter(matches).length}</span>
          </div>`).join('')
      : '<div class="muted" style="padding:10px">没有匹配的厂商</div>';
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => {
        activeVendor = el.dataset.vendor;
        renderLeft();
        renderRight();
      });
    });
    // 当前厂商被搜索过滤掉了 → 自动切到第一个可见的
    if (vendors.length && !vendors.includes(activeVendor)) {
      activeVendor = vendors[0];
      renderLeft();
      renderRight();
    }
  }

  // 搜索：输入时同时刷两列（双列模式下左列的计数也要跟着变）
  searchEl.addEventListener('input', () => {
    keyword = String(searchEl.value || '').trim().toLowerCase();
    renderLeft();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!confirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

/**
 * 角色蒸馏弹窗。
 * 两种来源：多会话汇总（从已有聊天记录里提炼某个人的语言特征）、
 * 导入文本（游戏文案/小说对话/剧本）。
 * 产出的角色卡先给用户预览、可手改，再决定保存 / 保存并切换。
 */
async function openPersonaDistillModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:820px;width:94vw;max-height:88vh;display:flex;flex-direction:column">
      <div class="modal-head">🎭 角色蒸馏 —— 从材料里提炼一张角色卡</div>
      <div style="padding:12px 16px;overflow:auto;flex:1">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-small btn-primary pd-tab" data-tab="chats">① 多会话汇总蒸馏</button>
          <button class="btn btn-small pd-tab" data-tab="text">② 导入角色对话文本</button>
        </div>

        <div id="pd-pane-chats" style="margin-top:12px">
          <div class="field">
            <label>选择会话（可多选；选 2 个以上样本更全）</label>
            <div id="pd-chats" class="modal-list" style="max-height:200px"><span class="muted">加载中…</span></div>
          </div>
          <div class="field-row">
            <div class="field"><label>蒸馏谁的发言</label>
              <select id="pd-speaker">
                <option value="self">机器人自己（把它的表达风格固化成人设）</option>
                <option value="custom">指定某个群友的 QQ 号</option>
              </select></div>
            <div class="field"><label>QQ 号（选"指定"时填）</label>
              <input type="text" id="pd-speaker-id" placeholder="例如 1779257738" /></div>
          </div>
        </div>

        <div id="pd-pane-text" style="margin-top:12px;display:none">
          <div class="field">
            <label>粘贴角色对话文本（也可以把 .txt 文件直接拖进来）</label>
            <textarea id="pd-text" style="min-height:190px" placeholder="支持「角色名：台词」逐行格式，也支持整段纯文本。&#10;例如：&#10;Alice: 今天天气不错&#10;Bob: 嗯&#10;Alice: 你想不想去看海"></textarea>
          </div>
          <div class="field"><label>只保留某个角色的台词（可选）</label>
            <input type="text" id="pd-text-speaker" placeholder="例如 Alice；留空则用全文" /></div>
        </div>

        <div class="field-row">
          <div class="field"><label>人设名（可留空，由模型起名）</label><input type="text" id="pd-name" placeholder="例如 慢半拍的诗人" /></div>
          <div class="field"><label>额外要求（可选）</label><input type="text" id="pd-hint" placeholder="例如：强调毒舌一面 / 保留粤语口头禅" /></div>
        </div>

        <div id="pd-status" class="muted" style="margin-top:10px"></div>
        <div id="pd-preview"></div>
      </div>
      <div class="modal-foot" style="flex-wrap:wrap;gap:8px">
        <button class="btn btn-primary" id="pd-run">开始蒸馏</button>
        <button class="btn" id="pd-save" disabled>保存为人设</button>
        <button class="btn" id="pd-save-switch" disabled>保存并切换</button>
        <button class="btn" id="pd-close">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let source = 'chats';
  let draft = null;
  const setStatus = (t) => { const el = $('#pd-status', overlay); if (el) el.textContent = t; };

  // 会话清单：合并"白名单里的会话"和"有记忆的会话"
  try {
    const [files, chats] = await Promise.all([
      api('/api/memory-files').catch(() => ({ files: [] })),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    const nameOf = {};
    for (const c of chats.chats || []) nameOf[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
    const keys = [...new Set([...(files.files || []).map((f) => f.chatKey), ...Object.keys(nameOf)])];
    const box = $('#pd-chats', overlay);
    if (!keys.length) box.innerHTML = '<span class="muted">还没有任何会话</span>';
    else box.innerHTML = keys.map((k) => `
      <label class="pick-item">
        <input type="checkbox" value="${esc(k)}" />
        <span>${esc(nameOf[k] || formatChatTitle(k, chatNameOf(k)))}</span>
        <span class="muted">${esc(k)}</span>
      </label>`).join('');
  } catch {
    $('#pd-chats', overlay).innerHTML = '<span class="muted">会话列表加载失败</span>';
  }

  // 拖拽导入 txt
  const ta = $('#pd-text', overlay);
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.style.borderColor = 'var(--color-border-info,#4a9)'; });
  ta.addEventListener('dragleave', () => { ta.style.borderColor = ''; });
  ta.addEventListener('drop', (e) => {
    e.preventDefault();
    ta.style.borderColor = '';
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { ta.value = String(fr.result || '').slice(0, 400000); setStatus(`已读入文件 ${f.name}（${ta.value.length} 字）`); };
    fr.onerror = () => setStatus('文件读取失败');
    fr.readAsText(f, 'utf-8');
  });

  $$('.pd-tab', overlay).forEach((b) => b.addEventListener('click', () => {
    source = b.dataset.tab;
    $$('.pd-tab', overlay).forEach((x) => x.classList.toggle('btn-primary', x === b));
    $('#pd-pane-chats', overlay).style.display = source === 'chats' ? '' : 'none';
    $('#pd-pane-text', overlay).style.display = source === 'text' ? '' : 'none';
  }));

  const setDraftButtons = (on) => {
    $('#pd-save', overlay).disabled = !on;
    $('#pd-save-switch', overlay).disabled = !on;
  };

  $('#pd-run', overlay).addEventListener('click', async () => {
    const btn = $('#pd-run', overlay);
    btn.disabled = true;
    setStatus('蒸馏中…（要读材料并生成角色卡，通常 10~40 秒）');
    $('#pd-preview', overlay).innerHTML = '';
    setDraftButtons(false);
    try {
      const body = {
        source,
        name: $('#pd-name', overlay).value.trim(),
        hint: $('#pd-hint', overlay).value.trim()
      };
      if (source === 'chats') {
        body.chatKeys = $$('input[type=checkbox]:checked', $('#pd-chats', overlay)).map((el) => el.value);
        const sp = $('#pd-speaker', overlay).value;
        body.speaker = sp === 'custom' ? ($('#pd-speaker-id', overlay).value.trim() || 'self') : 'self';
      } else {
        body.text = $('#pd-text', overlay).value;
        body.textSpeaker = $('#pd-text-speaker', overlay).value.trim();
      }
      const r = await api('/api/personas/distill', { method: 'POST', body: JSON.stringify(body) });
      draft = r.draft;
      renderDistillPreview(overlay, draft);
      setDraftButtons(true);
      setStatus(`蒸馏完成：吃了 ${draft.sampleCount} 条材料，置信度 ${Math.round((draft.confidence || 0) * 100)}%`);
    } catch (e) {
      setStatus(`蒸馏失败：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  async function saveDraft(andSwitch) {
    if (!draft) return;
    const cardEl = $('#pd-card', overlay);
    const nameEl = $('#pd-save-name', overlay);
    const name = (nameEl?.value || draft.name || '').trim();
    const text = (cardEl?.value || draft.card || '').trim();
    if (!name || !text) { alert('人设名和角色卡都不能为空'); return; }
    try {
      setStatus('保存中…');
      const r = await api('/api/personas', { method: 'POST', body: JSON.stringify({ name, text }) });
      if (andSwitch) {
        await api('/api/personas/active', { method: 'POST', body: JSON.stringify({ id: r.persona.id }) });
      }
      overlay.remove();
      await loadSettings();
      const hint = $('#persona-pick-hint');
      if (hint) {
        hint.textContent = andSwitch
          ? `已保存并切换到「${name}」。这个人的记忆从零开始，与之前的人设完全隔离。`
          : `已保存「${name}」。点它的「切换」即可启用。`;
      }
    } catch (e) {
      setStatus(`保存失败：${e.message}`);
    }
  }
  $('#pd-save', overlay).addEventListener('click', () => saveDraft(false));
  $('#pd-save-switch', overlay).addEventListener('click', () => saveDraft(true));
  $('#pd-close', overlay).addEventListener('click', () => overlay.remove());
}

/** 蒸馏结果预览：概览 + 可手改的角色卡 + 原文摘录对照。 */
function renderDistillPreview(overlay, draft) {
  const warn = (draft.warnings || []).length
    ? `<div class="hint" style="color:var(--color-text-warning,#da4)">⚠ ${draft.warnings.map((w) => esc(w)).join('；')}</div>`
    : '';
  $('#pd-preview', overlay).innerHTML = `
    <div style="margin-top:14px;border-top:1px solid var(--color-border-tertiary,#3333);padding-top:12px">
      <div class="field-row">
        <div class="field"><label>人设名（可改）</label><input type="text" id="pd-save-name" value="${esc(draft.name)}" /></div>
        <div class="field"><label>一句话概括</label><input type="text" value="${esc(draft.summary || '')}" readonly /></div>
      </div>
      ${(draft.styleTags || []).length ? `<div class="muted" style="font-size:12px;margin-bottom:6px">风格标签：${draft.styleTags.map((t) => esc(t)).join(' · ')}</div>` : ''}
      ${(draft.catchphrases || []).length ? `<div class="muted" style="font-size:12px;margin-bottom:6px">口头禅：${draft.catchphrases.map((t) => esc(t)).join(' / ')}</div>` : ''}
      ${warn}
      <div class="field" style="margin-top:8px">
        <label>角色卡（保存前可以直接在这里改）</label>
        <textarea id="pd-card" style="min-height:300px;font-family:ui-monospace,monospace;font-size:12px">${esc(draft.card)}</textarea>
      </div>
      ${(draft.samples || []).length ? `
        <details style="margin-top:8px">
          <summary class="muted" style="cursor:pointer;font-size:12px">模型从材料里摘的原话（${draft.samples.length} 条）</summary>
          <div class="muted" style="font-size:12px;margin-top:6px">${draft.samples.map((s) => '· ' + esc(s)).join('<br>')}</div>
        </details>` : ''}
    </div>`;
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      consolidateMinIntervalMs: Number(val('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000)) || 21600000,
      // ── 表层记忆（刚说过的话，限时跨群可见）──
      surfaceEnabled: chk('#cfg-mem-surface', c.memory?.surfaceEnabled !== false),
      surfacePrivateToGroup: chk('#cfg-mem-surface-p2g', c.memory?.surfacePrivateToGroup !== false),
      surfaceTtlMs: Math.max(60000, (Number(val('#cfg-mem-surface-ttl', Math.round((c.memory?.surfaceTtlMs ?? 600000) / 60000))) || 10) * 60000),
      surfaceMaxPerPerson: Math.max(1, Number(val('#cfg-mem-surface-max', c.memory?.surfaceMaxPerPerson ?? 50)) || 50),
      surfaceMaxInject: Math.max(0, Number(val('#cfg-mem-surface-inject', c.memory?.surfaceMaxInject ?? 6)) || 0),
      // ── 跨群聊长期记忆 ──
      globalEnabled: chk('#cfg-mem-global', c.memory?.globalEnabled !== false),
      crossGroupEnabled: chk('#cfg-mem-crossgroup', c.memory?.crossGroupEnabled !== false),
      crossGroupPrivateToGroup: chk('#cfg-mem-priv2group', c.memory?.crossGroupPrivateToGroup !== false),
      eventsEnabled: chk('#cfg-mem-events', c.memory?.eventsEnabled !== false),
      eventsAutoExtract: chk('#cfg-mem-events-auto', c.memory?.eventsAutoExtract !== false),
      crossGroupExclude: String(val('#cfg-mem-exclude', (c.memory?.crossGroupExclude || []).join(',')) || '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      // ── 遗忘曲线 ──
      decayHalfLifeDays: Math.max(1, Number(val('#cfg-mem-halflife', c.memory?.decayHalfLifeDays ?? 30)) || 30),
      keepImportance: Math.min(5, Math.max(1, Number(val('#cfg-mem-keepimp', c.memory?.keepImportance ?? 4)) || 4)),
      decayMinWeight: Math.min(1, Math.max(0, Number(val('#cfg-mem-minweight', c.memory?.decayMinWeight ?? 0.08)) || 0.08)),
      maxFactsPerPerson: Math.max(3, Number(val('#cfg-mem-maxfacts', c.memory?.maxFactsPerPerson ?? 12)) || 12),
      peopleMaxInject: Math.max(0, Number(val('#cfg-mem-peopleinject', c.memory?.peopleMaxInject ?? 6)) || 0),
      eventsMaxInject: Math.max(0, Number(val('#cfg-mem-eventsinject', c.memory?.eventsMaxInject ?? 6)) || 0),
      crossGroupMaxChars: Math.max(300, Number(val('#cfg-mem-budget', c.memory?.crossGroupMaxChars ?? 1400)) || 1400)
    };
  }

  if (sec === 'reminder') {
    patch.reminder = {
      ...(c.reminder || {}),
      enabled: chk('#cfg-rem-enabled', c.reminder?.enabled !== false),
      fallbackRawText: chk('#cfg-rem-fallback', c.reminder?.fallbackRawText !== false),
      injectUpcoming: chk('#cfg-rem-inject', c.reminder?.injectUpcoming !== false),
      missedNoteInPrompt: chk('#cfg-rem-missed', c.reminder?.missedNoteInPrompt !== false),
      allowPrivateTarget: chk('#cfg-rem-private', c.reminder?.allowPrivateTarget !== false),
      delivery: val('#cfg-rem-delivery', c.reminder?.delivery || 'natural') === 'verbatim' ? 'verbatim' : 'natural',
      catchUpMinutes: Math.max(0, Number(val('#cfg-rem-catchup', c.reminder?.catchUpMinutes ?? 720)) || 0),
      checkIntervalMs: Math.max(5000, Number(val('#cfg-rem-interval', c.reminder?.checkIntervalMs ?? 20000)) || 20000),
      minDelaySec: Math.max(0, Number(val('#cfg-rem-mindelay', c.reminder?.minDelaySec ?? 30)) || 0),
      maxPerDay: Math.max(1, Number(val('#cfg-rem-maxday', c.reminder?.maxPerDay ?? 20)) || 20),
      maxPendingPerChat: Math.max(1, Number(val('#cfg-rem-maxchat', c.reminder?.maxPendingPerChat ?? 20)) || 20),
      ttlDays: Math.max(1, Number(val('#cfg-rem-ttl', c.reminder?.ttlDays ?? 400)) || 400)
    };
  }

  if (sec === 'style') {
    patch.styleLearn = {
      ...(c.styleLearn || {}),
      enabled: chk('#cfg-style-enabled', c.styleLearn?.enabled === true),
      learnSpeech: chk('#cfg-style-speech', c.styleLearn?.learnSpeech !== false),
      learnImageReaction: chk('#cfg-style-image', c.styleLearn?.learnImageReaction !== false),
      learnSticker: chk('#cfg-style-sticker', c.styleLearn?.learnSticker !== false),
      learnEmoji: chk('#cfg-style-emoji', c.styleLearn?.learnEmoji !== false),
      collectEnabled: chk('#cfg-style-collect', c.styleLearn?.collectEnabled !== false),
      autoDistill: chk('#cfg-style-auto', c.styleLearn?.autoDistill !== false),
      captionImages: chk('#cfg-style-caption', c.styleLearn?.captionImages === true),
      distillMinSamples: Math.max(10, Number(val('#cfg-style-minsamples', c.styleLearn?.distillMinSamples ?? 80)) || 80),
      distillIntervalMs: Math.max(60000, Number(val('#cfg-style-interval', c.styleLearn?.distillIntervalMs ?? 21600000)) || 21600000),
      reactionWindowSec: Math.max(10, Number(val('#cfg-style-window', c.styleLearn?.reactionWindowSec ?? 180)) || 180),
      maxSamples: Math.max(100, Number(val('#cfg-style-maxsamples', c.styleLearn?.maxSamples ?? 3000)) || 3000),
      maxSpeechItems: Math.max(1, Number(val('#cfg-style-maxspeech', c.styleLearn?.maxSpeechItems ?? 18)) || 18),
      maxReactionItems: Math.max(1, Number(val('#cfg-style-maxreact', c.styleLearn?.maxReactionItems ?? 18)) || 18),
      injectMaxItems: Math.max(0, Number(val('#cfg-style-injectitems', c.styleLearn?.injectMaxItems ?? 8)) || 0),
      injectMaxChars: Math.max(100, Number(val('#cfg-style-injectchars', c.styleLearn?.injectMaxChars ?? 900)) || 900),
      captionMaxPerDay: Math.max(0, Number(val('#cfg-style-captionmax', c.styleLearn?.captionMaxPerDay ?? 30)) || 0),
      chatExclude: String(val('#cfg-style-exclude', (c.styleLearn?.chatExclude || []).join(',')) || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
    };
  }

  if (sec === 'api') {
    patch.api = {
      vision: $('#cfg-vision')?.disabled ? c.api.vision !== false : chk('#cfg-vision', c.api.vision !== false),
      temperature: Number.isFinite(Number(val('#cfg-temperature', c.api.temperature))) ? Math.min(2, Math.max(0, Number(val('#cfg-temperature', c.api.temperature)))) : (c.api.temperature ?? 0.8),
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12,
      // 思考模式：off=最省 / low=低强度 / auto=不干预
      thinking: val('#cfg-thinking', c.api.thinking || 'low') || 'low',
      // 闲聊场景（群聊里没被 @）的思考档位 + 是否启用分场景
      thinkingCasual: val('#cfg-thinking-casual', c.api.thinkingCasual || 'off') || 'off',
      thinkingSplit: chk('#cfg-thinkingsplit', c.api.thinkingSplit !== false),
      thinkingBackground: val('#cfg-thinking-bg', c.api.thinkingBackground || 'off') || 'off',
      thinkingProvider: val('#cfg-thinking-provider', c.api.thinkingProvider || ''),
      thinkingUnsupported: chk('#cfg-thinking-unsupported', !!c.api.thinkingUnsupported),
      // 文本兜底：专治轻量模型不走工具协议导致的"只思考不回复"
      textFallback: chk('#cfg-textfallback', c.api.textFallback !== false),
      // 发言即收尾：省掉"只为调 finish"的那一轮 API 往返
      endAfterSend: chk('#cfg-endaftersend', c.api.endAfterSend !== false)
    };
    // 当前 API Key：只有用户在框里输入了非掩码的新值才走 /api/providers/set-key；
    // 掩码/留空都表示不改。
    const apiKeyInput = $('#cfg-apikey');
    const enteredApiKey = (apiKeyInput?.value || '').trim();
    if (enteredApiKey && enteredApiKey !== '******') {
      const pid = c.api?.provider;
      if (pid) {
        // 目录提供商的 Key 单独存（不能覆盖别的提供商的 Key）
        await api('/api/providers/set-key', {
          method: 'POST',
          body: JSON.stringify({ providerId: pid, apiKey: enteredApiKey })
        });
      } else {
        patch.api.apiKey = enteredApiKey;
      }
    }
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'bing'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      // 自定义搜索服务走 webSearch.providers 数组（由「添加自定义搜索服务」按钮维护），
      // 不在这里随表单提交 —— 避免每次保存都把动态列表覆盖掉。
      providers: c.webSearch?.providers || []
    };
  }

  if (sec === 'image') {
    // 自定义图源 / 按群覆盖的"唯一真相"是隐藏 JSON 字段（增删在界面上即时生效，保存时才提交）。
    // 解析失败就退回已保存配置 —— 绝不能因为一个坏 JSON 把整份配置清空。
    let providers = Array.isArray(c.imageSearch?.providers) ? c.imageSearch.providers : [];
    try {
      const parsed = JSON.parse(val('#cfg-img-providers-json', '') || '[]');
      if (Array.isArray(parsed)) providers = parsed;
    } catch { /* 保持旧值 */ }
    let perChat = (c.imageSearch?.perChat && typeof c.imageSearch.perChat === 'object') ? c.imageSearch.perChat : {};
    try {
      const parsed = JSON.parse(val('#cfg-img-perchat-json', '') || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) perChat = parsed;
    } catch { /* 保持旧值 */ }
    // 默认图源若指向一个已经被删掉的自定义图源，回落到 pixiv（否则搜索会一直报"找不到图源"）
    let provider = val('#cfg-img-provider', c.imageSearch?.provider || 'pixiv') || 'pixiv';
    if (provider.startsWith('custom:') && !providers.some((p) => `custom:${p.id}` === provider)) provider = 'pixiv';
    /*
     * SauceNAO 的 key：跟自定义图源的 apiKey 同一套规矩 —— 只有用户**真的输入了非空值**才写进 patch。
     * 留空不能覆盖：GET /api/config 可能不回显密钥（读到的 c.imageSearch.sauceNaoKey 是空的），
     * 一旦把空串提交上去就等于把用户存的 key 静默清空。
     * '******' 是后端脱敏时用的占位串，真出现在框里也不该写回配置。
     */
    const enteredSauceNaoKey = String(val('#cfg-img-saucenaokey', '') || '').trim();
    const sauceNaoKeyPatch = (enteredSauceNaoKey && enteredSauceNaoKey !== '******')
      ? { sauceNaoKey: enteredSauceNaoKey }
      : {};
    /*
     * pixiv Cookie 同样"留空不覆盖"：后端脱敏名单里包含 cookie 字段
     * （pixiv 登录 Cookie 属于凭据，不该明文回传前端），所以这里读到的永远是空串。
     * 若把它照原样提交上去，用户每点一次"保存设置"就会把 Cookie 清空一次。
     */
    const enteredCookie = String(val('#cfg-img-cookie', '') || '').trim();
    const cookiePatch = enteredCookie ? { cookie: enteredCookie } : {};
    /*
     * 新增数字字段的读法：把输入框清空不能当成 0（clampInt('') 会落到最小值，
     * 表现为"清空一下再保存，20 变成了 4"）。空框 = 回落到已保存配置，再回落默认值，
     * 最后统一钳到合法范围 —— 配置里永远只可能出现合法值。
     */
    const numCfg = (sel, fallback, min, max) => clampInt(val(sel, '') || fallback, min, max, fallback);
    /*
     * ⚠️ 这里刻意**不展开** c.imageSearch：它可能带着后端回传的 cookie/sauceNaoKey 明文，
     * 直接展开等于把这些凭据原地回传一遍（既没必要，也多一条泄漏路径）。
     * 未在本页暴露的字段（perChat 除外）都不需要提交 —— 后端 patch 是深合并，没传就保持原值。
     */
    patch.imageSearch = {
      enabled: chk('#cfg-img-enabled', c.imageSearch?.enabled !== false),
      provider,
      ...cookiePatch,
      hideAi: chk('#cfg-img-hideai', c.imageSearch?.hideAi !== false),
      aiBlockTags: parseCommaList(val('#cfg-img-aitags', (c.imageSearch?.aiBlockTags || []).join(','))),
      allowR18: chk('#cfg-img-r18', c.imageSearch?.allowR18 === true),
      defaultLimit: clampInt(val('#cfg-img-limit', c.imageSearch?.defaultLimit ?? 3), 1, 10, 3),
      maxDownloadMb: Math.min(30, Math.max(0.5, Number(val('#cfg-img-maxmb', c.imageSearch?.maxDownloadMb ?? 8)) || 8)),
      sendMode: val('#cfg-img-sendmode', c.imageSearch?.sendMode || 'auto') || 'auto',
      timeoutMs: Math.max(3000, Number(val('#cfg-img-timeout', c.imageSearch?.timeoutMs ?? 15000)) || 15000),
      // ── 画质 / 人气：范围与 src/image-search.js 的 imageSearchConfig() 保持一致 ──
      sortBy: val('#cfg-img-sortby', c.imageSearch?.sortBy || 'popular') === 'newest' ? 'newest' : 'popular',
      minBookmarks: numCfg('#cfg-img-minbm', c.imageSearch?.minBookmarks ?? 0, 0, 1000000),
      rankPool: numCfg('#cfg-img-rankpool', c.imageSearch?.rankPool ?? 20, 4, 60),
      preferOriginal: chk('#cfg-img-preferorig', c.imageSearch?.preferOriginal !== false),
      maxImageMb: numCfg('#cfg-img-maximgmb', c.imageSearch?.maxImageMb ?? 12, 1, 30),
      minPixels: numCfg('#cfg-img-minpx', c.imageSearch?.minPixels ?? 0, 0, 100000),
      // 留空就不带这个键（见上面 sauceNaoKeyPatch 的说明）
      ...sauceNaoKeyPatch,
      // perChat 是映射：普通深合并删不掉键，必须用 __replace__ 整体替换
      perChat: { __replace__: perChat }
    };
    /*
     * providers 数组：**只有本页真的改过列表才提交**。
     * 原因：GET /api/config 会把 providers[].apiKey 脱敏成 hasApiKey（不回显明文），
     * 而 patch.imageSearch 是从 c.imageSearch 展开的 —— 里面那份"没有 apiKey 的数组"
     * 一旦被提交，后端 deepMerge 会把整个数组替换掉，用户的 API Key 就被静默清空了。
     * 所以没改动时直接从 patch 里删掉这个键（不提交 = 原值保留）。
     */
    if (imageProvidersDirty) {
      const keyless = providers.filter((p) => p?.hasApiKey === true && !imageProviderKeys[p.id]);
      if (keyless.length && !confirm(
        `这些图源已经有 API Key，但后端不回显密钥：${keyless.map((p) => p.name || p.id).join('、')}。\n`
        + '继续保存会把它们的 Key 清空（之后需要在图源行里重新填一次）。确定继续吗？'
      )) {
        throw new Error('已取消保存：请先给上面提示的图源重填 API Key');
      }
      patch.imageSearch.providers = providers.map((p) => {
        const key = imageProviderKeys[p.id];
        return { ...normImageProvider(p), ...(key ? { apiKey: key } : {}) };
      });
    } else {
      // 关键：上面 {...c.imageSearch} 展开进来的是**脱敏过**的数组（没有 apiKey），
      // 不删掉就等于每次保存都整体替换一次 = 静默清空所有自定义图源的 Key。
      delete patch.imageSearch.providers;
    }
  }

  if (sec === 'meme') {
    patch.meme = {
      ...(c.meme || {}),
      enabled: chk('#cfg-meme-enabled', c.meme?.enabled !== false),
      injectEnabled: chk('#cfg-meme-inject', c.meme?.injectEnabled !== false),
      autoNote: chk('#cfg-meme-autonote', c.meme?.autoNote !== false),
      recordUsage: chk('#cfg-meme-recordusage', c.meme?.recordUsage !== false),
      chatScopeEnabled: chk('#cfg-meme-chatscope', c.meme?.chatScopeEnabled !== false),
      injectMax: clampInt(val('#cfg-meme-injectmax', c.meme?.injectMax ?? 8), 0, 30, 8),
      injectMaxChars: Math.max(200, Number(val('#cfg-meme-injectchars', c.meme?.injectMaxChars ?? 1200)) || 1200),
      searchMax: clampInt(val('#cfg-meme-searchmax', c.meme?.searchMax ?? 8), 1, 50, 8)
    };
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || c.persona.botName,
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || ''),
      // 身体反应与分寸（R18）
      touchReaction: chk('#cfg-touch-reaction', c.persona.touchReaction !== false),
      touchDepth: val('#cfg-touch-depth', c.persona.touchDepth === 'deep' ? 'deep' : 'light'),
      nsfw: chk('#cfg-nsfw', c.persona.nsfw === true),
      // 三个合法值都要认（all / whitelist / private），认不出来回落 private
      nsfwScope: ['all', 'whitelist'].includes(val('#cfg-nsfw-scope', c.persona.nsfwScope))
        ? val('#cfg-nsfw-scope', c.persona.nsfwScope)
        : 'private',
      // 白名单：去重 + 去掉空白项，避免存一堆脏数据
      nsfwWhitelist: [...new Set(parseList(val('#cfg-nsfw-whitelist', (c.persona.nsfwWhitelist || []).join(','))))]
    };
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    patch.deny = { groups: [], private: [] };
    // 原先这里硬编码 false：只要点过保存就把该开关永久重置，
    // 而 UI 里根本没有输入控件 —— 只能手改 JSON，改完一保存就丢。改为读取复选框。
    const allowAllBox = $('#cfg-allowallwhenempty');
    patch.allowAllWhenEmpty = allowAllBox ? !!allowAllBox.checked : (c.allowAllWhenEmpty === true);
  }

  if (sec === 'chat') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 2000;
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    // 恢复时的积压处理方式。用 || 'tier' 而不是直接取值：
    // 控件不存在时（老页面/未渲染）也要落到默认值，不能让 undefined 进配置。
    patch.resumeBacklogMode = val('#cfg-resumebacklog', c.resumeBacklogMode) || 'tier';
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      // 回退值必须与 config.js 的 DEFAULT_CONFIG.send.maxPerMinute 一致（80）
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 80,
      maxPerHour: Number(val('#cfg-maxperhour', c.send?.maxPerHour)) || 500,
      byLengthMs: Number(val('#cfg-bylength', c.send?.byLengthMs)) || 20,
      hardSplitAt: Number(val('#cfg-hardsplit', c.send?.hardSplitAt)) || 0
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25
    };
    patch.sticker = {
      ...c.sticker,
      enabled: chk('#cfg-sticker', c.sticker?.enabled !== false),
      autoNote: chk('#cfg-sticker-autonote', c.sticker?.autoNote !== false),
      contextAwarePick: chk('#cfg-sticker-ctxaware', c.sticker?.contextAwarePick !== false),
      promptMaxStickers: clampInt(val('#cfg-sticker-max', c.sticker?.promptMaxStickers ?? 10), 1, 30, 10),
      // 先取界面实时值（没这个控件时才退回已保存配置），再钳到 0~3
      encourage: Math.min(3, Math.max(0, Number(
        $('#cfg-sticker-encourage') ? $('#cfg-sticker-encourage').value : (c.sticker?.encourage ?? 1)
      ) || 0))
    };
    // 读取历史档位（替代原来的「最多条数 + 字符预算」两个固定值）
    patch.store = {
      ...(c.store || {}),
      // 档位 = 滑条位置换算（唯一真相是滑条的实时 value）。
      // 后端 updateConfig 还会用 tier-slider.js 再权威换算一次，双保险。
      contextTier: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).tier;
      })(),
      // 滑条位置存下来，重开设置页能还原到用户拖动的位置
      contextSliderPos: (() => {
        const sl = $('#ctx-tier-slider');
        return sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
      })(),
      // 3 档概率由滑条位置线性决定（不再让用户单独填数字）
      randomPercent: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).randomPercent;
      })(),
      atCount: clampInt(val('#cfg-atcount', c.store?.atCount), 1, 500, 20),
      keywordCount: clampInt(val('#cfg-kwcount', c.store?.keywordCount), 1, 500, 15),
      keywords: String($('#cfg-keywords')?.value || '')
        .split('\n').map((x) => x.trim()).filter(Boolean),
      randomPercent: clampInt(val('#cfg-randpct', c.store?.randomPercent), 0, 100, 10),
      randomCount: clampInt(val('#cfg-randcount', c.store?.randomCount), 1, 500, 8),
      allCount: clampInt(val('#cfg-allcount', c.store?.allCount), 1, 500, 80),
      // 统一开关 + 分群滑条表（__replace__：删掉的群设置要真删，深合并做不到）
      unifiedTier: chk('#cfg-unifiedtier', c.store?.unifiedTier !== false),
      groupSliderPos: {
        __replace__: (() => { try { return JSON.parse($('#tier-group-json')?.value || '{}'); } catch { return {}; } })()
      }
    };
    // 清掉已废弃的两个字段，避免残留配置误导后来读代码的人
    delete patch.store.pastStateLimit;
    delete patch.store.pastStateMaxChars;
    // 群管理员指令：开关与固定话术（admins 映射表走 /api/admins 独立管理，这里不覆盖）。
    // ⚠️ 控件在「群聊与响应」页（renderChatSection），必须挂在本分支——挂到 desktop
    //    会出现"改了设置但保存不带这个字段"的静默失效。
    patch.admin = {
      ...(c.admin || {}),
      enabled: chk('#cfg-admin-enabled', c.admin?.enabled !== false),
      muteReply: val('#cfg-admin-mutereply', c.admin?.muteReply || '').trim().slice(0, 200)
    };
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false),
      closeAsk: chk('#cfg-closeask', c.server?.closeAsk !== false)
    };
    patch.ui = {
      ...(c.ui || {}),
      // 主题在点选项时就已应用并写入 localStorage，这里同步保存到后端配置
      theme: getThemePref(),
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000
    };
    patch.memberNotes = {
      ...(c.memberNotes || {})
    };
  }

  if (sec === 'onebot') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  // 兜底保留旧配置：万一响应里没有 config（老后端/异常响应），
  // 也不能把 state.config 冲成 undefined —— 那会让下一次保存整页崩掉。
  state.config = data.config || state.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config?.api?.model || '未设置'}`;
  return data;
}

// ── 屏蔽名单 ──
// 左栏选白名单群聊，右栏拉取群成员逐个勾选；勾选 = 屏蔽。
// 弹窗内的改动只落在 pending 工作副本上，点「保存设置」才一次性 POST。
function openBlocklistModal() {
  const cfg = state.config || {};
  const allowIds = (cfg.allow?.groups || []).map(String);
  if (!allowIds.length) {
    modelModalShell({
      head: '屏蔽名单',
      body: '<div class="empty-hint">白名单为空——先去「白名单」页签添加群聊，再来屏蔽群员。</div>'
    });
    return;
  }
  const pending = structuredClone(cfg.blocklist || {});
  const selfId = String(cfg.onebot?.selfId || '');
  let activeGid = allowIds[0];
  let members = [];       // 当前群成员缓存（{userId, nickname, card}）
  let kw = '';

  const overlay = modelModalShell({
    head: '屏蔽名单',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="bl-left"></div>
        <div class="model-modal-right" id="bl-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        勾选 = 屏蔽：被屏蔽群员的消息不存档、不触发回复、不进提示词背景。
      </div>`,
    foot: `<span class="muted" id="bl-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="bl-cancel">取消</button>
           <button class="btn btn-primary" id="bl-save">保存设置</button>`
  });
  const left = overlay.querySelector('#bl-left');
  const right = overlay.querySelector('#bl-right');
  const statusEl = overlay.querySelector('#bl-status');

  const groupNames = new Map();   // 异步补群名
  function renderLeft() {
    left.innerHTML = allowIds.map((id) =>
      `<div class="mm-prov ${id === activeGid ? 'active' : ''}" data-gid="${esc(id)}">${esc(groupNames.get(id) || id)}<div class="muted" style="font-size:11px">${esc(id)}</div></div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activeGid = el.dataset.gid; renderLeft(); loadMembers(); });
    });
  }
  api('/api/onebot/groups').then((d) => {
    for (const g of (d.groups || [])) groupNames.set(String(g.id), g.name);
    renderLeft();
  }).catch(() => {});

  function isBlocked(uid) { return (pending[activeGid] || []).map(String).includes(String(uid)); }

  function renderRight() {
    const filtered = kw
      ? members.filter((m) => `${m.card} ${m.nickname} ${m.userId}`.toLowerCase().includes(kw))
      : members;
    const rows = filtered.map((m) => {
      const label = m.card || m.nickname || m.userId;
      return `<label class="bl-member">
        <input type="checkbox" class="bl-chk" data-uid="${esc(m.userId)}" ${isBlocked(m.userId) ? 'checked' : ''} />
        <span class="bl-name">${esc(label)}</span>
        <span class="muted" style="font-size:11px">${esc(m.userId)}</span>
      </label>`;
    }).join('');
    right.innerHTML = `
      <div class="ma-toolbar">
        <input type="text" id="bl-search" placeholder="搜索群员（昵称 / 群名片 / QQ 号）…" autocomplete="off" value="${esc(kw)}" />
      </div>
      <div id="bl-list">${rows || '<div class="empty-hint" style="padding:18px">没有匹配的群员</div>'}</div>`;
    right.querySelector('#bl-search').addEventListener('input', (e) => { kw = e.target.value.trim().toLowerCase(); renderRight(); });
    right.querySelectorAll('.bl-chk').forEach((chkEl) => {
      chkEl.addEventListener('change', () => {
        const uid = chkEl.dataset.uid;
        const set = new Set((pending[activeGid] || []).map(String));
        if (chkEl.checked) set.add(uid); else set.delete(uid);
        if (set.size) pending[activeGid] = [...set]; else delete pending[activeGid];
        const n = (pending[activeGid] || []).length;
        statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
      });
    });
  }

  async function loadMembers() {
    right.innerHTML = '<div class="empty-hint" style="padding:18px">正在拉取群成员…</div>';
    try {
      const d = await api(`/api/groups/${activeGid}/members`);
      // 机器人自己列出来也没意义（自己的消息本来就不走这条管道）
      members = (d.members || []).filter((m) => String(m.userId) !== selfId);
      kw = '';
      renderRight();
      const n = (pending[activeGid] || []).length;
      statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
    } catch (e) {
      right.innerHTML = `<div class="empty-hint" style="padding:18px">拉取失败：${esc(e.message)}（SnowLuma 在线才能拿到群成员列表）</div>`;
    }
  }

  overlay.querySelector('#bl-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bl-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#bl-save');
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    try {
      // __replace__：清空的群要从配置里真删掉，深合并做不到
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ blocklist: { __replace__: pending } }) });
      state.config = data.config;
      closeModelModal(overlay);
    } catch (e) {
      statusEl.textContent = `保存失败：${e.message}`;
      saveBtn.disabled = false;
    }
  });

  renderLeft();
  loadMembers();
}

// ── 表情库管理 ──
async function refreshStickerStatHint() {
  const el = $('#sticker-stat-hint');
  if (!el) return;
  try {
    const d = await api('/api/stickers?limit=1');
    const s = d.stats || {};
    el.textContent = `共 ${d.total ?? s.total ?? 0} 条，已写备注 ${s.noted ?? 0} 条，未备注 ${s.blank ?? 0} 条。`;
  } catch (e) {
    el.textContent = `统计失败：${e.message}`;
  }
}

async function openStickerManagerModal() {
  let stickers = [];
  let onlyUnnoted = false;
  let q = '';

  const overlay = modelModalShell({
    head: '表情库管理',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left">
          <div style="display:flex;gap:6px;margin-bottom:8px;padding:0 4px">
            <input type="text" id="sk-search" placeholder="搜索备注 / 含义 / 标签" style="flex:1" />
            <button class="btn btn-small" id="sk-unnoted-btn" title="只看没写备注的">未备注</button>
          </div>
          <div id="sk-list" style="overflow:auto;flex:1"></div>
        </div>
        <div class="model-modal-right" id="sk-detail"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        备注写清楚"什么意思、什么情绪下用"，机器人挑表情才准。标签/情绪用逗号分隔。
      </div>`,
    foot: `<span class="muted" id="sk-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn btn-small" id="sk-add">＋ 新增表情</button>
           <button class="btn" id="sk-close">关闭</button>`
  });
  const listEl = overlay.querySelector('#sk-list');
  const detailEl = overlay.querySelector('#sk-detail');
  const statusEl = overlay.querySelector('#sk-status');
  const searchEl = overlay.querySelector('#sk-search');
  const unnotedBtn = overlay.querySelector('#sk-unnoted-btn');
  const splitTags = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

  const load = async () => {
    const sp = new URLSearchParams({ limit: '500' });
    if (q) sp.set('q', q);
    if (onlyUnnoted) sp.set('unnoted', '1');
    try {
      const d = await api(`/api/stickers?${sp.toString()}`);
      stickers = d.stickers || [];
      renderList();
    } catch (e) {
      listEl.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
    }
  };

  const renderList = () => {
    if (!stickers.length) {
      listEl.innerHTML = '<div class="empty-hint">没有匹配的表情。</div>';
      return;
    }
    listEl.innerHTML = stickers.map((s) => {
      const named = s.label || s.desc || s.localNote || '';
      const noted = !!(s.localNote || s.usage);
      return `<div class="model-item${noted ? ' on' : ''}" data-sid="${esc(s.id)}">
        <div class="mi-main"><span class="mi-name">${esc(named || `表情 ${s.id}`)}</span>
          <span class="mi-desc">${esc((s.moods || []).join('/') || (s.tags || []).join('/') || (noted ? '' : '未备注'))}${s.useCount ? ` · 用过 ${s.useCount} 次` : ''}</span></div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('[data-sid]').forEach((el) => {
      el.addEventListener('click', () => renderDetail(el.dataset.sid));
    });
  };

  const renderDetail = (id) => {
    const s = stickers.find((x) => String(x.id) === String(id));
    if (!s) return;
    const img = s.url ? `<img src="${esc(s.url)}" style="max-width:100%;max-height:180px;border-radius:6px;border:1px solid var(--border)" />` : '<div class="muted">（无图片地址）</div>';
    detailEl.innerHTML = `
      <div style="padding:10px 12px;overflow:auto">
        <div style="text-align:center;margin-bottom:10px">${img}</div>
        <div class="field"><label>简称</label>
          <input type="text" id="sk-f-label" value="${esc(s.label || '')}" placeholder="例如：狂笑 / 无语" /></div>
        <div class="field"><label>含义备注（什么意思、什么时候用）</label>
          <textarea id="sk-f-note" rows="3" placeholder="例如：表示强烈赞同但带点夸张">${esc(s.localNote || '')}</textarea></div>
        <div class="field"><label>用法说明</label>
          <input type="text" id="sk-f-usage" value="${esc(s.usage || '')}" placeholder="例如：接梗、庆祝、嘲讽" /></div>
        <div class="field-row">
          <div class="field"><label>标签（逗号分隔）</label>
            <input type="text" id="sk-f-tags" value="${esc((s.tags || []).join(','))}" /></div>
          <div class="field"><label>情绪（逗号分隔）</label>
            <input type="text" id="sk-f-moods" value="${esc((s.moods || []).join(','))}" /></div>
        </div>
        <div class="field"><label>不适合的场景（可选）</label>
          <input type="text" id="sk-f-avoid" value="${esc(s.avoid || '')}" placeholder="例如：严肃话题、有人情绪低落时" /></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-small btn-primary" id="sk-save">保存备注</button>
          <button class="btn btn-small btn-danger" id="sk-del">删除表情</button>
        </div>
      </div>`;

    detailEl.querySelector('#sk-save')?.addEventListener('click', async () => {
      statusEl.textContent = '保存中…';
      try {
        await api(`/api/stickers/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            label: detailEl.querySelector('#sk-f-label').value,
            note: detailEl.querySelector('#sk-f-note').value,
            usage: detailEl.querySelector('#sk-f-usage').value,
            tags: splitTags(detailEl.querySelector('#sk-f-tags').value),
            moods: splitTags(detailEl.querySelector('#sk-f-moods').value),
            avoid: detailEl.querySelector('#sk-f-avoid').value
          })
        });
        statusEl.textContent = '已保存。';
        await load();
        renderDetail(id);
        refreshStickerStatHint();
      } catch (e) { statusEl.textContent = `保存失败：${e.message}`; }
    });
    detailEl.querySelector('#sk-del')?.addEventListener('click', async () => {
      statusEl.textContent = '删除中…';
      try {
        await api(`/api/stickers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        statusEl.textContent = '已删除。';
        detailEl.innerHTML = '';
        await load();
        refreshStickerStatHint();
      } catch (e) { statusEl.textContent = `删除失败：${e.message}`; }
    });
  };

  searchEl.addEventListener('input', () => { q = searchEl.value.trim(); load(); });
  unnotedBtn.addEventListener('click', () => {
    onlyUnnoted = !onlyUnnoted;
    unnotedBtn.classList.toggle('on', onlyUnnoted);
    load();
  });
  overlay.querySelector('#sk-add')?.addEventListener('click', () => {
    detailEl.innerHTML = `
      <div style="padding:10px 12px;overflow:auto">
        <div class="mi-name" style="margin-bottom:10px">新增表情</div>
        <div class="field"><label>图片 URL（必填）</label>
          <input type="text" id="sk-n-url" placeholder="http://... 或 data:image/..." /></div>
        <div class="field"><label>简称</label><input type="text" id="sk-n-label" /></div>
        <div class="field"><label>含义备注</label><textarea id="sk-n-note" rows="3"></textarea></div>
        <div class="field-row">
          <div class="field"><label>标签</label><input type="text" id="sk-n-tags" /></div>
          <div class="field"><label>情绪</label><input type="text" id="sk-n-moods" /></div>
        </div>
        <button class="btn btn-small btn-primary" id="sk-n-save" style="margin-top:10px">添加</button>
      </div>`;
    detailEl.querySelector('#sk-n-save')?.addEventListener('click', async () => {
      const url = detailEl.querySelector('#sk-n-url').value.trim();
      if (!url) { statusEl.textContent = '图片 URL 不能为空。'; return; }
      statusEl.textContent = '添加中…';
      try {
        await api('/api/stickers', {
          method: 'POST',
          body: JSON.stringify({
            url,
            label: detailEl.querySelector('#sk-n-label').value,
            note: detailEl.querySelector('#sk-n-note').value,
            tags: splitTags(detailEl.querySelector('#sk-n-tags').value),
            moods: splitTags(detailEl.querySelector('#sk-n-moods').value)
          })
        });
        statusEl.textContent = '已添加。';
        await load();
        refreshStickerStatHint();
      } catch (e) { statusEl.textContent = `添加失败：${e.message}`; }
    });
  });
  overlay.querySelector('#sk-close')?.addEventListener('click', () => closeModelModal(overlay));

  load();
}

// ── 群禁言 ──
function fmtMuteUntil(g) {
  if (!g.until) return '永久';
  const left = g.until - Date.now();
  if (left <= 0) return '已过期';
  const mins = Math.round(left / 60000);
  if (mins < 60) return `${mins} 分钟后自动解除`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} 小时后自动解除`;
  return `${Math.round(hrs / 24)} 天后自动解除`;
}

async function refreshMuteStatHint() {
  const el = $('#mute-stat-hint');
  if (!el) return;
  try {
    const d = await api('/api/muted-groups');
    const n = (d.groups || []).filter((g) => !g.expired).length;
    el.textContent = n ? `当前有 ${n} 个群聊处于禁言中。` : '当前没有禁言中的群聊。';
  } catch (e) {
    el.textContent = `读取失败：${e.message}`;
  }
}

async function openMuteGroupsModal() {
  let groups = [];
  try {
    const d = await api('/api/muted-groups');
    groups = d.groups || [];
  } catch (e) {
    modelModalShell({ head: '群禁言', body: `<div class="empty-hint">读取失败：${esc(e.message)}</div>` });
    return;
  }
  // 白名单群可一键选择
  const allowGroups = (state.config?.allow?.groups || []).map(String);

  const overlay = modelModalShell({
    head: '群禁言管理',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="mg-left"></div>
        <div class="model-modal-right" id="mg-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        禁言期间：消息照常存档，但<b>不触发任何模型调用</b>，不烧 token。解禁后不会补跑积压消息。
      </div>`,
    foot: `<span class="muted" id="mg-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="mg-close">关闭</button>`
  });
  const left = overlay.querySelector('#mg-left');
  const right = overlay.querySelector('#mg-right');
  const statusEl = overlay.querySelector('#mg-status');

  const renderLeft = () => {
    const ids = [...new Set([...allowGroups, ...groups.map((g) => String(g.groupId))])];
    left.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">选择群聊（白名单群已列出）：</div>` +
      (ids.length
        ? ids.map((id) => {
            const g = groups.find((x) => String(x.groupId) === id);
            const on = g && !g.expired;
            return `<div class="model-item${on ? ' on' : ''}" data-gid="${esc(id)}">
              <div class="mi-main"><span class="mi-name">${esc(id)}</span>
                <span class="mi-desc">${on ? `${esc(fmtMuteUntil(g))}${g.reason ? ' · ' + esc(g.reason) : ''}` : '正常'}</span></div>
            </div>`;
          }).join('')
        : '<div class="empty-hint">白名单为空——先去「白名单」页签添加群聊。</div>');
    left.querySelectorAll('[data-gid]').forEach((el) => {
      el.addEventListener('click', () => renderRight(el.dataset.gid));
    });
  };

  const renderRight = (gid) => {
    const g = groups.find((x) => String(x.groupId) === String(gid));
    const on = g && !g.expired;
    right.innerHTML = `
      <div style="padding:10px 12px">
        <div class="mi-name" style="font-size:15px;margin-bottom:8px">群 ${esc(gid)}</div>
        <div class="muted" style="font-size:12px;margin-bottom:10px">当前状态：${on ? esc(fmtMuteUntil(g)) : '正常（未禁言）'}</div>
        <div class="field"><label>禁言时长</label>
          <select id="mg-dur">
            <option value="0">永久（手动解除）</option>
            <option value="30">30 分钟</option>
            <option value="120">2 小时</option>
            <option value="480">8 小时</option>
            <option value="1440">1 天</option>
            <option value="10080">7 天</option>
          </select></div>
        <div class="field"><label>备注原因（可选）</label>
          <input type="text" id="mg-reason" placeholder="例如：刷屏 / 不需要机器人" /></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-small btn-primary" id="mg-apply">禁言</button>
          ${on ? '<button class="btn btn-small" id="mg-off">解除禁言</button>' : ''}
        </div>
      </div>`;

    right.querySelector('#mg-apply')?.addEventListener('click', async () => {
      const minutes = Number(right.querySelector('#mg-dur').value) || 0;
      const reason = String(right.querySelector('#mg-reason').value || '').trim();
      statusEl.textContent = '正在禁言…';
      try {
        const d = await api('/api/muted-groups', {
          method: 'POST',
          body: JSON.stringify({ groupId: gid, minutes: minutes || undefined, reason, by: 'console' })
        });
        groups = d.groups || groups;
        statusEl.textContent = `已禁言群 ${gid}。`;
        renderLeft(); renderRight(gid); refreshMuteStatHint();
      } catch (e) { statusEl.textContent = `失败：${e.message}`; }
    });
    right.querySelector('#mg-off')?.addEventListener('click', async () => {
      statusEl.textContent = '正在解除…';
      try {
        const d = await api(`/api/muted-groups/${encodeURIComponent(gid)}`, { method: 'DELETE' });
        groups = d.groups || groups.filter((x) => String(x.groupId) !== String(gid));
        statusEl.textContent = `已解除群 ${gid} 的禁言。`;
        renderLeft(); renderRight(gid); refreshMuteStatHint();
      } catch (e) { statusEl.textContent = `失败：${e.message}`; }
    });
  };

  overlay.querySelector('#mg-close')?.addEventListener('click', () => closeModelModal(overlay));
  renderLeft();
  if (allowGroups.length) renderRight(allowGroups[0]);
}

// ── 管理员指令 ──
async function refreshAdminStatHint() {
  const el = $('#admin-stat-hint');
  if (!el) return;
  try {
    const d = await api('/api/admins');
    const n = (d.admins || []).length;
    const on = d.enabled !== false;
    el.textContent = !on
      ? '管理员指令当前已关闭。'
      : (n ? `已配置 ${n} 个管理员。` : '还没有配置管理员——不知道谁发的算数。');
  } catch (e) {
    el.textContent = `读取失败：${e.message}`;
  }
}

async function openAdminsModal() {
  let admins = [];
  let enabled = true;
  const reload = async () => {
    const d = await api('/api/admins');
    admins = d.admins || [];
    enabled = d.enabled !== false;
  };
  try {
    await reload();
  } catch (e) {
    modelModalShell({ head: '群管理员', body: `<div class="empty-hint">读取失败：${esc(e.message)}</div>` });
    return;
  }
  const allowGroups = (state.config?.allow?.groups || []).map(String);

  const overlay = modelModalShell({
    head: '群管理员（群内「禁言 / 解除」指令）',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="ad-left"></div>
        <div class="model-modal-right" id="ad-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        只有被指定的管理员在群里发「<b>禁言</b> / <b>解除</b>」才生效；指令本身不触发对话。
        群号填 <b>*</b> 表示"全局管理员"（对所有群生效）。
      </div>`,
    foot: `<span class="muted" id="ad-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="ad-close">关闭</button>`
  });
  const left = overlay.querySelector('#ad-left');
  const right = overlay.querySelector('#ad-right');
  const statusEl = overlay.querySelector('#ad-status');

  const renderLeft = () => {
    const ids = [...new Set([...allowGroups, ...admins.map((a) => String(a.groupId))])];
    left.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">选择群聊（白名单群已列出；* = 全局）：</div>` +
      (ids.length
        ? ids.map((id) => {
            const a = admins.find((x) => String(x.groupId) === id);
            const label = String(id) === '*' ? '全局（所有群）' : `群 ${id}`;
            return `<div class="model-item${a ? ' on' : ''}" data-gid="${esc(id)}">
              <div class="mi-main"><span class="mi-name">${esc(label)}</span>
                <span class="mi-desc">${a ? `管理员：${esc(a.userId)}` : '未设置'}</span></div>
            </div>`;
          }).join('')
        : '<div class="empty-hint">白名单为空——也可以直接填群号设置。</div>');
    left.querySelectorAll('[data-gid]').forEach((el) => {
      el.addEventListener('click', () => renderRight(el.dataset.gid));
    });
  };

  const renderRight = (gid) => {
    const a = admins.find((x) => String(x.groupId) === String(gid));
    const label = String(gid) === '*' ? '全局（所有群）' : `群 ${gid}`;
    right.innerHTML = `
      <div style="padding:10px 12px">
        <div class="mi-name" style="font-size:15px;margin-bottom:8px">${esc(label)}</div>
        <div class="muted" style="font-size:12px;margin-bottom:10px">当前管理员：${a ? esc(a.userId) : '未设置'}</div>
        <div class="field"><label>管理员 QQ 号（留空 = 清除）</label>
          <input type="text" id="ad-uid" value="${esc(a ? a.userId : '')}" placeholder="例如：10001" /></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-small btn-primary" id="ad-save">保存</button>
          ${a ? '<button class="btn btn-small" id="ad-del">清除</button>' : ''}
        </div>
      </div>`;

    right.querySelector('#ad-save')?.addEventListener('click', async () => {
      const uid = String(right.querySelector('#ad-uid').value || '').trim();
      if (uid && !/^\d{1,15}$/.test(uid)) { statusEl.textContent = 'QQ 号必须是数字。'; return; }
      statusEl.textContent = '保存中…';
      try {
        await api('/api/admins', { method: 'POST', body: JSON.stringify({ groupId: gid, userId: uid }) });
        await reload();
        statusEl.textContent = uid ? `已把 ${uid} 设为 ${label} 的管理员。` : `已清除 ${label} 的管理员。`;
        renderLeft(); renderRight(gid); refreshAdminStatHint();
      } catch (e) { statusEl.textContent = `失败：${e.message}`; }
    });
    right.querySelector('#ad-del')?.addEventListener('click', async () => {
      statusEl.textContent = '清除中…';
      try {
        await api(`/api/admins/${encodeURIComponent(gid)}`, { method: 'DELETE' });
        await reload();
        statusEl.textContent = `已清除 ${label} 的管理员（原管理员再发指令不再生效）。`;
        renderLeft(); renderRight(gid); refreshAdminStatHint();
      } catch (e) { statusEl.textContent = `失败：${e.message}`; }
    });
  };

  // 自定义群号/全局：提供输入行
  const extra = document.createElement('div');
  extra.style.cssText = 'display:flex;gap:6px;margin-top:6px';
  extra.innerHTML = `<input type="text" id="ad-newgid" placeholder="群号，或 * 表示全局" style="flex:1" />
    <button class="btn btn-small" id="ad-addgid">选择</button>`;
  left.parentElement?.appendChild(extra);
  extra.querySelector('#ad-addgid')?.addEventListener('click', () => {
    const v = String(extra.querySelector('#ad-newgid').value || '').trim();
    if (!v) return;
    if (v !== '*' && !/^\d{1,15}$/.test(v)) { statusEl.textContent = '群号必须是数字，或 * 表示全局。'; return; }
    renderRight(v);
  });

  overlay.querySelector('#ad-close')?.addEventListener('click', () => closeModelModal(overlay));
  renderLeft();
  const first = admins[0]?.groupId ?? allowGroups[0];
  if (first) renderRight(first);
  else renderRight('*');
}

// ── 发言人身份 ──
async function refreshIdentityStatHint() {
  const el = $('#identity-stat-hint');
  if (!el) return;
  try {
    const d = await api('/api/identity/aliases');
    const n = (d.members || []).length;
    const r = d.renamed || 0;
    el.textContent = n ? `已记录 ${n} 位发言人，其中 ${r} 位改过名。` : '暂无昵称记录（收到消息后自动积累）。';
  } catch (e) {
    el.textContent = `读取失败：${e.message}`;
  }
}

async function openIdentityModal() {
  let members = [];
  try {
    const d = await api('/api/identity/aliases');
    members = d.members || [];
  } catch (e) {
    modelModalShell({ head: '发言人身份', body: `<div class="empty-hint">读取失败：${esc(e.message)}</div>` });
    return;
  }
  const overlay = modelModalShell({
    head: '发言人昵称记录',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="id-left"></div>
        <div class="model-modal-right" id="id-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        QQ 号不会变。机器人靠它认人，昵称只作为"当前怎么称呼"的参考；改名后会同时带上曾用名，避免认错。
      </div>`,
    foot: `<span class="muted" id="id-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="id-close">关闭</button>`
  });
  const left = overlay.querySelector('#id-left');
  const right = overlay.querySelector('#id-right');
  const statusEl = overlay.querySelector('#id-status');

  const renderLeft = () => {
    if (!members.length) {
      left.innerHTML = '<div class="empty-hint">还没有记录——机器人收到消息后会自动积累。</div>';
      return;
    }
    left.innerHTML = members.map((m) => `
      <div class="model-item${m.renamed ? ' on' : ''}" data-uid="${esc(m.userId)}">
        <div class="mi-main"><span class="mi-name">${esc(m.current || m.userId)}</span>
          <span class="mi-desc">${esc(m.userId)}${m.renamed ? ` · 曾用名 ${m.formerCount} 个` : ''}</span></div>
      </div>`).join('');
    left.querySelectorAll('[data-uid]').forEach((el) => {
      el.addEventListener('click', () => renderRight(el.dataset.uid));
    });
  };

  const renderRight = async (uid) => {
    right.innerHTML = '<div style="padding:12px" class="muted">加载中…</div>';
    try {
      const d = await api(`/api/identity/aliases/${encodeURIComponent(uid)}`);
      const hist = d.history || [];
      right.innerHTML = `
        <div style="padding:10px 12px">
          <div class="mi-name" style="font-size:15px;margin-bottom:4px">${esc(d.current || uid)}</div>
          <div class="muted" style="font-size:12px;margin-bottom:10px">QQ：${esc(uid)}</div>
          <div class="muted" style="font-size:12px;margin-bottom:6px">昵称变更时间线：</div>
          ${hist.length
            ? hist.slice().reverse().map((h, i) => `
              <div style="display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--border)">
                <span class="muted" style="font-size:11px;min-width:96px">${esc(fmtTime(h.at))}</span>
                <span style="font-size:13px">${esc(h.name || '(空)')}</span>
                ${i === 0 ? '<span style="font-size:11px;color:var(--ok)">当前</span>' : ''}
              </div>`).join('')
            : '<div class="muted" style="font-size:12px">（无历史）</div>'}
          <div style="margin-top:12px">
            <button class="btn btn-small" id="id-reset">清空历史（只留当前名）</button>
          </div>
        </div>`;
      right.querySelector('#id-reset')?.addEventListener('click', async () => {
        statusEl.textContent = '正在清空…';
        try {
          await api(`/api/identity/aliases/${encodeURIComponent(uid)}`, { method: 'DELETE' });
          statusEl.textContent = `已清空 ${uid} 的昵称历史。`;
          const dd = await api('/api/identity/aliases');
          members = dd.members || [];
          renderLeft(); renderRight(uid); refreshIdentityStatHint();
        } catch (e) { statusEl.textContent = `失败：${e.message}`; }
      });
    } catch (e) {
      right.innerHTML = `<div style="padding:12px" class="muted">读取失败：${esc(e.message)}</div>`;
    }
  };

  overlay.querySelector('#id-close')?.addEventListener('click', () => closeModelModal(overlay));
  renderLeft();
  if (members.length) renderRight(members[0].userId);
}

// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 启动 ──
(async function init() {
  // 主题：先按本地偏好应用（index.html 的内联脚本已做过一次，这里同步按钮图标），
  // 再用后端配置覆盖（若用户换了设备，以后端为准）。
  applyTheme(getThemePref());
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    // 仅在"跟随系统"时响应系统主题变化
    mq?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  } catch { /* 老浏览器不支持 addEventListener，忽略 */ }
  $('#theme-btn')?.addEventListener('click', cycleTheme);

  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();
  if (await applyFactoryResetPreferences()) return;
  try {
    if (sessionStorage.getItem('qqa-reset-success')) {
      sessionStorage.removeItem('qqa-reset-success');
      showNotice('初始化已完成，全部项目配置和使用数据已清除，请重新配置。', 'success');
    }
  } catch { /* 浏览器禁止存储时不影响首次配置 */ }

  // 本地偏好优先：旧配置可能仍保存 dark，不能在启动后把白色界面改回黑色。
  // 仍由主题按钮和桌面端保存把新选择写入后端配置。

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
})();
