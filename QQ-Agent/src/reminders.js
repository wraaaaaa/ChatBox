// 定时提醒：长期记忆库的第四个抽屉（跟 crossGroup/people/events 并列）。
//
// 为什么放进记忆库而不是另开一个 data/reminders.json：
//   1. 记忆是"跟人设走"的（data/memory/<memoryKey>/），提醒也该如此 ——
//      换人设不该把上一个人设答应别人的事带过去；
//   2. 用户明确要求"增加到她的长期记忆库中"；
//   3. 备份/迁移/回滚的路径与记忆完全一致，少一个需要单独记得的地方。
//
// 文件：data/memory/<memoryKey>/_global/reminders.json
//   { version: 1, items: [ { id, text, note, dueAt, chatKey, ... } ] }
//
// 本模块只负责"数据 + 时间算术"，不做任何网络/模型调用，
// 因此可以在测试里完全离线地跑（见 test-reminders.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { currentMemoryKey } from './persona-store.js';
import { writeJsonAtomic } from './util.js';

const DAY_MS = 86400000;
const MIN_INTERVAL_MS = 60000;      // 周期提醒的最短间隔，防止秒级刷屏
const REPEAT_KINDS = ['none', 'daily', 'weekly', 'interval'];
const STATUSES = ['pending', 'running', 'done', 'canceled', 'missed'];

/**
 * 配置归一化。
 *
 * ⚠️ 这里踩过两个"看着没问题"的坑，改之前先看注释：
 *   1. **`?? ` 挡不住 NaN**：`Number(undefined)` / `Number('abc')` 都是 NaN，
 *      写 `Number(x) ?? 720` 会让 catchUpMinutes 变成 NaN → 补发窗口 windowMs 也是 NaN
 *      → `now - dueAt <= NaN` 恒为 false → **迟到一分钟的提醒也直接判 missed**，
 *      12 小时补发窗口形同虚设。必须用 `Number.isFinite` 判。
 *   2. **`|| 默认值` 会把显式的 0 吃掉**：`Number(x) || 30` 让 `minDelaySec: 0` 变成 30。
 *      所以凡是"0 有意义"的字段（minDelaySec）都显式判断 undefined/空值，不走 `||`。
 */
function rcfg() {
  const raw = getConfig().reminder || {};
  const num = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    enabled: raw.enabled !== false,
    // 0 = 不设最小提前量（允许"马上"提醒）
    minDelaySec: Math.max(0, num(raw.minDelaySec, 30)),
    catchUpMinutes: Math.max(0, num(raw.catchUpMinutes, 720)),
    maxPending: Math.max(1, num(raw.maxPending, 200) || 200),
    maxPendingPerChat: Math.max(1, num(raw.maxPendingPerChat, 20) || 20),
    maxPerDay: Math.max(1, num(raw.maxPerDay, 20) || 20),
    allowPrivateTarget: raw.allowPrivateTarget !== false,
    ttlDays: Math.max(1, num(raw.ttlDays, 400) || 400),
    delivery: String(raw.delivery || 'natural') === 'verbatim' ? 'verbatim' : 'natural'
  };
}

function clampInt(n, lo, hi) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  writeJsonAtomic(file, value, 1);
}

let idSeq = 0;
function newId() {
  idSeq = (idSeq + 1) % 100000;
  return `r_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

/** 会话 key 白名单化（只允许 group:/private: + 数字），防路径穿越与脏数据。 */
export function safeChatKey(value) {
  const s = String(value ?? '').trim();
  const m = /^(group|private):(\d{1,15})$/.exec(s);
  return m ? `${m[1]}:${m[2]}` : '';
}

/** QQ 号白名单化。 */
export function safeUserId(value) {
  const s = String(value ?? '').trim();
  return /^\d{1,15}$/.test(s) ? s : '';
}

/** 本地时间 HH:MM 文本（提示词与界面共用）。非法输入返回空串，不返回 08:00 这种误导值。 */
export function formatClock(ts) {
  const n = Number(ts);
  // 注意：`new Date(Number(ts) || 0)` 会把"乱写"兜到 epoch 0（东八区显示 08:00），
  // 从 number 构造的 Date 永远不会 Invalid，下面的 isFinite 检查形同虚设。
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n2) => String(n2).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 解析模型/人给的"什么时候"，返回本地时间戳。
 *
 * 支持（按优先级）：
 *   1. 时间戳（数字或 ≥10 位数字串）
 *   2. ISO / 常见写法："2026-09-13T08:00"、"2026-09-13 08:00:00"、"2026/9/13 8:00"
 *   3. 只有日期："2026-09-13" → 当天 09:00
 *   4. 只有时刻："08:00" → 今天该时刻；已过则顺延到明天
 *   5. 相对："+30m" / "+2h" / "+1d" / "30分钟后" / "2小时后" / "1天后"
 *
 * @returns {{ ok: boolean, at: number, error: string }}
 */
export function parseWhen(input, now = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, at: 0, error: 'when 不能为空（例如 "2026-09-13 08:00" 或 "30分钟后"）' };

  // 1. 纯数字
  if (/^\d{10,}$/.test(raw)) {
    const at = Number(raw);
    return at > now ? { ok: true, at, error: '' } : { ok: false, at: 0, error: '时间已经过去了' };
  }

  // 5. 相对时间（"30分钟后" / "+2h" / "1天后" / "10 分钟之后"）
  const rel = /^\+?\s*(\d+(?:\.\d+)?)\s*(s|sec|秒|m|min|分钟|分|h|hour|小时|时|d|day|天)\s*(?:后|之后|以后)?$/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mul = /^(s|sec|秒)$/.test(unit) ? 1000
      : /^(m|min|分钟|分)$/.test(unit) ? 60000
        : /^(h|hour|小时|时)$/.test(unit) ? 3600000
          : DAY_MS;
    return { ok: true, at: now + n * mul, error: '' };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const withTime = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();

  // 2/3. 日期（可带时间）
  const dm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (dm) {
    const [, y, mo, d, h, mi, s] = dm;
    const at = withTime(Number(y), Number(mo), Number(d), h === undefined ? 9 : Number(h), h === undefined ? 0 : Number(mi), Number(s) || 0);
    if (!Number.isFinite(at)) return { ok: false, at: 0, error: '日期无法理解' };
    return at > now ? { ok: true, at, error: '' } : { ok: false, at: 0, error: `时间已经过去了（${raw}），请重新算一个未来的时间` };
  }

  // 4. 只有时刻
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (tm) {
    const d = new Date(now);
    let at = withTime(d.getFullYear(), d.getMonth() + 1, d.getDate(), Number(tm[1]), Number(tm[2]), Number(tm[3]) || 0);
    if (at <= now) at += DAY_MS;   // 已过 → 明天同一时刻
    return { ok: true, at, error: '' };
  }

  return { ok: false, at: 0, error: `看不懂的时间写法：${raw}（用 "2026-09-13 08:00"、"08:00" 或 "30分钟后"）` };
}

/** 本地时间的"当天第几分钟"，用于 daily/weekly 推算。 */
function minuteOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/** 本地星期（1=周一 … 7=周日）。 */
function isoWeekday(ts) {
  const d = new Date(ts).getDay();
  return d === 0 ? 7 : d;
}

/**
 * 周期提醒的"下一次"时间。
 * daily  → 每天同一时刻
 * weekly → 指定星期几的同一时刻（weekdays 缺省 = 原本那天）
 * interval → from + intervalMs
 * @returns {number} 0 表示不再重复
 */
export function nextDueAt(reminder, from = Date.now()) {
  const rep = reminder?.repeat;
  if (!rep || rep.kind === 'none' || !REPEAT_KINDS.includes(String(rep.kind))) return 0;
  const base = Number(from) || Date.now();
  if (rep.kind === 'interval') {
    const iv = Math.max(MIN_INTERVAL_MS, Number(rep.intervalMs) || 0);
    return base + iv;
  }
  const hhmm = minuteOfDay(Number(reminder.dueAt) || base);
  const h = Math.floor(hhmm / 60);
  const m = hhmm % 60;
  const at = (dayOffset) => {
    const d = new Date(base);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m, 0, 0).getTime();
  };
  if (rep.kind === 'daily') {
    let at0 = at(0);
    if (at0 <= base) at0 = at(1);
    return at0;
  }
  // weekly
  const raw = Array.isArray(rep.weekdays) ? rep.weekdays : [];
  const days = [...new Set(raw.map((x) => clampInt(x, 1, 7)))].filter(Boolean);
  const wanted = days.length ? days : [isoWeekday(Number(reminder.dueAt) || base)];
  for (let i = 0; i <= 8; i++) {
    const ts = at(i);
    if (ts > base && wanted.includes(isoWeekday(ts))) return ts;
  }
  return 0;
}

/** 归一化 repeat 参数（模型可能传各种形状）。 */
export function normalizeRepeat(raw, dueAt) {
  if (!raw) return { kind: 'none', intervalMs: 0, weekdays: [] };
  const kind = REPEAT_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'none';
  if (kind === 'interval') {
    let iv = Number(raw.intervalMs) || 0;
    if (!iv) {
      const unit = String(raw.unit || 'm');
      const n = Number(raw.every) || 0;
      iv = n * (/^(s|sec|秒)$/.test(unit) ? 1000 : /^(h|hour|小时)$/.test(unit) ? 3600000 : /^(d|day|天)$/.test(unit) ? DAY_MS : 60000);
    }
    return { kind: 'interval', intervalMs: Math.max(MIN_INTERVAL_MS, iv || MIN_INTERVAL_MS), weekdays: [] };
  }
  const weekdays = Array.isArray(raw.weekdays)
    ? [...new Set(raw.weekdays.map((x) => clampInt(x, 1, 7)))].filter(Boolean)
    : (kind === 'weekly' ? [isoWeekday(Number(dueAt) || Date.now())] : []);
  return { kind, intervalMs: 0, weekdays };
}

/** 人类可读的重复说明（提示词与界面共用）。 */
export function repeatLabel(repeat) {
  const rep = repeat || { kind: 'none' };
  switch (rep.kind) {
    case 'daily': return '每天';
    case 'weekly': {
      const names = ['一', '二', '三', '四', '五', '六', '日'];
      const days = (rep.weekdays || []).map((d) => `周${names[d - 1] || d}`).join('、');
      return days ? `每${days}` : '每周';
    }
    case 'interval': {
      const iv = Number(rep.intervalMs) || 0;
      if (iv % DAY_MS === 0) return `每 ${iv / DAY_MS} 天`;
      if (iv % 3600000 === 0) return `每 ${iv / 3600000} 小时`;
      if (iv % 60000 === 0) return `每 ${iv / 60000} 分钟`;
      return `每 ${Math.round(iv / 1000)} 秒`;
    }
    default: return '一次性';
  }
}

/** 一句话描述一条提醒（注入提示词/界面列表共用）。 */
export function describeReminder(item, now = Date.now()) {
  const when = new Date(Number(item?.dueAt) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  const absolute = Number.isFinite(when.getTime())
    ? `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
    : '—';
  const deltaMin = Math.round((Number(item?.dueAt) - now) / 60000);
  const rel = deltaMin >= 0
    ? (deltaMin < 60 ? `${deltaMin} 分钟后` : deltaMin < 1440 ? `${Math.round(deltaMin / 60)} 小时后` : `${Math.round(deltaMin / 1440)} 天后`)
    : `${Math.abs(deltaMin)} 分钟前`;
  const rep = item?.repeat?.kind && item.repeat.kind !== 'none' ? ` · ${repeatLabel(item.repeat)}` : '';
  return `${absolute}（${rel}）${rep} · ${item?.text || ''}`;
}

// ── 主体 ────────────────────────────────────────────────────────────────

export class ReminderStore {
  constructor({ dir = '' } = {}) {
    // 显式给了 dir（测试）就钉死；否则跟着「当前人设」的 _global 目录走。
    this.fixedDir = String(dir || '');
    this.rootKey = null;
    this.items = [];
    this.loaded = false;
    this.load();
  }

  #ensureRoot() {
    const key = this.fixedDir || currentMemoryKey();
    if (key === this.rootKey) return false;
    this.rootKey = key;
    this.dir = this.fixedDir || path.join(DATA_DIR, 'memory', key, '_global');
    this.file = path.join(this.dir, 'reminders.json');
    this.items = [];
    this.loaded = false;
    return true;
  }

  get enabled() {
    return rcfg().enabled;
  }

  load() {
    this.#ensureRoot();
    if (this.loaded) return this;
    this.loaded = true;
    const raw = readJson(this.file, null);
    const list = Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : []);
    this.items = list.map((e) => this.#sanitize(e)).filter(Boolean);
    return this;
  }

  #sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text ?? '').trim().slice(0, 300);
    if (!text) return null;
    const chatKey = safeChatKey(raw.chatKey);
    if (!chatKey) return null;
    const now = Date.now();
    const dueAt = Number(raw.dueAt) || 0;
    if (!dueAt) return null;
    const status = STATUSES.includes(String(raw.status)) ? String(raw.status) : 'pending';
    return {
      id: String(raw.id || newId()),
      text,
      note: String(raw.note ?? '').trim().slice(0, 200),
      dueAt,
      chatKey,
      targetUserId: safeUserId(raw.targetUserId),
      targetName: String(raw.targetName ?? '').trim().slice(0, 60),
      creatorId: safeUserId(raw.creatorId),
      creatorName: String(raw.creatorName ?? '').trim().slice(0, 60),
      repeat: normalizeRepeat(raw.repeat, dueAt),
      importance: clampInt(raw.importance || 3, 1, 5),
      // 'model' = 模型自己定的；'manual' = 控制台手工加的
      source: raw.source === 'manual' ? 'manual' : 'model',
      status,
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now,
      firedAt: Number(raw.firedAt) || 0,
      firedCount: Math.max(0, Number(raw.firedCount) || 0),
      retries: Math.max(0, Number(raw.retries) || 0),
      lastError: String(raw.lastError ?? '').slice(0, 200),
      // 迟到的提醒：下次正常聊天时提过一句就不再重复提
      notifiedAt: Number(raw.notifiedAt) || 0
    };
  }

  #save() {
    writeJson(this.file, { version: 1, updatedAt: Date.now(), items: this.items });
  }

  /** 列表（可按会话/状态过滤；默认按时间升序）。 */
  list({ chatKey = '', status = '', limit = 0 } = {}) {
    this.load();
    const ck = safeChatKey(chatKey);
    let out = this.items.slice();
    if (ck) out = out.filter((e) => e.chatKey === ck);
    if (status) {
      const wanted = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      out = out.filter((e) => wanted.includes(e.status));
    }
    out.sort((a, b) => a.dueAt - b.dueAt);
    return limit > 0 ? out.slice(0, limit) : out;
  }

  get(id) {
    this.load();
    return this.items.find((e) => e.id === String(id)) || null;
  }

  /** 已到点、等待触发的提醒。 */
  due(now = Date.now()) {
    this.load();
    return this.items.filter((e) => e.status === 'pending' && e.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 该会话最近将要触发的提醒（注入提示词用）。 */
  upcoming(chatKey, { withinMs = 7 * DAY_MS, limit = 3, now = Date.now() } = {}) {
    this.load();
    const ck = safeChatKey(chatKey);
    if (!ck) return [];
    return this.items
      .filter((e) => e.chatKey === ck && e.status === 'pending' && e.dueAt > now && e.dueAt - now <= withinMs)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, Math.max(1, limit));
  }

  /** 迟到太多、没单独补发的提醒（下次聊天时自然提一句）。 */
  missedNotes(chatKey, { limit = 3 } = {}) {
    this.load();
    const ck = safeChatKey(chatKey);
    if (!ck) return [];
    return this.items
      .filter((e) => e.chatKey === ck && e.status === 'missed' && !e.notifiedAt)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, Math.max(1, limit));
  }

  ackMissed(ids = []) {
    const set = new Set(ids.map(String));
    let n = 0;
    for (const e of this.items) {
      if (set.has(e.id) && !e.notifiedAt) { e.notifiedAt = Date.now(); n += 1; }
    }
    if (n) this.#save();
    return n;
  }

  /** 单日新建计数（防模型抽风刷屏）。 */
  #createdToday(now = Date.now()) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return this.items.filter((e) => e.createdAt >= d.getTime()).length;
  }

  /**
   * 新建一条提醒。
   * @returns {{ ok: boolean, item?: object, error?: string }}
   */
  create({
    text, note = '', dueAt, chatKey, targetUserId = '', targetName = '',
    creatorId = '', creatorName = '', repeat = null, importance = 3, source = 'model'
  } = {}) {
    this.load();
    const cfg = rcfg();
    if (!cfg.enabled) return { ok: false, error: '定时提醒功能已关闭（设置 → 记忆 → 定时提醒）' };
    const body = String(text ?? '').trim().slice(0, 300);
    if (!body) return { ok: false, error: '提醒内容不能为空' };
    const ck = safeChatKey(chatKey);
    if (!ck) return { ok: false, error: 'chatKey 不合法' };
    const at = Number(dueAt) || 0;
    if (!at) return { ok: false, error: '时间不合法' };
    const minAt = Date.now() + cfg.minDelaySec * 1000;
    if (at < minAt) {
      return { ok: false, error: `时间太近了（至少要在 ${cfg.minDelaySec} 秒之后），或者已经过去；请重新算一个未来的时间点` };
    }
    const pendingAll = this.items.filter((e) => e.status === 'pending' || e.status === 'running');
    if (pendingAll.length >= cfg.maxPending) {
      return { ok: false, error: `待触发提醒已达上限（${cfg.maxPending} 条），先取消一些旧的再定` };
    }
    if (pendingAll.filter((e) => e.chatKey === ck).length >= cfg.maxPendingPerChat) {
      return { ok: false, error: `这个会话的待触发提醒已经很多了（${cfg.maxPendingPerChat} 条），先取消一些再定` };
    }
    if (this.#createdToday() >= cfg.maxPerDay) {
      return { ok: false, error: `今天新建的提醒已达上限（${cfg.maxPerDay} 条），明天再说或先精简一下` };
    }
    const item = {
      id: newId(),
      text: body,
      note: String(note ?? '').trim().slice(0, 200),
      dueAt: at,
      chatKey: ck,
      targetUserId: cfg.allowPrivateTarget ? safeUserId(targetUserId) : '',
      targetName: String(targetName ?? '').trim().slice(0, 60),
      creatorId: safeUserId(creatorId),
      creatorName: String(creatorName ?? '').trim().slice(0, 60),
      repeat: normalizeRepeat(repeat, at),
      importance: clampInt(importance || 3, 1, 5),
      source: source === 'manual' ? 'manual' : 'model',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      firedAt: 0,
      firedCount: 0,
      retries: 0,
      lastError: '',
      notifiedAt: 0
    };
    this.items.push(item);
    this.#save();
    return { ok: true, item };
  }

  /** 局部更新（文本/时间/内容）。 */
  update(id, patch = {}) {
    this.load();
    const item = this.get(id);
    if (!item) return { ok: false, error: '找不到这条提醒' };
    if (patch.text !== undefined) {
      const t = String(patch.text).trim().slice(0, 300);
      if (!t) return { ok: false, error: '提醒内容不能为空' };
      item.text = t;
    }
    if (patch.note !== undefined) item.note = String(patch.note).trim().slice(0, 200);
    if (patch.dueAt !== undefined) {
      const at = Number(patch.dueAt) || 0;
      if (!at) return { ok: false, error: '时间不合法' };
      item.dueAt = at;
    }
    if (patch.repeat !== undefined) item.repeat = normalizeRepeat(patch.repeat, item.dueAt);
    if (patch.importance !== undefined) item.importance = clampInt(patch.importance, 1, 5);
    if (patch.status !== undefined && STATUSES.includes(String(patch.status))) {
      item.status = String(patch.status);
      if (item.status === 'pending') { item.firedAt = 0; item.lastError = ''; }
    }
    if (patch.targetUserId !== undefined) item.targetUserId = safeUserId(patch.targetUserId);
    if (patch.targetName !== undefined) item.targetName = String(patch.targetName).trim().slice(0, 60);
    item.updatedAt = Date.now();
    this.#save();
    return { ok: true, item };
  }

  cancel(id) {
    return this.update(id, { status: 'canceled' });
  }

  remove(id) {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((e) => e.id !== String(id));
    if (this.items.length !== before) { this.#save(); return true; }
    return false;
  }

  clearAll() {
    this.load();
    if (this.items.some((item) => item.status === 'running')) throw new Error('有提醒正在发送，请稍后再清空');
    writeJson(this.file, { version: 1, updatedAt: Date.now(), items: [] });
    this.items = [];
    return true;
  }

  /** 清理已完成/已取消/已错过的旧记录。 */
  prune({ now = Date.now() } = {}) {
    this.load();
    const cutoff = now - rcfg().ttlDays * DAY_MS;
    const before = this.items.length;
    this.items = this.items.filter((e) => e.status === 'pending' || e.status === 'running' || e.updatedAt >= cutoff);
    const removed = before - this.items.length;
    if (removed) this.#save();
    return removed;
  }

  /** 出队：把该触发的提醒标成 running 并落盘（保证重启/崩溃不会重复补发）。 */
  claim(id, now = Date.now()) {
    const item = this.get(id);
    if (!item || item.status !== 'pending') return null;
    item.status = 'running';
    item.firedAt = now;
    item.updatedAt = now;
    this.#save();
    return item;
  }

  /**
   * 释放：把 running 退回 pending（本次没发出去，但不算失败）。
   * 用于"会话正在运行/并发满了/已暂停"这类**外部原因** ——
   * 不消耗重试次数，下个 tick 自然还会再来一次。
   */
  release(id) {
    const item = this.get(id);
    if (!item || item.status !== 'running') return null;
    item.status = 'pending';
    item.updatedAt = Date.now();
    this.#save();
    return item;
  }

  /** 触发成功：done 或（周期提醒）排下一次。 */
  markFired(id, { at = Date.now() } = {}) {
    const item = this.get(id);
    if (!item) return null;
    item.firedCount = (Number(item.firedCount) || 0) + 1;
    item.firedAt = at;
    item.updatedAt = at;
    item.lastError = '';
    item.retries = 0;
    // 下个周期的基准取 max(实际触发时间, 原定时间)：daily 会按"原定时刻"
    // 取整，若只用实际触发时间，定在 20:16:30 的提醒下次会排到 20:16:00
    // （比原定时间还早），看起来像"提前了"。
    const next = nextDueAt(item, Math.max(at, Number(item.dueAt) || at));
    if (next) {
      item.dueAt = next;
      item.status = 'pending';
    } else {
      item.status = 'done';
    }
    this.#save();
    return item;
  }

  /**
   * 触发失败。
   * graceful=true（模型没发话但兜底直发成功）→ 视同触发成功，周期继续。
   * graceful=false → 记 error，回到 pending 等下一轮重试（最多重试若干次后判 missed）。
   */
  markFailed(id, { error = '', at = Date.now(), graceful = false } = {}) {
    const item = this.get(id);
    if (!item) return null;
    item.updatedAt = at;
    item.lastError = String(error).slice(0, 200);
    if (graceful) {
      item.firedCount = (Number(item.firedCount) || 0) + 1;
      const next = nextDueAt(item, Math.max(at, Number(item.dueAt) || at));
      if (next) { item.dueAt = next; item.status = 'pending'; } else { item.status = 'done'; }
    } else {
      item.firedCount = (Number(item.firedCount) || 0) + 1;
      // 第一次失败：退回 pending，下个 tick 还会再试；连续失败多次直接判 missed（避免卡死刷屏）
      item.status = item.lastError && (Number(item.retries) || 0) >= 2 ? 'missed' : 'pending';
      item.retries = (Number(item.retries) || 0) + 1;
    }
    this.#save();
    return item;
  }

  /**
   * 启动补发：迟到的提醒。
   * 窗口内 → 立刻发；超窗口 → 标 missed（之后聊天里自然提一句）。
   * 顺带回收"卡在 running"的僵尸条目（上次进程在触发途中被杀）。
   */
  sweepMissed({ now = Date.now(), staleRunningMs = 300000 } = {}) {
    this.load();
    const windowMs = rcfg().catchUpMinutes * 60000;
    const out = { fired: [], missed: [], recovered: [] };
    for (const e of this.items) {
      // 僵尸 running：触发途中进程没了 → 退回 pending 重试，不然这条提醒永远不动
      if (e.status === 'running' && now - (e.firedAt || e.updatedAt || 0) > staleRunningMs) {
        e.status = 'pending';
        e.updatedAt = now;
        out.recovered.push(e.id);
      }
      if (e.status !== 'pending' || e.dueAt > now) continue;
      if (now - e.dueAt <= windowMs) {
        out.fired.push(e.id);
      } else {
        e.status = 'missed';
        e.updatedAt = now;
        out.missed.push(e.id);
      }
    }
    if (out.missed.length || out.recovered.length) this.#save();
    return out;
  }

  stats(now = Date.now()) {
    this.load();
    const by = { pending: 0, running: 0, done: 0, canceled: 0, missed: 0 };
    let nextDueAtTs = 0;
    for (const e of this.items) {
      if (by[e.status] !== undefined) by[e.status] += 1;
      if (e.status === 'pending' && (!nextDueAtTs || e.dueAt < nextDueAtTs)) nextDueAtTs = e.dueAt;
    }
    return {
      enabled: this.enabled,
      total: this.items.length,
      ...by,
      nextDueAt: nextDueAtTs,
      file: this.file,
      catchUpMinutes: rcfg().catchUpMinutes
    };
  }
}
