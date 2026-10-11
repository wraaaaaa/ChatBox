// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      是否已"停靠"（不再等待处理）。两种停靠理由：
//                 · 被某次运行消费掉（跑过模型了）
//                 · 被档位判定跳过（机器人决定不回应）
//               要区分二者看下面的 skip 字段，不要再用第二个布尔位表达。
//   skip:      可选 { at, tier, reason }：档位判定"这次不回应"时留下，
//              是"机器人为什么不理我"的唯一可查证据（read=true 但没有 skip = 被消费过）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
//              合并转发展开后，转发里的图片也会并到这里（供看图/收藏用）
//   forwardResId: 可选。合并转发卡片的 res_id（长 id），展开重试用
//               （为什么不能靠 mid：见 onebot.js 的 forwardResIdFromSegments）
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './util.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

function chatFile(chatKey) {
  // chatKey 形如 group:123 / private:456
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function loadChat(chatKey) {
  try {
    let text = fs.readFileSync(chatFile(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch { /* 新会话 */ }
  return { chatKey, nextLocalId: 1, messages: [] };
}

function saveChat(state) {
  // 原子写：失败会清掉 tmp 并把 EPERM 翻成人话（见 util.writeTextAtomic）
  writeJsonAtomic(chatFile(state.chatKey), state, 1);
}

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
    // "最近一条**收到的**消息"水位线（见 lastIncomingAt 的说明）。
    // scanned=false 时第一次读取会扫一遍已加载会话，之后只靠 appendIncoming 维护。
    this.incoming = { ts: 0, chatKey: '', scanned: false };
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  /**
   * 最近一条收到的（非自己发的）消息时间 / 所在会话。
   *
   * 为什么需要它：OneBot 显示"已连接"、SnowLuma 进程也在跑，但事件管道坏了
   * （例如两个 SnowLuma 实例抢同一个 messages.db 导致只读），消息就永远进不来。
   * 那时候**没有任何别的信号**能看出机器人已经失聪 —— 这个水位线停在故障那一刻，
   * 是唯一能抓到的证据。控制台据此提示"消息进不来了，点这里修复"。
   */
  lastIncomingAt() {
    this.#scanIncoming();
    return this.incoming.ts;
  }

  lastIncomingChat() {
    this.#scanIncoming();
    return this.incoming.chatKey;
  }

  #scanIncoming() {
    if (this.incoming.scanned) return;
    this.incoming.scanned = true;
    for (const key of this.listChats()) {
      const st = this.#state(key);
      for (let i = st.messages.length - 1; i >= 0; i--) {
        const m = st.messages[i];
        if (m.self) continue;
        if (m.ts > this.incoming.ts) this.incoming = { ts: m.ts, chatKey: key, scanned: true };
        break;
      }
    }
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) this.chats.set(chatKey, loadChat(chatKey));
    return this.chats.get(chatKey);
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(MESSAGES_DIR).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  /** 删除存档中的指定本地消息 ID；保留 nextLocalId，避免新消息复用旧编号。 */
  removeMessages(chatKey, ids) {
    const st = this.#state(chatKey);
    const selected = new Set(ids);
    const kept = st.messages.filter((message) => !selected.has(message.id));
    const removed = st.messages.length - kept.length;
    if (!removed) return 0;
    saveChat({ ...st, messages: kept });
    st.messages = kept;
    this.incoming.scanned = false;
    this.incoming.ts = 0;
    this.incoming.chatKey = '';
    return removed;
  }

  /** 删除整份聊天存档，不触及白名单、记忆、人设或 SnowLuma 数据。 */
  removeChat(chatKey) {
    const file = chatFile(chatKey);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    this.chats.delete(chatKey);
    this.incoming = { ts: 0, chatKey: '', scanned: false };
    return true;
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    let unread = 0;
    let skipped = 0;
    for (const m of st.messages) {
      if (m.self) continue;
      if (!m.read) unread++;
      if (m.skip) skipped++;
    }
    const last = st.messages[st.messages.length - 1] || null;
    // skipped = 历史上被档位判定跳过的条数。没有它的话，"档位拦下了 N 条"
    // 与"消息压根没进来"在界面上完全同形，用户无法回答"刚才那句它为什么没理我"。
    return { chatKey, total: st.messages.length, unread, skipped, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /**
   * 追加一条收到的消息（未读）。返回写入的条目。
   *
   * forwardResId：合并转发卡片里的 res_id（长 id）。存它是因为
   * SnowLuma 的 get_forward_msg 对**负数 message_id** 会误把该数字当 res_id
   * （见 onebot.js 的 forwardResIdFromSegments），有了它就随时能重试展开。
   */
  /**
   * 追加一条收到的消息（未读）。返回写入的条目；**重复投递返回 null**。
   *
   * ⚠️ 按 message_id 去重：桥在重连、补历史（SnowLuma 的 historySync）、或事件重放时，
   *    会把同一条消息再推一遍。旧行为是照单全收入档 → 同一条在存档里出现多份，
   *    而且**机器人会再回一遍**（群里看到两遍同样的话）。实测：同 mid 首次推两次
   *    只回一条（同批次），但"回完之后再重推一次"就会多回一条。
   *    只为"最近 500 条"做比对（重复投递必然是近期的），避免大群每次 O(n) 扫全表。
   *
   * forwardResId：合并转发卡片里的 res_id（长 id）。存它是因为
   * SnowLuma 的 get_forward_msg 对**负数 message_id** 会误把该数字当 res_id
   * （见 onebot.js 的 forwardResIdFromSegments），有了它就随时能重试展开。
   */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], forwardResId = null }) {
    const st = this.#state(chatKey);
    if (mid !== null && mid !== undefined && mid !== '') {
      const want = String(mid);
      const from = Math.max(0, st.messages.length - 500);
      for (let i = st.messages.length - 1; i >= from; i--) {
        const m = st.messages[i];
        if (m && !m.self && m.mid !== null && m.mid !== undefined && String(m.mid) === want) return null;
      }
    }
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : []
    };
    if (forwardResId) entry.forwardResId = String(forwardResId);
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    // 维护"消息真的进来了"的水位线（供失聪检测用）
    this.incoming = { ts: entry.ts, chatKey, scanned: true };
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /**
   * 取走当前未读（并置为已读）。
   *
   * ⚠️ 语义是"这批我已经接手了"，**不是"这批处理完了"**。
   * 运行失败时必须用 putBackUnread() 放回去，否则这批消息永久沉睡
   * （既不会被再次触发，也不会作为已读历史进入任何提示词）。
   */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of unread) m.read = true;
    if (unread.length) saveChat(st);
    return unread;
  }

  /**
   * drainUnread 的逆操作：运行失败时把"已接手但没处理"的一批放回未读。
   *
   * 调用方（orchestrator）持有触发批，所以 chatKey 由它给出，
   * 而不是从消息条目上猜。有 skip 标记的不复活 —— 那种已读是
   * "档位判定跳过"留下的，不是本次运行消费的。
   */
  putBackUnread(chatKey, entries) {
    if (!chatKey || !Array.isArray(entries) || !entries.length) return 0;
    let n = 0;
    for (const m of entries) {
      if (!m || m.self || m.skip || !m.read) continue;
      m.read = false;
      n++;
    }
    if (n) saveChat(this.#state(chatKey));
    return n;
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   *
   * opts.skip 存在时会在这批消息上留下 { tier, reason } 标记：
   * 这是"机器人决定不回应"在界面上唯一能看到的证据 —— 否则它和
   * "消息压根没进来"完全同形，用户永远无法回答"刚才那句它为什么没理我"。
   *
   * @param {{tier?:number, reason?:string}} [opts]
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey, opts = null) {
    const st = this.#state(chatKey);
    const now = Date.now();
    const tier = Number(opts?.tier) || 0;
    const reason = String(opts?.reason ?? '');
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) {
        m.read = true;
        if (opts) m.skip = { at: now, tier, reason };
        n++;
      }
    }
    if (n) saveChat(st);
    return n;
  }

  /** 历史上被档位跳过（而非被消费）的消息数，供 UI 回答"它为什么不理我"。 */
  skippedCount(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) if (m.skip) n++;
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /**
   * 查看当前未读消息（不置已读），用于**判定**与"等待中"会话的触发摘要。
   *
   * ⚠️ 不传 limit（或传 0）= 返回全部未读。判定必须看全：
   *   只看前 N 条时，排在第 N+1 条的 @ 会被漏判，然后整批被标成"跳过"
   *   （旧实现写死扫描前 200 条、跳过时却标记全部未读，就是这个 bug）。
   *
   * ⚠️ 曾经这里的默认值是 3（当初只服务于"等待中会话的摘要"），
   *   改判定共享它之后没跟着改，于是 `peekUnread(chatKey)` 悄悄只返回 3 条。
   *   要限量必须**显式**传 limit。
   *
   * @param {number} [limit] 最多返回多少条；0 或不传 = 全部
   * @returns {Array} 数组本身带 total 属性 = 未读总数（可能大于 length）
   */
  peekUnread(chatKey, limit = 0) {
    const st = this.#state(chatKey);
    const cap = Math.max(0, Number(limit) || 0);
    const out = [];
    let n = 0;
    for (const m of st.messages) {
      if (m.read || m.self) continue;
      n++;
      if (cap === 0 || out.length < cap) out.push(m);
    }
    out.total = n;   // 未读总数（可能大于 out.length）
    return out;
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体/补 res_id），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [], forwardResId = null } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if (forwardResId) m.forwardResId = String(forwardResId);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    saveChat(st);
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
