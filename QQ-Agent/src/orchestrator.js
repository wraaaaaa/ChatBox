// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【本次唤醒】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, storeConfigForChat } from './config.js';
import { vendorOfConfig } from './model-identity.js';
import { sleep, randInt, createEventBus, todayKey } from './util.js';
import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool, imageToDataUrl } from './tools.js';
import { imageSearchConfigForChat } from './image-search.js';
import { visionUsable } from './vision-scan.js';
import { currentProviders } from './providers.js';
import { memoryChat } from './memory-llm.js';
import { isMuted, pruneMuted } from './mute.js';

const DAY_MS = 86400000;

// ── "发言后直接收尾"用到的工具分类（见 config.api.endAfterSend 的注释）──
//
// 发送类：调用它们就等于"这句话已经说出去了"，是终态动作。
const SEND_TOOLS = new Set(['send_message', 'send_sticker', 'send_image', 'send_poke']);
// 查询类：调用它们意味着"我要先看看结果再决定下一步"，必须再跑一轮。
// 判据刻意写成"本轮没有任何查询类工具"而不是白名单发送类 —— 这样 memory_append /
// meme_note / remind_at 这类"写了就不需要再看"的副作用工具不会挡住收尾。
const QUERY_TOOLS = new Set([
  'get_recent_messages', 'get_message_detail', 'get_message_images', 'get_active_members', 'read_forward',
  'memory_search', 'memory_query', 'recall_recent', 'memory_promote',
  'list_stickers', 'list_unnoted_stickers', 'get_sticker_image',
  'meme_search', 'meme_from_bili',
  'search_image', 'reverse_image_search', 'get_illust_detail',
  'web_search', 'web_fetch', 'remind_list'
]);

/**
 * 决定本次运行用哪个思考档位。
 *
 * 依据见 config.api.thinkingSplit / thinkingCasual 的注释：实测同一份提示词下
 * thinking='low' 要 19~41 秒、'off' 只要 2~4 秒，而输出长度是延迟的唯一主因。
 * 所以默认只在"正事"场景保留思考。
 *
 * 保留思考（用 cfg.api.thinking）：私聊、群聊里被 @、定时提醒唤醒。
 * 其余（群聊里没被 @ 的一般唤醒、主动开话题）用 cfg.api.thinkingCasual（默认 'off'）。
 *
 * @param {object} cfg 配置
 * @param {{kind?:string, reminder?:object|null, tierInfo?:object|null}} ctx
 * @returns {string} 'off' | 'low' | 'auto'
 */
export function pickThinkingMode(cfg, { kind = '', reminder = null, tierInfo = null } = {}) {
  const api = cfg?.api || {};
  const serious = String(api.thinking ?? 'low');
  if (api.thinkingSplit === false) return serious;      // 关掉分场景 = 旧行为
  if (kind === 'private') return serious;               // 私聊是直接找我说话
  if (reminder) return serious;                         // 定时提醒是要说清楚的正事
  if (Number(tierInfo?.tier) === 1) return serious;     // 被艾特 = 明确召唤
  return String(api.thinkingCasual ?? 'off').toLowerCase();
}

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    // chatKey -> 待处理计划（**纯内存，不落盘、不建会话实体**）
    // 见 #makePlan：一个计划 = 一次判定 + 那次掷出的骰子 + 触发批指纹
    this.pendingPlans = new Map();
    this.pendingSeq = 0;               // 内存等待态的自增序号（只用于 UI 显示）
    this.skipStats = new Map();        // chatKey -> { at, tier, reason } 最近一次"决定不回应"
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
    // ── 长期记忆维护 ──
    this.memoryTimer = null;             // 遗忘曲线维护定时器
    this.memoryWarmup = null;            // 启动后的首次维护
    this.lastMemoryMaintenanceAt = 0;
    this.eventExtractAt = new Map();     // chatKey -> 上次抽取长期事件的时间（冷却用）
    // ── 定时提醒调度 ──
    this.reminderTimer = null;           // 到点检查定时器
    this.reminderWarmup = null;          // 启动补发（离线期间到点的提醒）
    this.firingReminders = new Set();    // 正在触发的提醒 id（防同一 tick 重入）
    // ── 风格学习 ──
    this.lastStyleDistillAt = 0;
    // 图片描述器：只有打开 styleLearn.captionImages 才会被真正调用
    try {
      this.memory?.style?.setCaptioner?.((url) => this.#captionImage(url));
    } catch { /* 风格模块不存在时静默 */ }
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   *
   * 积压怎么处理由 config.resumeBacklogMode 决定：
   *   'tier'（默认）= 按档位判定 —— 省 token，但 3 档群里积压很可能被整批跳过，
   *                   用户看到的是"点了恢复却还是不理我"；
   *   'force'       = 一律补处理 —— 暂停期间的话都会被看到。
   * 这里只负责把意图传下去，判定逻辑统一在 wake 里（见 forced 参数），
   * 避免"恢复走的是一套判定、正常消息走另一套"。
   */
  drainBacklogAfterResume() {
    const forced = String(getConfig().resumeBacklogMode || 'tier') === 'force';
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0, { forced });
    }
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    if (this.paused || this.aborted) return;
    // 群禁言：硬闸门。消息已经在 store 里存档，但**绝不触发运行**——
    // 这是"不在这个群白烧 token"的关键（用户明确要求）。
    if (this.#isChatMuted(chatKey)) {
      this.#markMutedBacklog(chatKey);
      return;
    }
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    this.scheduleWake(chatKey);
  }

  /** 该会话是否被禁言（仅群聊；私聊不受此开关影响）。 */
  #isChatMuted(chatKey) {
    const m = /^group:(\d+)$/.exec(String(chatKey || ''));
    if (!m) return false;
    try { return isMuted(m[1]); } catch { return false; }
  }

  /**
   * 禁言期间把未读沉入历史（标记已读 + 留下 mute 标记）。
   *
   * 为什么要标记而不是原地留着：留着的话解禁瞬间会一次性炸出一大批积压，
   * 既烧 token 又莫名（那些话早就过去了）。沉为"已读历史"的好处是：
   * 解禁后被 @ 时，这些内容仍会作为【过去状态】进上下文，模型不会"断片"。
   */
  #markMutedBacklog(chatKey) {
    try {
      const marked = this.store.markAllRead(chatKey, { tier: 0, reason: '群禁言' });
      if (marked) {
        this.#rememberSkip(chatKey, 0, '群禁言');
        this.emit('chat-update', chatKey);
        this.emit('session-skip', { chatKey, tier: 0, reason: '群禁言', count: marked, at: Date.now() });
        console.log(`[orchestrator] ${chatKey} 处于禁言，${marked} 条消息只存档、不触发 AI`);
      }
    } catch (error) {
      console.error(`[orchestrator] 禁言沉底失败: ${error?.message ?? error}`);
    }
  }

  /**
   * 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。
   */
  /**
   * 生成一个待处理计划（**本次判定的唯一真相**）。
   *
   * 为什么要有这个结构：scheduleWake（建等待态前）与 wake（真正运行前）
   * 需要同一个判定结论。旧实现两处各调一次 resolveContextTier 且都不传 roll，
   * 于是各掷一次骰子 —— 3 档下预判命中、实跑没命中，等待卡片就凭空消失，
   * 而且批量标记已读时拿的是"撞上本次判定"的批次。
   *
   * 这里把三样东西绑在一起，从根上杜绝漂移：
   *   · decision —— 判定结论（要不要响应、带多少条历史）
   *   · roll     —— **那次掷出的骰子本身**，随 decision 一起复用（第 1 条的根因）
   *   · fp       —— 触发批指纹（批内消息是否变过，变过才需要重新判定）
   *
   * 注意：不消费未读（用 peekUnread 只看不取），所以防抖窗口内每来一条
   * 新消息都会重新生成计划；先来一句闲聊（不命中、不显示），接着有人 @
   * 机器人（命中、立刻显示）——这正是想要的行为。
   *
   * @returns {{decision:object, roll:number, fp:string, entries:Array, at:number, cfg:object|null}}
   */
  #makePlan(chatKey, cfg = null) {
    const c = cfg || getConfig();
    // ⚠️ 必须拿**全部**未读来做判定：只看前 N 条时，排在第 N+1 条的 @
    //    会被漏判，然后整批被标成"跳过"。peekUnread 不传 limit = 取全部。
    const scanned = this.store.peekUnread(chatKey) || [];
    const total = Number(scanned.total ?? scanned.length) || 0;
    const roll = Math.random() * 100;   // ⚠️ 本次判定的骰子，必须与 decision 一起传递
    const decision = resolveContextTier({
      triggerEntries: scanned,
      selfNickname: c.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: c.persona?.botName || '',
      selfId: c.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey),   // 按会话取档位：统一开关关闭时各群可以有独立滑条
      roll,
      kind: String(chatKey || '').split(':')[0]   // 私聊不参与档位判定（见 resolveContextTier）
    });
    // 指纹只取前 200 个 id + 总数：把上万个 id 拼成字符串是纯浪费，
    // 而"总数变了"本身就足以判定批次变过（判定看的是全量，不受这里截断影响）。
    return {
      decision,
      roll,
      fp: unreadFingerprint(scanned.slice(0, 200), total),
      entries: scanned,       // 全量未读（等待态摘要只取首条，不担心大）
      at: Date.now(),
      cfg: c
    };
  }

  /** 触发批是否还是当初那一批（变了才需要重新判定，否则沿用同一个计划）。 */
  #planFresh(plan, chatKey) {
    if (!plan) return false;
    const scanned = this.store.peekUnread(chatKey) || [];
    const total = Number(scanned.total ?? scanned.length) || 0;
    return plan.fp === unreadFingerprint(scanned.slice(0, 200), total);
  }

  /** 记录一次"决定不回应"，用于回答"它刚才为什么不理我"。 */
  #rememberSkip(chatKey, tier, reason) {
    const stat = { at: Date.now(), tier: Number(tier) || 0, reason: String(reason || '') };
    this.skipStats.set(chatKey, stat);
    return stat;
  }

  /**
   * 等待态（等待中会话）的**纯内存**视图。
   *
   * 它从前是一个真的会话实体：create() 落盘 + 进索引，判定不响应时再
   * discard() 删文件。于是"等待"这个瞬时过渡态被写进了持久化数据模型，
   * 并引出两个问题：并发满时绕开清理路径 → 永久孤儿会话；以及必须靠
   * 删文件才能"干净消失"。现在它只活在内存里，由这里合成 UI 摘要。
   */
  pendingSummaryOf(chatKey) {
    const p = this.pendingPlans.get(chatKey);
    if (!p || !p.plan) return null;
    const first = p.plan.entries?.[0];
    return {
      id: pendingSessionId(p),
      chatKey,
      startedAt: p.createdAt || p.plan.at,
      endedAt: null,
      status: 'waiting',
      waitUntil: p.until ?? null,
      activity: '',
      webSearchCount: 0,
      outcome: null,
      usage: null,
      model: '',
      trigger: first
        ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}`
        : '等待新消息聚批',
      promptChars: 0,
      rounds: 0,
      pendingDecision: p.plan.decision,
      memoryOnly: true   // 告知前端：这条不在磁盘上，别去拉详情
    };
  }

  /** 内存等待态的完整视图（/api/sessions/:id 用，避免前端 404）。 */
  getPendingSession(id) {
    for (const [chatKey, p] of this.pendingPlans) {
      if (pendingSessionId(p) !== id) continue;
      const s = this.pendingSummaryOf(chatKey);
      if (!s) return null;
      return {
        ...s,
        systemPrompt: '',
        userPrompt: '',
        messages: [],
        sent: [],
        feedbacks: [],
        finishReason: null,
        error: null,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 }
      };
    }
    return null;
  }

  /** 当前所有内存等待态摘要（供 /api/sessions 合并）。 */
  pendingSummaries() {
    const out = [];
    for (const chatKey of this.pendingPlans.keys()) {
      const s = this.pendingSummaryOf(chatKey);
      if (s) out.push(s);
    }
    return out;
  }

  scheduleWake(chatKey, delay = null, { forced = false } = {}) {
    const ms = delay ?? Math.max(0, Number(getConfig().wakeDelayMs) || 2000);
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);

    // 等待窗口 > 0：在会话页立刻显示"等待中"，并随新消息重置倒计时。
    //
    // ⚠️ 先判定再显示：档位非 4 时，若这批消息确定不会响应，就不显示
    //    "等待中"——否则用户会看到一堆等半天最后消失的条目，既干扰又像出了错。
    //    窗口结束前若来了新消息且命中，届时再显示（见下面 pendingPlans 分支）。
    //
    // ⚠️ 显示与否必须与真正运行时的判定**完全一致**。3 档是概率响应，
    //    同一个决策掷两次骰子会得出相反结论，卡片就会凭空消失。
    //    所以判定结果连同那次掷出的骰子一起缓存进 plan，窗口内直接复用
    //    （见 #makePlan 的说明）——循环重排、重复调用都不会二次掷骰。
    // 只有在"该会话没在运行"时，等待窗口才有意义：这时才建立/刷新等待态。
    // 其它情况（delay=0 的让路/drain，或该会话正在运行）——等待态都不该存在。
    //
    // ⚠️ 这里的 else 分支**必须清理**：它是等待态唯一的归属者。
    //    曾经漏删，于是"会话已在运行"时上一轮留下的计划永远留在 pendingPlans 里，
    //    变成一个只存在于内存、界面显示"等待中"、实际谁都不会再处理它的幽灵条目
    //    —— 正是旧实现那个孤儿会话问题换了个形态回来。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      if (!this.#planFresh(this.pendingPlans.get(chatKey)?.plan, chatKey)) {
        const plan = this.#makePlan(chatKey);
        // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
        if (plan.entries.length === 0) plan.decision = { ...plan.decision, shouldRespond: false, reason: '无未读' };
        this.pendingPlans.set(chatKey, { plan, seq: ++this.pendingSeq, createdAt: Date.now(), until: Date.now() + ms });
        this.emit('chat-update', chatKey);
      }
      const p = this.pendingPlans.get(chatKey);
      if (p) p.until = Date.now() + ms;   // 倒计时随新消息重置
    } else {
      // delay=0（手动唤醒/并发让路/运行结束后的 drain）或该会话正在运行：
      // 不显示等待态，并确保没有任何残留计划
      if (this.pendingPlans.delete(chatKey)) this.emit('chat-update', chatKey);
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      // 触发了就把表里的引用清掉：否则一个会话跑完一轮之后，这张表里会一直留着
      // 一个"已经触发过的定时器"句柄（每个会话最多一条，有界但纯属残留；
      // 会让"还有没有待处理的唤醒"这类判断和内存快照都变得难读）。
      this.wakeTimers.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        // 窗口结束时已经跑起来了（或全局暂停/中止）：计划作废，不留残迹。
        // 这里只清理引用，**不产生任何会话实体** —— 所以并发满、暂停等
        // 分支不可能再留下"永久等待中"的孤儿（旧实现正是在这里漏了清理）。
        this.pendingPlans.delete(chatKey);
        this.emit('chat-update', chatKey);
        return;
      }
      this.wake(chatKey, { forced }).catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /** 手动触发一次处理（UI 按钮）。 */
  forceWake(chatKey) {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, reminder = null, forced = false } = {}) {
    // ── 第一步就把等待态收归本次调用 ──
    //
    // 必须在**任何**提前返回之前做：wake 有四个提前返回（已中止/已暂停/
    // 该会话已在跑/模型未设置/并发已满），漏掉任意一个，防抖窗口留下的计划
    // 就会永远留在 pendingPlans 里 —— 一个只活在内存里、界面显示"等待中"、
    // 实际谁都不会再处理它的幽灵条目。
    //
    // 旧实现是"每个分支各自收尾等待会话"，于是必然漏；现在改成
    // "进来就取走"，提前返回天然安全。
    const cached = this.pendingPlans.get(chatKey);
    const reuse = cached && this.#planFresh(cached.plan, chatKey) ? cached.plan : null;
    this.pendingPlans.delete(chatKey);

    if (this.aborted) return null;
    if (this.paused && !proactive && !reminder) return null;
    if (this.runningChats.has(chatKey)) return null;

    // 群禁言兜底：即使有别的路径绕过 onIncoming（定时提醒、主动机会、恢复补处理），
    // 这里再挡一次。禁言的群一个字都不发给模型 —— 这是最省的做法的保证。
    // 例外：定时提醒是"你之前让自己提醒的事"，不算群里闲聊，但同样不烧群上下文；
    // 若确实需要提醒，用户会把提醒对象设为私聊。这里统一禁掉，避免歧义。
    if (this.#isChatMuted(chatKey)) {
      this.#markMutedBacklog(chatKey);
      return null;
    }

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) return null;

    // 全局并发限制：满了就稍后重试。
    // 等待态已在上面收走，这里只管重排 —— scheduleWake 会按需重建。
    // （旧实现把"等待中"当成会话实体、在这一分支里改它的 waitUntil，
    //   而重排走的 scheduleWake(…, 0) 又不建等待态 —— 于是那个会话永远
    //   没人 finish/discard，变成同时烂在内存、索引、磁盘和界面里的孤儿。）
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      return;
    }

    // ── 档位：先判断"这批消息值不值得回应"，再决定要做什么 ──
    //
    // 关键顺序：判定必须发生在消费未读之前 —— 只有"确定要响应"了才把
    // 这批未读从"等待处理"里摘出来（见下面的 drainUnread）。
    //
    // 未命中时：标记已读并留下 skip 标记、不创建会话、不调模型 —— 这才是
    // 省 token 的关键（消息内容仍留在存档里，日后被艾特时作为已读历史带上）。
    const cfgNow = getConfig();
    // 定时提醒唤醒：不需要"有未读消息"这个前提（群里可能一直安静），
    // 但仍然把未读一并标掉 —— 它们会作为【过去状态】进入上下文，
    // 好让它判断"这事是不是已经不用提了"。
    const reminderMode = !!reminder;

    let plan = reuse;
    // 强制补处理（恢复运行）时不建计划：它压根不做档位判定（见下面 forced 分支），
    // 只需要"有未读"这一个前提。
    if (forced && !proactive && !reminderMode) {
      if ((this.store.peekUnread(chatKey) || []).length === 0) {
        this.emit('chat-update', chatKey);
        return;
      }
    } else if (!proactive && !reminderMode) {
      if (!plan) plan = this.#makePlan(chatKey, cfgNow);
      // 没有未读就不空跑；等待态已清，通知一次前端
      if (plan.entries.length === 0) {
        this.emit('chat-update', chatKey);
        return;
      }
    }

    let triggerEntries = [];
    let tierResult;
    if (proactive || reminderMode) {
      // 主动机会/定时提醒：不打扰、无触发批，只带状态
      triggerEntries = [];
      const cfgChatNow = storeConfigForChat(chatKey);
      tierResult = resolveContextTier({
        triggerEntries: [],
        selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
        botName: cfgNow.persona?.botName || '',
        selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
        cfg: cfgChatNow,
        kind: String(chatKey || '').split(':')[0]
      });
      // ── 上下文条数按"全量档"给，不跟档位走 ──
      // 这两类唤醒**没有触发批**，拿空批去判定必然落到"未触发 → count 0"，
      // 于是 1~3 档下【过去状态】会是空的：提醒就没法判断"这事是不是已经不用
      // 提了"，主动开话题也不知道群里刚聊到哪（3 档更糟：条数还取决于一次随机
      // 骰子）。它们本来就是"该正经说件事"的唤醒，上下文一律给足。
      // 注意：4 档用户行为完全不变（4 档本来返回的就是 allCount）。
      tierResult = {
        ...tierResult,
        tier: 4,
        count: Math.max(0, Number(cfgChatNow?.allCount) || 80),
        reason: reminderMode ? '定时提醒' : '主动机会',
        shouldRespond: true
      };
      // 零星未读一并沉入历史（它们会作为【过去状态】进入上下文）
      this.store.markAllRead(chatKey);
    } else if (forced) {
      // ── 强制补处理（恢复运行时的"积压一律补上"档）──
      //
      // 语义不是"忽略档位设置"，而是"这批消息已经确定要处理了"：
      // 所以不掷骰子、不判定是否响应，直接按"全部响应"那一档带上下文，
      // 由模型自己决定要不要说话（不说也是正常选项，走 noreply）。
      //
      // ⚠️ 仍然要把全部未读拿来做触发批：它们必须进【本次唤醒】，
      //    否则模型根本看不到暂停期间发生了什么。
      triggerEntries = this.store.drainUnread(chatKey);
      const cForced = storeConfigForChat(chatKey);
      tierResult = {
        tier: 4,
        count: Math.max(0, Number(cForced.allCount) || 80),
        reason: '恢复后补处理',
        shouldRespond: true
      };
    } else {
      if (plan.decision.shouldRespond === false) {
        // 不响应：沉入历史，不产生会话、不消耗 token。
        // 带上 skip 标记 —— 这是"机器人决定不回应"唯一可查的证据，
        // 否则它和"消息压根没进来"在界面上完全同形。
        const marked = this.store.markAllRead(chatKey, { tier: plan.decision.tier, reason: plan.decision.reason });
        this.#rememberSkip(chatKey, plan.decision.tier, plan.decision.reason);
        this.emit('chat-update', chatKey);
        this.emit('session-skip', {
          chatKey,
          tier: plan.decision.tier,
          reason: plan.decision.reason,
          count: marked,
          at: Date.now()
        });
        if (marked) {
          console.log(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（档位 ${plan.decision.tier}：${plan.decision.reason}），已标记已读、不响应`);
        }
        return;
      }
      // 确定要响应了：此刻才把这批未读摘出来（在跑之前）。
      // 跑失败时由 putBackUnread 放回（见下面的 finally）——旧实现在这里
      // 直接消费掉，一旦三次重试全败，这批消息就永久沉睡了。
      triggerEntries = this.store.drainUnread(chatKey);
      // 判定用的是同一批（peek 与 drain 之间没有别的消费者），
      // 骰子也不再重掷 —— 直接沿用计划的结论，杜绝"跑起来了却带 0 条历史"。
      tierResult = plan.decision;
    }

    this.runningChats.add(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind, chatId] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = reminder
      ? `定时提醒：${String(reminder.text || '').slice(0, 40)}`
      : (proactive
        ? '主动机会（冷场开话题）'
        : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : ''));

    // 运行 = 新建会话实体。曾经的"把等待中会话原地转成运行中"取消了：
    // 等待态不再落盘，所以这里没有可复用的实体，统一新建（一次运行 = 一条留档）。
    const session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
    this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    this.activeRuns.set(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    const MAX_SESSION_ATTEMPTS = 3;   // 用户要求：自行重试两次，两次都失败才停
    let lastError = null;
    let requeued = false;             // 触发批是否因本轮失败被放回未读（决定 drain 是否立刻重排）
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, reminder, seq, contextLimit: tierResult.count, tierInfo: tierResult });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        session.error = String(lastError?.message ?? lastError);
        this.sessions.finish(session.id, 'error');
        this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
        console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
      }
    } finally {
      // ── 触发批的去留：跑成功了才算"处理完"，失败就放回未读 ──
      //
      // 旧实现在**跑之前**就把未读标记已读，然后不管成败都不回滚：
      // 三次重试全败（或进程被杀）时，这批消息从此不再触发任何运行，
      // 也不会作为已读历史进入后续提示词 —— 静默丢消息。
      //
      // ⚠️ 放在 finally 而不是成功后：error / aborted / 抛异常都要放回，
      //    只有"真的跑过了"（含模型决定不发言的 noreply）才算处理完。
      if (triggerEntries.length > 0) {
        // session 是活的注册表对象，#runAgent 收尾时已把 status 写上去
        // （done = 发过话 / noreply = 模型决定不发言，两者都算"处理完了"）
        const statusNow = String(session.status || '');
        if (statusNow !== 'done' && statusNow !== 'noreply') {
          const back = this.store.putBackUnread(chatKey, triggerEntries);
          if (back) {
            requeued = true;
            console.warn(`[orchestrator] 运行 ${session.id} 未成功（${statusNow || '未知'}），${back} 条触发消息已放回未读，稍后重试`);
          }
        }
      }
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    // 上一轮失败的触发批（requeued）优先、且不等待 —— 它本该在上一轮就被处理掉。
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = requeued
          ? 0
          : Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);

    // 把结果交回调用方：定时提醒要凭它判断"发出去了没有、要不要兜底直发"
    return {
      sessionId: session.id,
      status: session.status || (lastError ? 'error' : 'done'),
      sent: (session.sent || []).length,
      finishReason: session.finishReason || '',
      error: session.error || ''
    };
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   */
  #resetSessionForRetry(session) {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.inputMessages = [];
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, reminder = null, seq, contextLimit = null, tierInfo = null }) {
    const cfg = getConfig();
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 视觉 / 搜图能力的判定要在拼提示词之前完成：
    // 提示词里的【搜图】段、工具表裁剪、以及搜图结果要不要回图给模型，都依赖它们。
    // visionUsable 是唯一判据（全局开关 && 模型未被判定为 no-vision）；
    // 别在这里重写判据，提示词与 #captionImage 也走同一个函数。
    const visionEnabled = visionUsable(cfg);
    const imageSearchEnabled = imageSearchConfigForChat(chatKey).enabled === true;
    // 梗库注入的相关度参考文本：用最近的实际聊天内容（触发批 + 已读历史）来挑梗，
    // 而不是只看触发批 —— 话题往往是从上一轮延续下来的。
    const memeContextText = (() => {
      try {
        const recent = this.store.recent(chatKey, { limit: 30 }) || [];
        return recent.map((m) => String(m.text || '')).join('\n').slice(-1500);
      } catch { return ''; }
    })();

    // 组装提示词（无 LLM 历史）
    // chatKind / chatKey 都要传给 buildSystemPrompt：R18 开关的作用域
    // （仅私聊 / 白名单 / 全部）靠它们判定。
    // ⚠️ 系统提示会被 prompt 缓存，别往里塞随消息漂移的内容（语感统计等已移到用户消息）。
    const systemPrompt = buildSystemPrompt({ chatKind: kind, chatKey });
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      // selfId 是机器人的真实 QQ 号（来自 onebot，不在 config 里）。
      // 提示词要用它判定"谁 @ 了我"，关系速览和历史密度排序都依赖它。
      selfId: this.onebot.selfId || '',
      memory: this.memory,
      stickerEntries,
      selfNickname,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      reminder,
      contextLimit,
      tierInfo,
      memeContextText
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    session.visionEnabled = visionEnabled;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道可能对应不同服务，用量按渠道区分。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: proactive
        ? `${userPrompt}\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPrompt }
    ];
    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessions.update(session.id);

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const searchEnabled = cfg.webSearch?.enabled !== false;
    // 关掉的功能不进工具表：省 token，也避免模型调用一个必然报错的工具
    const reminderEnabled = cfg.reminder?.enabled !== false;
    const styleEnabled = cfg.styleLearn?.enabled === true;
    const memeEnabled = cfg.meme?.enabled !== false;
    const stickerEnabled = cfg.sticker?.enabled !== false;
    const toolDefs = this.toolDefs.filter((d) => {
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      if (!reminderEnabled && (d.name === 'remind_at' || d.name === 'remind_list' || d.name === 'remind_cancel')) return false;
      if (!styleEnabled && d.name === 'style_note') return false;
      if (!imageSearchEnabled && (d.name === 'search_image' || d.name === 'send_image'
        || d.name === 'reverse_image_search' || d.name === 'get_illust_detail')) return false;
      if (!memeEnabled && (d.name === 'meme_search' || d.name === 'meme_note' || d.name === 'meme_from_bili')) return false;
      // B 站找梗单独一个开关（默认开）：关掉后不给这个工具，省 token 也避免必报错
      if (memeEnabled && cfg.meme?.biliEnabled === false && d.name === 'meme_from_bili') return false;
      // 表情包关闭时，一整套表情工具都不给（省 token，也避免调用必报错的工具）
      if (stickerEnabled === false && (d.name === 'send_sticker' || d.name === 'list_stickers'
        || d.name === 'list_unnoted_stickers' || d.name === 'get_sticker_image'
        || d.name === 'sticker_note' || d.name === 'collect_sticker')) return false;
      return true;
    });

    const openAiTools = toOpenAiTools(toolDefs);

    // 本次运行用哪个思考档位（闲聊关思考 = 延迟最大的一刀，见 pickThinkingMode）
    const runThinking = pickThinkingMode(cfg, { kind, reminder, tierInfo });
    session.thinking = runThinking;
    this.sessions.update(session.id);

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      session,
      // recall_recent 用来决定"查谁最近说过什么"。规则与提示词注入一致：
      // 本次触发批 + 最近聊天记录里出现的真人（不含机器人自己）。
      relevantUserIds: () => {
        const ids = new Set();
        for (const m of triggerEntries || []) {
          if (m.senderId && !m.self) ids.add(String(m.senderId));
        }
        for (const m of this.store.recent(chatKey, { limit: 40 }) || []) {
          if (m.senderId && !m.self) ids.add(String(m.senderId));
        }
        return ids;
      },
      emit: (type, payload) => this.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let webSearchCount = 0;
    let imageSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    session.imageSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      // 中止：先给会话一个终态再返回。否则它一直留在 sessions.current 里
      // 显示"运行中"，而且 finally 里判断终态时会误判成"没跑成"。
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return; }
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools, thinking: runThinking });
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
        raw: response.raw ?? null
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // ── 没有工具调用 = 模型结束思考（文本默认不会发给 QQ）──
        //
        // 但"轻量模型不走工具协议"是实测存在的：glm-4.5-air 会先在 reasoning 里
        // 写"我会用 send_message 回应"，然后把回复**直接写进 content**并且不返回
        // tool_calls。旧行为下这段话被静默丢掉 → 用户看到"只思考不回复"。
        // 参见 pickTextFallback 的判据说明；开关 config.api.textFallback。
        const fallbackText = getConfig().api?.textFallback === false
          ? ''
          : pickTextFallback(rawContent, { sentCount: session.sent.length });
        if (fallbackText) {
          console.warn(`[orchestrator] ${session.id} 模型未返回工具调用但输出了文本，按回复直接发出（文本兜底）：${fallbackText.slice(0, 60)}`);
          markActivity('模型未走工具协议，按文本兜底发送…');
          const sent = await executeTool(toolDefs, ctx, 'send_message', JSON.stringify({ messages: [fallbackText] }));
          markActivity('');
          if (sent?.isError) {
            console.error(`[orchestrator] ${session.id} 文本兜底发送失败：${sent.content}`);
          } else {
            session.textFallback = true;
            session.messages.push({ textFallback: { text: fallbackText } });
            this.sessions.update(session.id);
            this.emit('session-update', session.id);
          }
        }
        break;
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        if (name === 'search_image' || name === 'send_image'
          || name === 'reverse_image_search' || name === 'get_illust_detail') imageSearchCount += 1;
        session.imageSearchCount = imageSearchCount;
        markActivity(`正在调用 ${name}…`);
        const result = await executeTool(toolDefs, ctx, name, argsRaw);
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);

      // ── 发言后直接收尾：省掉"只为调 finish"的那一整轮 API 往返 ──
      //
      // 会话存档实测（2026-09-14）：1356 次多轮运行里有 943 次（69%）的**后续轮次
      // 只调用了 finish**，也就是"发完话 → 又被叫起来一次 → 回一句'我完成了'"。
      // 那一轮是一次完整的 API 往返（重新发 ~17k token 提示词），实测 2.2~3.7 秒，
      // 对用户来说纯属白等。判据与取舍见 config.api.endAfterSend 的注释。
      if (!finish && getConfig().api?.endAfterSend !== false) {
        const names = toolCalls.map((c) => c?.function?.name ?? '');
        // ⚠️ 必须看"是不是**成功**发出去了"，不能只看本轮调用了哪个工具：
        //    实测 send_message 参数写错（如把 messages 写成 text）时工具返回
        //    "错误：消息内容为空"，但旧判据只看名字 → 这一轮被当成"已经发过话"
        //    直接自动收尾，模型连错误都看不到、也没机会改用文本兜底，
        //    结果就是整批消息**静默不回**（用户视角："已读却不理人"）。
        const sentSomething = toolResults.some((r) => SEND_TOOLS.has(r.name) && !r.isError);
        // 只要本轮碰过任何一个查询类工具，就说明模型还想看结果 → 老老实实再跑一轮
        const wantsMore = names.some((n) => QUERY_TOOLS.has(n));
        if (sentSomething && !wantsMore) {
          finish = true;                    // 复用同一个出口，循环条件自然退出
          session.autoFinished = true;      // 存档里标明"这轮是自动收的尾"，便于排查
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
        }
      }
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      if (isMuted(id)) continue;   // 禁言的群不主动开话题（否则等于偷偷烧 token）
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);
      const anyMemberOverloaded = st.members.some((m) => m.count > maxPerMember);
      if (!(st.counts.memberImpression > minImpressions) && !anyMemberOverloaded) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  async consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = [];

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        if (String(resolved.userId || '')) knownUserIds.add(String(resolved.userId));
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        targets.push({ ...resolved, isNew: false });
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      const discoverMin = Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS);
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) { failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' }); continue; }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    // 整理出的结论同步进跨群档案：这样在 A 群整理出的印象，B 群也能用上。
    this.#syncGlobalFromChat(chatKey);
    // 顺带抽取"长期有效的事"（约定/梗/恩怨/长期话题）。
    // 模型在聊天中几乎不会主动记这些，靠这一步兜底；挂在整理流程上天然带冷却。
    this.#extractEventsForChat(chatKey, { force }).catch((error) => {
      console.warn(`[memory] 抽取长期事件 ${chatKey} 失败:`, error?.message ?? error);
    });
    return { ok: true, note, changed, results, skipped, failed };
  }

  /** 把本会话的记忆写穿到跨群档案（同一 QQ 号在别的群也能被认出来）。 */
  #syncGlobalFromChat(chatKey) {
    try {
      if (this.memory?.global?.enabled === false) return 0;
      if (!this.memory?.global) return 0;
      let n = 0;
      for (const m of this.memory.members(chatKey)) {
        if (!m.userId || !m.impressions.length) continue;
        this.memory.global.syncChatFacts(m.userId, m.impressions.map((e) => e.content), {
          name: m.name,
          chatKey
        });
        n += 1;
      }
      return n;
    } catch (error) {
      console.warn('[memory] 同步跨群档案失败:', error?.message ?? error);
      return 0;
    }
  }

  /**
   * 从最近的聊天记录里抽取"长期有效的事"，写进长期记忆。
   * 挂在记忆整理之后跑（复用同一冷却与模型配置）。
   */
  async #extractEventsForChat(chatKey, { force = false } = {}) {
    const cfg = getConfig();
    if (cfg.memory?.globalEnabled === false) return { ok: false, reason: '跨群记忆已关闭' };
    if (cfg.memory?.eventsEnabled === false) return { ok: false, reason: '长期事件记忆已关闭' };
    if (cfg.memory?.eventsAutoExtract === false) return { ok: false, reason: '自动抽取已关闭' };
    if (!cfg.api?.model || !cfg.api?.baseUrl) return { ok: false, reason: '模型未配置' };
    if (!this.memory?.global) return { ok: false, reason: '长期记忆未初始化' };
    if (this.aborted || this.paused) return { ok: false, reason: '已暂停' };

    const coolKey = `events:${chatKey}`;
    const cooldown = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
    // 手动整理（force=true，UI 上就是「整理本群记忆」/「更新记忆」）跳过冷却：
    // 否则刚说完的话要等 6 小时才可能被记下来，用户根本没法验证。
    if (!force && this.eventExtractAt.get(coolKey) && Date.now() - this.eventExtractAt.get(coolKey) < cooldown) {
      return { ok: false, reason: '冷却中' };
    }
    const sample = (this.store.recent(chatKey, { limit: 300 }) || [])
      .filter((m) => m.text && !/^\[(图片|表情|拍一拍|视频|语音)/.test(String(m.text)))
      .slice(-120)
      .map((m) => {
        const who = m.self ? '我' : (m.senderName || m.senderId || '某人');
        const uid = m.self ? '' : `(${m.senderId})`;
        return `${who}${uid}: ${String(m.text).slice(0, 120)}`;
      });
    if (sample.length < 10) return { ok: false, reason: '聊天记录太少' };

    const maxKeep = Math.max(1, Number(cfg.memory?.eventsAutoExtractMax) || 3);
    this.eventExtractAt.set(coolKey, Date.now());
    const res = await this.#memoryChat([
      {
        role: 'system',
        content: '你是聊天机器人的长期记忆模块，负责从聊天记录里挑出"以后还值得记得的事"。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"events":[{"text":"…","kind":"promise","scope":"global","participants":["123456"],"importance":4}]}'
      },
      {
        role: 'user',
        content: [
          '下面是群里最近的一段聊天记录（格式 "名字(QQ号): 内容"，"我" 是机器人自己）。',
          `请挑出最多 ${maxKeep} 件"长期有效"的事，只挑以后真的还用得上的：`,
          '1. 约定/承诺（谁答应了什么、约好做什么）→ kind=promise',
          '2. 群里的梗/固定说法（怎么来的、怎么用）→ kind=joke',
          '3. 恩怨/雷点/禁忌（谁跟谁不对付、别提什么）→ kind=grudge',
          '4. 某人正在长期纠结/推进的事（换工作、考试、做项目）→ kind=topic',
          '5. 某人稳定的偏好（不吃辣、只玩某个游戏）→ kind=preference',
          '',
          '再判断 scope（决定这件事在哪里会被想起来）：',
          '- global：跟某个具体的人绑定、应该"人到哪就记到哪"。例如：别人特意让你记住的信息、某人的长期偏好、你和某人的约定、某人的近况。→ scope="global"，并且必须把对方的 QQ 号填进 participants。',
          '- chat：只属于这个会话的语境。例如：群里共同的梗、群里的恩怨、群里正在聊的话题。→ scope="chat"。',
          '- 拿不准就选 chat。选了 global 却没填 participants 等于没写。',
          '',
          '硬性要求：',
          '- 只写记录里真的出现过的事实，绝不脑补；没有值得记的就输出空数组。',
          '- text 用一句话说清，≤80 字，写"谁做了什么/是什么"，不要流水账，不要带消息编号。',
          '- participants 填涉及的人的 QQ 号（纯数字；拿不准就填空数组）。',
          '- importance：约定/恩怨/雷点 4~5；长期话题/偏好 3；普通梗 2。',
          '',
          sample.join('\n')
        ].join('\n')
      }
    ]);

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed || !Array.isArray(parsed.events)) {
      console.warn(`[memory] 抽取长期事件 ${chatKey}：模型返回无法解析，本轮放弃`);
      return { ok: false, reason: '模型返回无法解析' };
    }
    let saved = 0;
    for (const e of parsed.events.slice(0, maxKeep)) {
      const text = String(e?.text ?? '').trim();
      if (!text) continue;
      const participants = Array.isArray(e?.participants) ? e.participants.filter(Boolean) : [];
      // 只有"跟人绑定 + 填了人"才允许跨群，否则没有锚点、注入时也匹配不上
      const scope = e?.scope === 'global' && participants.length ? 'global' : 'chat';
      const ev = this.memory.global.noteEvent({
        text: text.slice(0, 120),
        kind: String(e?.kind ?? 'event'),
        scope,
        chatKey,
        participants,
        importance: Number(e?.importance) || 3
      });
      if (ev) saved += 1;
    }
    if (saved) {
      this.emit('memory-update', { chatKey, phase: 'events-extracted', saved });
      console.log(`[memory] ${chatKey} 抽取到 ${saved} 条长期事件`);
    }
    return { ok: true, saved };
  }

  /**
   * 长期记忆维护：跑遗忘曲线，把已经淡出阈值的记忆淘汰掉。
   * 与"整理"（靠条数触发）不同，这里靠时间触发，保证记忆库不会无限膨胀。
   */
  #runMemoryMaintenance() {
    try {
      const cfg = getConfig();
      if (cfg.memory?.globalEnabled === false) return;
      if (this.paused || this.aborted) return;
      // 表层记忆到期即删 —— 它的 TTL 通常比"遗忘曲线维护间隔"短得多，
      // 放在同一个节流里会让过期条目滞留很久（UI 上看着像没生效）。
      // 单独清一次，成本只是读一遍内存数组。
      try { this.memory?.global?.pruneSurface?.(); } catch { /* 清理失败不阻塞 */ }
      // 禁言记录清理：临时禁言过期后自动移除，保持配置干净（顺手，几乎零成本）
      try { pruneMuted(); } catch { /* 清理失败不阻塞 */ }
      const everyMs = Math.max(60000, Number(cfg.memory?.decayIntervalMs) || 1800000);
      if (Date.now() - (this.lastMemoryMaintenanceAt || 0) < everyMs) return;
      this.lastMemoryMaintenanceAt = Date.now();
      const r = this.memory?.global?.decay?.();
      if (r && (r.facts || r.events || r.peopleRemoved || r.surface)) {
        console.log(`[memory] 遗忘曲线：淡出事实 ${r.facts} 条、事件 ${r.events} 条、清理档案 ${r.peopleRemoved} 个、表层过期 ${r.surface} 条`);
        this.emit('memory-update', { phase: 'decay', ...r });
      }
      // 风格蒸馏搭同一班车（各自有独立的"攒够没有/冷却到没到"判断）
      this.#maybeStyleDistill().catch(() => {});
    } catch (error) {
      console.warn('[memory] 长期记忆维护失败:', error?.message ?? error);
    }
  }

  /**
   * 真人说话风格蒸馏：攒够新样本 + 过了冷却才蒸一次。
   * 手动触发走 distillStyle({ force: true })，不看阈值。
   */
  async #maybeStyleDistill({ force = false } = {}) {
    const cfg = getConfig();
    const style = this.memory?.style;
    if (!style || cfg.styleLearn?.enabled !== true) return { ok: false, error: '风格学习未开启' };
    if (!force && !style.shouldDistill()) return { ok: false, error: '还不到蒸馏时机' };
    if (this.paused || this.aborted) return { ok: false, error: '已暂停' };
    const r = await style.distill({
      persona: String(cfg.persona?.roleText || '').slice(0, 300),
      force
    });
    if (r.ok) {
      console.log(`[style] 风格蒸馏：${r.samples} 条样本 → 新增 说话 ${r.added.speech} / 反应 ${r.added.reactions}，强化 说话 ${r.reinforced.speech} / 反应 ${r.reinforced.reactions}`);
      this.emit('style-update', { phase: 'distilled', ...r });
    } else if (r.error && !/还不到|不够/.test(r.error)) {
      console.warn('[style] 风格蒸馏失败:', r.error);
      this.emit('style-update', { phase: 'error', error: r.error });
    }
    return r;
  }

  /** 供 UI/接口调用：手动蒸馏一次。 */
  async distillStyle({ force = true } = {}) {
    return this.#maybeStyleDistill({ force });
  }

  /** 启动长期记忆维护（幂等）。遗忘曲线纯本地计算，不烧 token。 */
  startMemoryMaintenance() {
    if (this.memoryTimer) return;
    // 1 分钟一跳：表层记忆的 TTL 是分钟级，跳得慢会让过期条目滞留。
    // 真跑遗忘曲线仍受 decayIntervalMs（默认 30 分钟）节流，所以频率提高不会加重负担。
    this.memoryTimer = setInterval(() => this.#runMemoryMaintenance(), 60000);
    if (this.memoryTimer.unref) this.memoryTimer.unref();
    // 启动 30 秒后再跑一次，错开启动高峰
    this.memoryWarmup = setTimeout(() => this.#runMemoryMaintenance(), 30000);
    if (this.memoryWarmup.unref) this.memoryWarmup.unref();
  }

  stopMemoryMaintenance() {
    clearInterval(this.memoryTimer);
    clearTimeout(this.memoryWarmup);
    this.memoryTimer = null;
    this.memoryWarmup = null;
  }

  // ── 定时提醒调度 ───────────────────────────────────────────────────────
  //
  // 纯本地轮询（一个 setInterval，几十毫秒的开销），不烧 token：
  //   到点 → 把提醒标成 running（先落盘，崩溃也不会重复发）
  //        → 唤醒模型，让它用自己的语气主动发一条
  //        → 模型坏了/没配置/直接报错 → 兜底把原文发出去（承诺不能丢）
  //
  // 运行中/并发满了/暂停中 → 原样退回 pending，下个 tick 再来（不消耗重试次数）。

  /** 启动提醒调度（幂等）。 */
  startReminderLoop() {
    if (this.reminderTimer) return;
    const everyMs = Math.max(5000, Number(getConfig().reminder?.checkIntervalMs) || 20000);
    this.reminderTimer = setInterval(() => {
      this.#tickReminders().catch((error) => console.warn('[reminder] 调度出错:', error?.message ?? error));
    }, everyMs);
    if (this.reminderTimer.unref) this.reminderTimer.unref();
    // 启动 8 秒后先跑一次：把"应用没开时到点"的提醒补发掉（错开启动高峰）
    this.reminderWarmup = setTimeout(() => {
      this.#tickReminders({ startup: true }).catch(() => {});
    }, 8000);
    if (this.reminderWarmup.unref) this.reminderWarmup.unref();
  }

  stopReminderLoop() {
    clearInterval(this.reminderTimer);
    clearTimeout(this.reminderWarmup);
    this.reminderTimer = null;
    this.reminderWarmup = null;
  }

  /** 供 UI/接口调用：立刻检查一次到期提醒（"立即提醒"按钮不用等 20 秒轮询）。 */
  async dispatchDueReminders() {
    return this.#tickReminders();
  }

  async #tickReminders({ startup = false } = {}) {
    const cfg = getConfig();
    const store = this.memory?.reminders;
    if (!store || this.aborted) return;
    if (startup) {
      // 离线期间到点的：窗口内补发，超窗口记 missed（下次聊天里自然提一句）
      const sweep = store.sweepMissed();
      if (sweep.fired.length || sweep.missed.length || sweep.recovered.length) {
        console.log(`[reminder] 启动清点：补发 ${sweep.fired.length} 条、错过 ${sweep.missed.length} 条、回收僵尸 ${sweep.recovered.length} 条`);
        this.emit('reminder-update', { phase: 'startup', ...sweep });
      }
      // 顺手清理过于陈旧的已完成记录
      try { store.prune(); } catch { /* 清理失败不影响调度 */ }
    }
    if (cfg.reminder?.enabled === false) return;
    if (this.paused) return;
    const due = store.due();
    if (!due.length) return;
    const maxConcurrent = Math.max(1, Number(cfg.maxConcurrentRuns) || 2);
    for (const item of due) {
      if (this.aborted || this.paused) return;
      if (this.firingReminders.has(item.id)) continue;
      // 忙就先放着：下个 tick 再来（退回 pending，不记为失败）
      if (this.runningChats.has(item.chatKey) || this.runningChats.size >= maxConcurrent) continue;
      this.firingReminders.add(item.id);
      try {
        await this.#fireReminder(item);
      } finally {
        this.firingReminders.delete(item.id);
      }
    }
  }

  /**
   * 触发一条提醒。
   * 关键取舍：模型说"没必要提了"（noreply）算成功 —— 它可以看着聊天记录判断；
   * 只有"根本没跑起来 / 报错"才兜底直发原文。
   */
  async #fireReminder(item) {
    const store = this.memory?.reminders;
    const cfg = getConfig();
    const claimed = store?.claim?.(item.id);
    if (!claimed) return;
    const chatKey = claimed.chatKey;
    const modelReady = !!String(cfg.api?.model || '').trim();
    const verbatim = String(cfg.reminder?.delivery || 'natural') === 'verbatim';
    const label = `${claimed.id}（${chatKey}）`;

    if (!verbatim && modelReady && !this.aborted && !this.paused) {
      try {
        const res = await this.wake(chatKey, { reminder: claimed });
        if (res && res.sent > 0) {
          store.markFired(claimed.id);
          console.log(`[reminder] ${label} 已提醒（模型发言 ${res.sent} 条）`);
          this.emit('reminder-update', { phase: 'fired', id: claimed.id, chatKey, via: 'model', sent: res.sent });
          return;
        }
        if (res && res.status === 'noreply') {
          // 模型看过上下文后判断"不用提了" —— 这是正常结局，不兜底、不重复打扰
          store.markFired(claimed.id);
          console.log(`[reminder] ${label} 模型判断无需提醒：${res.finishReason || '（未说明）'}`);
          this.emit('reminder-update', { phase: 'skipped', id: claimed.id, chatKey, reason: res.finishReason || '' });
          return;
        }
        if (!res) {
          // 没跑起来（并发/暂停/中止）：退回 pending，下个 tick 再试
          store.release?.(claimed.id);
          return;
        }
        console.warn(`[reminder] ${label} 模型未能发出消息（${res.status}），改走兜底直发`);
      } catch (error) {
        console.warn(`[reminder] ${label} 唤醒失败，改走兜底直发：${error?.message ?? error}`);
      }
    }

    if (cfg.reminder?.fallbackRawText === false && !verbatim) {
      store.markFailed(claimed.id, { error: '模型未能发出提醒，且兜底直发已关闭' });
      this.emit('reminder-update', { phase: 'failed', id: claimed.id, chatKey });
      return;
    }

    // ── 兜底：直接发原文。宁可语气生硬，也不能让答应过的事落空 ──
    try {
      const prefix = claimed.targetName ? `${claimed.targetName} ` : '';
      const body = `${prefix}${claimed.text}`.trim();
      await this.sender.sendTextBatch(chatKey, [body], {
        atUserId: chatKey.startsWith('group:') && claimed.creatorId ? claimed.creatorId : null
      });
      store.markFired(claimed.id);
      console.log(`[reminder] ${label} 已兜底直发原文`);
      this.emit('reminder-update', { phase: 'fired', id: claimed.id, chatKey, via: 'fallback' });
    } catch (error) {
      store.markFailed(claimed.id, { error: String(error?.message ?? error) });
      console.warn(`[reminder] ${label} 兜底直发也失败了：${error?.message ?? error}`);
      this.emit('reminder-update', { phase: 'failed', id: claimed.id, chatKey, error: String(error?.message ?? error) });
    }
  }

  /** 给被真人回复的图片生成一句内容描述（风格学习用，可选、限流、失败静默）。 */
  async #captionImage(url) {
    const cfg = getConfig();
    if (!url || cfg.styleLearn?.captionImages !== true) return '';
    // 判据与工具表一致：模型不能看图就别发图片请求（发出去必然 400，白等一次往返）
    if (!visionUsable(cfg)) return '';
    try {
      const dataUrl = await imageToDataUrl(url);
      const res = await chatCompletion({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '一句话说清这张图是什么（≤20字，只描述内容，不要评价、不要标点开头）。' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }],
        temperature: 0.2,
        thinking: getConfig().api?.thinkingBackground ?? 'off'   // 描述图片不需要思考，省 token
      });
      return String(res?.message?.content ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    } catch {
      return '';
    }
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const uidToName = new Map();
    for (const m of this.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号（必要时反查名字并回写记忆文件）。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= Orchestrator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            try {
              this.memory.replaceMember(chatKey, userId, mem.name, mem.impressions.map((e) => e.content));
            } catch { /* 回写失败不阻塞整理 */ }
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      console.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        console.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    // 整理模式：条数变多 = 疑似幻觉，放弃（保留原印象）
    if (!isNew && raw.length > existing.length) {
      console.warn(`[memory] 整理 ${chatKey}/${mem.userId} 结果条数变多（${existing.length}→${raw.length}），疑似幻觉，放弃`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, clean);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        `3. 最多保留 ${maxKeep} 条，每条不超过 120 字。`,
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        ...lines
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(mem.name && `，名字 ${mem.name}`) || ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。`,
        '4. 宁少勿错：信息不足就少写，不要脑补。',
        '5. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    // 统一走 memory-llm：角色蒸馏也用同一套"该用哪个模型"的规则，
    // 免得两处各写一份、改一处漏一处。
    return memoryChat(messages, { temperature: 0.2 });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  /**
   * 暂停 / 恢复。
   *
   * ⚠️ 恢复时**默认自动补处理积压**（与原 HTTP 接口同一语义）：
   *    以前只有 UI 的「恢复」按钮会补处理，而托盘菜单直接调 setPaused(false)
   *    —— 同一个动作在两条路径上行为不同，用户在托盘恢复后就再也等不到
   *    积压的回复。现在三条路径共用这一个实现。
   *
   * 补处理方式由 config.resumeBacklogMode 决定（'tier' 按档位判定 / 'force' 一律补）。
   *
   * @param {{skipBacklog?: boolean}} [opts] skipBacklog = 用户明确选择"丢弃积压"，
   *        这条路径**不能**先排下补处理再标已读（否则两者会打架）
   */
  setPaused(paused, reason = 'manual', { skipBacklog = false } = {}) {
    const wasPaused = this.paused;
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    if (wasPaused && !this.paused && !this.aborted && !skipBacklog) this.drainBacklogAfterResume();
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    // 等待态是纯内存的：删掉 Map 条目即可，没有会话实体需要收尾
    //（旧实现要在这里逐一 finish 掉等待会话，漏一个就留一个孤儿）
    this.pendingPlans.clear();
    this.stopProactiveLoop();
    this.stopReminderLoop();
    this.stopMemoryMaintenance();
    // 触发中途被中止的提醒退回 pending，下次启动会被 sweepMissed 兜住
    try {
      for (const id of this.firingReminders) this.memory?.reminders?.release?.(id);
      this.firingReminders.clear();
    } catch { /* ignore */ }
  }

  statusSummary() {
    const cfg = getConfig();
    const reminders = (() => {
      try { return this.memory?.reminders?.stats?.() ?? null; } catch { return null; }
    })();
    const style = (() => {
      try { return this.memory?.style?.stats?.() ?? null; } catch { return null; }
    })();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      // 内存等待态（纯 UI 过渡态，不落盘）：batch 是被防抖聚起来的未读数
      pending: [...this.pendingPlans.entries()].map(([chatKey, p]) => ({
        chatKey,
        since: p.createdAt ?? null,
        until: p.until ?? null,
        batch: p.plan?.entries?.length ?? 0,
        tier: p.plan?.decision?.tier ?? null,
        reason: p.plan?.decision?.reason ?? ''
      })),
      // 最近一次"决定不回应"（档位拦下的批次数与原因），供 UI 显示"它为什么不理我"
      skipped: [...this.skipStats.entries()].map(([chatKey, s]) => ({ chatKey, ...s })),
      consolidating: [...this.consolidating],
      // 恢复时的积压处理方式，供界面把「恢复」按钮的含义说清楚
      resumeBacklogMode: String(getConfig().resumeBacklogMode || 'tier'),
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns,
      reminders,
      style
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

/**
 * 「文本兜底」：判断"模型没调工具、但输出了文本"时该不该把这段文本当成回复发出去。
 *
 * 背景（这就是"只思考不回复"的根因）：本项目的协议是**普通文本不会发到 QQ**，
 * 要发言必须调用 send_message（见 prompt.js 的工具协议第 2 条）。强模型严格遵守，
 * 但轻量模型会无视它 —— 实测 glm-4.5-air 在 15k 长提示词下会先想"我会用
 * send_message 回应"，然后把回复原样写进 content、**不返回 tool_calls**，
 * 结果是既没发消息、也没调 finish，整轮被当成 noreply（磁盘上留下的会话就是
 * rounds=1 / toolCalls=[] / sent=0）。用户视角：机器人只想了半天，一句话没说。
 *
 * 判据为什么安全（三道闸）：
 *   ① sentCount > 0 直接放弃 —— 已经说过话就绝不再补一条，杜绝重复发言；
 *   ② 提示词给了"不想说话"的**明确出口**（直接结束或调用 finish，且"不发言"时
 *      模型实际会返回 tool_calls=[finish]）。所以"零工具调用 + 有实义文本"
 *      只可能是"它想说，但忘了走协议"，而不是"它想保持沉默"；
 *   ③ 文本要过形状检查：非空、不超长、不是工具调用 JSON 残留、不像"我这次就不
 *      回复了"这类元话语（那种话发到群里才是事故）。
 *
 * @param {*} rawContent 模型本轮的 content
 * @param {{sentCount?:number, maxChars?:number}} [opts]
 * @returns {string} 可以直接发出去的文本；返回 '' 表示不该兜底
 */
export function pickTextFallback(rawContent, { sentCount = 0, maxChars = 600 } = {}) {
  if (Number(sentCount) > 0) return '';
  let text = String(rawContent ?? '').trim();
  if (!text) return '';
  // 模型偶尔会给整段包一层 markdown 代码围栏（```text ... ```）
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
  if (!text) return '';
  // 长文多半是分析/总结/元话语，不是群聊里的一句话
  if (text.length > maxChars) return '';
  // 形如工具调用 JSON 的残留：那是"没解析成功的调用"，不是要说的话
  // （能解析的在上游 parseInlineToolCalls 已经处理掉了）
  if (/(tool_calls|"function"\s*:|"arguments"\s*:|\bsend_message\s*\()/.test(text)) return '';
  // 少数模型会把"收尾/发送"这个动作本身当文本写出来（如 "finish: 群里没我事，安静看"）——
  // 同样是协议残留，不是要说的话。
  if (/(^|\n)\s*(finish|send_message|send_sticker|send_poke)\s*[:：]/.test(text)) return '';
  // ── 括号独白（真实事故的主要来源）──
  // 把括号段全部抹掉后，如果没剩下"能说出口"的内容，那这段就是心理活动/动作描述，不是发言。
  // 实测（本机 300 次运行里 5 次走到兜底，**5 次全是这种**）：模型想保持沉默时，会把
  // "为什么不出声"的独白写进 content、且不调任何工具 —— 兜底一开就把内心独白发进群了
  // （群友看到的正是"（依山傍水就发了个 666…）（安静看。）"这种）。
  // 注：界面本来就把 assistant 文本标成「思考（不发送）」，这里的判断与它保持一致。
  const spoken = text
    .replace(/（[^（）]*）|\([^()]*\)/g, ' ')
    .replace(/[\s，。、！？…～,.;:!?~"'“”‘’\-—]+/g, '');
  if (!spoken) return '';
  // "决定不发言"的元话语：不该出现在群里 —— 但**只拦最无歧义的那几种说法**。
  //
  // 为什么刻意收得很窄：放宽会误伤正常回复（"不说了，我去睡了"、"不想理你"都是
  // 真人常见话），而"该回却不回"正是本次要修的毛病 —— 漏发的代价比多发一句
  // 吐槽大得多。所以要求①极短（≤30）②整句以"不+回复/发言/接话…"这类**只可能
  // 在描述自己要不要发言**的搭配开头。实测模型真打算沉默时会调 finish
  // （存档里能查到 toolCalls=["finish"] 的会话），这条兜底只是第二道保险。
  if (text.length <= 30
    && /^(我|这次|这回)?[，,]?(这次|这回|就|先|暂时|还是)?[，,]?(不|不用|无需|没必要|懒得)(打算|准备|需要|想|考虑)?[，,]?(回复|回应|接话|发言|理会)/.test(text)) return '';
  return text;
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 触发批指纹：批内消息的 localId 序列 + 未读总数。
 *
 * 用来回答"还是当初那一批吗"——批次没变就沿用同一个判定（含骰子），
 * 变了才重新判定。未读总数也参与，才能覆盖"积压超过 peek 上限、
 * 批内前 200 条恰好相同"的情况。
 */
function unreadFingerprint(entries, total) {
  return `${entries.map((m) => m?.id ?? '').join(',')}|${Number(total) || 0}`;
}

/**
 * 内存等待态的展示用 id。
 *
 * 前缀与真正的会话 id（时间戳 base36 + 随机 hex）区分开：它**不是**一个
 * 会话实体，不在 data/sessions 里，也没有磁盘文件 —— /api/sessions/:id
 * 靠 getPendingSession() 应答，别拿它去 sessions.get()。
 */
function pendingSessionId(p) {
  const stamp = Number(p?.createdAt || Date.now()).toString(36);
  return `pending-${stamp}-${p?.seq ?? '0'}`;
}

/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
