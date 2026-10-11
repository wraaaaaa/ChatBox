// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './util.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // keepFiles=0 表示不限制，全部加载
      const pick = this.keepFiles > 0 ? files.slice(0, this.keepFiles) : files;
      for (const f of pick) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          if (data?.id) this.index.push(this.#summary(data));
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0,
      // 本次实际命中的档位 / 带了多少条已读历史 / 命中原因。
      // 这三个字段本来就写在会话里（orchestrator 的 #runAgent），
      // 但摘要里一直没有 —— 于是列表上看不出"这次为什么被触发、
      // 带了多少上下文"，排查档位问题时只能逐个打开完整会话。
      contextTier: s.contextTier ?? null,
      contextLimit: s.contextLimit ?? null,
      contextReason: s.contextReason ?? ''
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件
    try {
      if (this.keepFiles > 0) {
        const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
        if (files.length > this.keepFiles) {
          for (const f of files.slice(0, files.length - this.keepFiles)) {
            try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    // ⚠️ 守卫必须同时看"运行中的"和"已落盘的"。
    //    finish() 会把会话从 this.current 移除，只看 current 的话，
    //    **已结束的会话会绕过守卫被删掉存档文件** —— 而它的 token 早就算进
    //    今日用量了，删掉就是"会话页少一条 + 账目对不上"。
    //    （实测：finish 后调 discard 返回 true 且文件消失。）
    const known = this.current.get(id) || this.peek(id);
    if (known && known.status !== 'waiting') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    return this.index.length < before;
  }

  /** 管理界面删除已结束的运行记录；运行中的记录必须由运行流程自己收尾。 */
  removeRecords(ids) {
    const unique = [...new Set(ids)];
    const removed = [];
    for (const id of unique) {
      if (!/^[\w-]+$/.test(id)) throw new Error('会话 ID 不合法');
      if (this.current.has(id)) throw new Error('有会话正在运行，请结束后再清空');
      const file = sessionFile(id);
      if (!fs.existsSync(file)) continue;
      fs.unlinkSync(file);
      removed.push(id);
      this.index = this.index.filter((item) => item.id !== id);
    }
    return removed;
  }

  allRecordIds() {
    return fs.readdirSync(SESSIONS_DIR)
      .filter((name) => /^[\w-]+\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  }

  /**
   * 启动清点：把**上次进程没跑完**的会话标记为中止，并交回给调用方决定要不要重放消息。
   *
   * 为什么需要：进程被硬杀（断电 / 任务管理器强杀）时不会走 finish()，会话文件会永远停在
   * `running` —— 界面上就是一条永远"运行中"的幽灵记录。更糟的是它 drain 走的那批消息
   * 已经被标成已读，重启后**再也不会被处理**（用户看到"已读，但机器人一个字都没回"）。
   *
   * 这里只做两件事：把记录标干净（status=aborted，进索引摘要），并把会话对象交回去。
   * 消息是否放回未读由调用方判断 —— 必须遵守"本次一条都没发出去才重放"的规则，
   * 否则崩溃前已经发过话的话会被重复说一遍（与运行内重试同一规则）。
   *
   * 注意：**不**计入今日用量（那次运行没有正常收尾，usage 可能只写了一半）。
   *
   * @returns {Array<object>} 被恢复的会话对象（含 chatKey / trigger / sent）
   */
  recoverStale() {
    const out = [];
    for (const sum of this.index) {
      if (sum.status !== 'running' && sum.status !== 'waiting') continue;
      let s = null;
      try { s = JSON.parse(fs.readFileSync(sessionFile(sum.id), 'utf8')); } catch { continue; }
      if (!s || typeof s !== 'object') continue;
      s.status = 'aborted';
      s.endedAt = s.endedAt || Date.now();
      s.outcome = { ...(s.outcome || {}), interrupted: true };
      try { writeJsonAtomic(sessionFile(s.id), s, 1); } catch { /* 落盘失败也要继续清点 */ }
      const i = this.index.findIndex((e) => e.id === s.id);
      if (i >= 0) this.index[i] = this.#summary(s);
      out.push(s);
    }
    return out;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    const dayKey = localDayKey(s.startedAt);
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    data.promptTokens += s.usage.promptTokens;
    data.completionTokens += s.usage.completionTokens;
    data.totalTokens += s.usage.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + (Number(s.usage.cachedTokens) || 0);
    data.runs += 1;
    data.webSearchCount = (data.webSearchCount || 0) + (Number(s.webSearchCount) || 0);
    writeJsonAtomic(path.join(DATA_DIR, 'usage-today.json'), data);


  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s) {
    try {
      writeJsonAtomic(sessionFile(s.id), s, 1);
      if (s.status !== 'running' && s.status !== 'waiting') this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
