// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖
import { writeTextAtomic } from './util.js';       // 同样零依赖（只有 node:fs / node:path）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是开发环境的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    // ── Prompt 缓存开关（省 token 大头）──
    // 'auto'（默认）：识别到 OpenAI/Anthropic/DeepSeek/Qwen/Moonshot/Zhipu 等
    //   已知支持 cache_control 的端点时，主动给 system 消息和工具定义打 cache 标记。
    //   命中后输入 token 按缓存价（通常 1/10 ~ 1/4）计费，大段稳定提示词特别划算。
    // 'on'：强制打标（不识别厂商也打；端点不认时由 llm.js 的 400 兜底自动去掉重试）。
    // 'off'：完全不打标（适合怀疑缓存标记引起问题、或端点真不认的排查场景）。
    promptCache: 'auto',
    // ── 输出长度控制（也是省 token 的关键）──
    // 0 = 不限制。'low' = 低档位时收紧到 200 token；'mid' = 档位 2-3 收紧到 400；
    // 'high' = 所有非 4 档都收紧。保守策略：舍不得让模型多写字才设到 'high'。
    // 注意：私聊永远不限（用户主动来问，不该被压字数）。
    outputBudget: 'mid',
    timeoutMs: 180000,
    // ── 思考模式（省 token 的关键开关）──
    // 推理模型默认会吐一大段 reasoning_content，按输出价计费。群里闲聊回一句话
    // 根本用不上长思考，所以默认压到 'low'（低强度），想更省就设 'off'。
    //   'off'  关掉思考：最省（推荐给纯闲聊/便宜的推理模型，如 deepseek 系）
    //   'low'  低强度：折中（默认）
    //   'auto' 不管，跟随模型默认（贵，但复杂推理更好）
    thinking: 'low',
    // 显式指定用哪套思考参数名（多数情况不用填，自动全发）：
    //   'openai' | 'deepseek' | 'thinking-type' | 'anthropic'
    thinkingProvider: '',
    // 该端点对未知字段严格易报 400 时置位 true：彻底不发任何思考参数（最保险）
    thinkingUnsupported: false,
    // 记忆整理/蒸馏这类后台调用的思考档位（默认关掉，最省）
    thinkingBackground: 'off',
    // ── 分场景思考：闲聊关掉、正事才思考（延迟的最大头）──
    //
    // 实测（2026-09-14，glm-4.6，同一份 ~16k token 的真实提示词，各 3 次）：
    //     thinking='low'  单次回复 19.2s / 19.0s / 84.7s   输出 349~1622 token
    //     thinking='off'  单次回复  2.3s /  2.6s /  4.0s   输出  15~24  token
    //   两者都能正确调用 send_message 把话发出去，质量看不出差别。
    //
    // 为什么差距这么大：推理模型先吐几百到上千 token 的 reasoning_content，而这些
    // token 是**逐个顺序生成**的。实测输出 token 与耗时相关 r=0.48（最强），而
    // 输入长度几乎无关 —— 给提示词灌水 +7500 token 只多花 0.8 秒（约 0.1s/千 token，
    // 落在噪声里；缓存命中后输入更便宜）。所以**延迟 ≈ 输出长度**，而输出的大头
    // 就是思考。
    //
    // 结论：把思考从"每次都开"改成"只有真需要时才开"。
    //   thinkingCasual：群聊里**没被 @、没被直接提问**的唤醒用这个档位。
    //     默认 'off'（最快）。觉得闲聊也需要思考时可设 'low'/'auto'。
    //   thinkingSplit：总开关。关掉 = 所有场景都用上面的 thinking（旧行为）。
    //
    // 保留思考的场景（用 thinking 档位）：私聊、群聊里被 @、定时提醒唤醒。
    // 定时提醒算"正事"（要说清楚时间/事情），所以也保留思考。
    thinkingCasual: 'off',
    thinkingSplit: true,
    // ── 发言后直接收尾（省掉一整轮 API 往返）──
    //
    // 翻会话存档发现：1356 次多轮运行里有 943 次（69%）的后续轮次**只调用 finish**，
    // 也就是"发完话 → 再被叫起来一次 → 说一句'我完成了'"。那一轮完整 API 往返
    // （约 17k token 输入）实测要 2.2~3.7 秒，纯粹是白花。
    //
    // 打开后：某一轮里只要调用了发送类工具（send_message / send_sticker /
    // send_image / send_poke），并且**同一轮里没有调用任何查询类工具**
    // （get_recent_messages / web_search / get_message_images / memory_* 等），
    // 就直接结束，不再多跑一轮去等 finish。
    //
    // 为什么这个判据是安全的：如果模型还需要查东西，它必然在同一轮或下一轮调用
    // 查询工具 —— 那就不满足"无查询工具"，照旧继续跑。只有"只发了个东西、
    // 不打算再查"的情况才提前收尾，而这正是那些纯 finish 轮。
    // 代价：约 30% 的运行里模型本来会跨轮补发第二条或表情，现在会被要求在同一轮
    // 发完（提示词的【一趟发完】段配合引导）。可在设置里关掉恢复旧行为。
    endAfterSend: true,
    // ── 文本兜底（专治"只思考不回复"）──
    // 本项目的约定是"普通文本不会发到 QQ，要发言必须调 send_message"。
    // 但轻量模型（实测 glm-4.5-air）经常无视工具协议：把回复直接写进 content
    // 却不返回 tool_calls，于是那段话被静默丢弃 —— 用户看到的就是"机器人
    // 只思考、不说话"。打开这个开关后：本轮没有任何 tool_calls、本次运行还
    // 没发过话、且确实输出了实义文本时，把那段文本当作回复直接发出。
    // 判据是安全的：提示词给了"不想说话"的出口（直接结束或调 finish），
    // 所以"零工具调用 + 有文本"只会是"想说但没走协议"。
    textFallback: true
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  providersImported: true,
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // ── 搜图（找图并发到群里）──
  // 统一走 src/image-search.js：默认 pixiv（公开接口，未登录可用），
  // 也用 safebooru / konachan / yande.re 这些免登录图库；还能自己加接口。
  // 所有图片都会先过 safe-fetch（禁内网）再交给 OneBot。
  imageSearch: {
    enabled: true,
    provider: 'pixiv',            // pixiv | safebooru | konachan | yandere | custom:<id>
    providers: [],                // 自定义图源：{ id, name, type:'custom', baseUrl, apiKey, cookie, timeoutMs }
    cookie: '',                   // pixiv 登录 Cookie（可选）：填了能搜到更多、能取原图
    hideAi: true,                 // ★ 屏蔽 AI 生成图（pixiv 按官方 aiType，图库按标签）
    aiBlockTags: [],              // 额外的 AI 屏蔽标签（追加在内置表之后）
    allowR18: false,              // 默认不允许 R18（开之前先想清楚）
    defaultLimit: 3,              // 一次搜几张（1~10）
    maxDownloadMb: 8,             // 单张图下载上限（MB）——太大发不出去还占内存
    sendMode: 'auto',             // auto = 先试直链、失败改内嵌；url 只发直链；base64 一律内嵌
    timeoutMs: 15000,
    // ── 画质 / 人气（决定"推给群友的图好不好看"）──
    // 注意：pixiv 的搜索接口**不返回收藏数**，order=popular_d 未登录也不生效。
    // 所以"按人气排"要逐个作品补查一次详情：每个候选一次请求，rankPool 控制查多少个
    // （20 个约 1 秒，60 个约 3 秒）。不想要这个延迟可以关掉 sortBy / 把 rankPool 调小。
    sortBy: 'popular',            // popular = 按收藏数排序；newest = 按发布时间（不打额外请求）
    minBookmarks: 0,              // 收藏数门槛，0 = 不过滤。填 100 能挡掉大部分没人气的新图
    // 给多少个候选补查人气。**别调太大**：每个候选一次 pixiv 请求，
    // 实测调到 60 会让 pixiv 返回整片 HTTP 429（连搜图一起挂）。24 约 1 秒且安全。
    rankPool: 24,
    preferOriginal: true,         // 发原图（pixiv 原图常 1~5MB，比 540px 缩略图清晰得多）
    maxImageMb: 12,               // 原图超过这个体积就退回大图（防 20MB 巨图）
    minPixels: 0,                 // 最短边下限（0 = 不限）；填 800 可挡掉小图
    // 按会话覆盖：{ "group:123": { hideAi:false, provider:'safebooru', enabled:true } }
    perChat: {}
  },
  // ── 梗知识库（网梗/游戏梗/群内黑话）──
  // 与长期记忆分开：这里是**管理员手工维护**的稳定知识，带"适用场景 + 范例句"，
  // 数据在 data/memory/_global/memes/memes.json（可手改、可用 memes.md 导入）。
  meme: {
    enabled: true,
    injectEnabled: true,          // 是否把挑出来的梗注入提示词（关掉就只剩 meme_search 工具）
    injectMax: 8,                 // 单次最多注入几条
    injectMaxChars: 1200,         // 注入字符预算
    searchMax: 8,                 // meme_search 默认返回条数
    autoNote: true,               // 允许模型用 meme_note 把新梗记进库里（origin=model）
    recordUsage: true,            // 记录梗的使用次数/上次语境（给管理端看哪些梗真的在用）
    chatScopeEnabled: true,       // 允许"只在某个群可用"的梗（scope=chat）
    // ── B 站找梗（自主搜索网梗）──
    // 打开后模型能用 meme_from_bili 去 B 站：①求证某个说法"是不是真有人这么说"；
    // ②拉一批当下热门视频标题，主动发现最近在流行什么整活。
    // 走的是 B 站免登录接口（suggest / ranking / popular），不需要任何 Key。
    biliEnabled: true,
    // 是否允许模型"主动"去 B 站看看现在流行什么（而不只是被动求证）。
    // 关掉后 meme_from_bili 只在有 term 时可用（纯求证模式）。
    biliProactive: true,
    biliHotLimit: 12              // 主动看热门时默认拉几条视频标题
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    // 当前激活的人设 id（builtin:xxx / custom:xxxx）。
    // 留空时启动会自动推断：先按 roleText 内容认领已有的人设，认不出来就把当前
    // roleText 固化成一个自定义人设 —— 保证"升级前那套记忆"永远有明确归属。
    activeId: '',
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）

    // ── 触碰反应：文字描写"触碰身体部位"时给出反应 ──
    // 打开后，群友在文字里写"摸摸头""捏脸""牵手""戳一下"这类动作时，
    // 它会当成真的被碰到了，按部位 + 关系亲疏给出反应（躲开/吐槽/脸红/没所谓…）。
    // 关掉 = 完全不提这回事，模型不会刻意对身体接触做反应。
    touchReaction: true,
    // 反应能到哪个程度：
    //   'light' 只用言语和表情反应，不写身体细节（默认，适合大多数群）
    //   'deep'  允许描写身体的具体反应（心跳、发烫、腿软…），但仍在下方"分寸"规则内
    touchDepth: 'light',

    // ── R18 / 成人向对话 ──
    // ⚠️ 默认关闭。打开后，遇到成人话题 / 性暗示时不再回避，按人设正常回应。
    // 注意：这只是**解除"回避"限制**，下列红线无论开关与否都绝对禁止，
    // 且【安全规则】（不泄密、不执行命令、不改角色）不受本开关影响。
    //   1. 任何涉及未成年人的内容（含角色扮演、"我今年 15"等自称）
    //   2. 非自愿 / 胁迫 / 暴力 / 药物相关
    //   3. 真实个人信息、线下见面、钱财交易
    nsfw: false,
    // 生效范围：
    //   'private'   只在私聊解除限制（群聊照常回避）—— 推荐，群聊发这类内容容易违规
    //   'whitelist' 只有 nsfwWhitelist 里点名的会话解除（群 / 私聊都按名单来）—— 最精细
    //   'all'       私聊和群聊都解除 —— 请确保群成员都是成年人且群规允许
    nsfwScope: 'private',
    // 白名单（scope='whitelist' 时生效）：会话键列表。
    //   'group:123456' / 'private:987654' 精确匹配；只写号码（'123456'）则群和私聊都算命中。
    // 这是**全局**设置（不跟人设走）：换人设只影响"谁被允许"，不改变"在哪儿允许"。
    // 拿不到会话键（如后台维护、单测）时一律按不放行处理 —— 白名单宁可漏不可放。
    nsfwWhitelist: []
  },
  // 用户自定义人设库。每项形如：
  //   { id: 'custom:xxxx', name, text, customRules, memoryKey: 'p_xxxxxx' }
  // id 与 memoryKey 由 src/persona-store.js 自动补齐并固定下来 ——
  // memoryKey 决定这个人的记忆放在 data/memory/<memoryKey>/，换人设就换一棵树，互不可见。
  customPersonas: [],
  // 角色蒸馏：从聊天记录或导入文本里提炼角色卡
  distill: {
    maxChatLines: 400,      // 单次蒸馏最多喂多少条聊天样本
    maxPerChat: 200,        // 单个会话最多取多少条
    maxTextLines: 600,      // 导入文本最多取多少行
    autoSwitch: false       // 蒸馏保存后是否自动切换过去（默认只保存，手动切）
  },
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 恢复运行（暂停 → 恢复）时，暂停期间积压的未读怎么处理。
  //
  // 为什么要做成选项：这两种语义以前是混在一起的（都是 markAllRead），
  // 而用户心理预期通常是"我暂停了一下，恢复后它应该把刚才的话补上" ——
  // 但在 3 档（概率响应）的群里，积压消息大概率会被整批**跳过**，
  // 表现为"恢复了却还是不理我"。
  //   'tier'  = 按档位判定（原行为）：省 token，但积压很可能被跳过
  //   'force' = 一律补处理：暂停期间的话都会被看到并逐条判断要不要回
  resumeBacklogMode: 'tier',
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000       // QQ 硬限制切分（0 = 不限制）
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1,
    // 提示词里注入的表情目录按当前话题相关度挑（false = 退回"按使用次数排"的老行为）
    contextAwarePick: true,
    // 允许模型给表情写备注（sticker_note）。关掉后只能人工在控制台备注。
    autoNote: true
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 上下文读取档位（决定本次唤醒读多少条历史）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定读取条数。这个设置替代了原来的 pastStateLimit 固定值。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全读
    atCount: 20,                // 档1：机器人被艾特时读 w 条
    keywordCount: 15,           // 档2：命中关键词时读 x 条
    keywords: [],               // 档2 的关键词表
    randomPercent: 10,          // 档3：y% 概率
    randomCount: 8,             // 档3：命中时读 z 条
    allCount: 80,               // 档4：读全部（上限）
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局滑条
    keepSessionFiles: 0         // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // ── 发言人身份 ──
  // 成员备注名：{ [QQ号]: "称呼" }。写进这里后，提示词里该成员一律用这个称呼。
  memberNotes: {},
  // 昵称历史：{ [QQ号]: [{ name, at }, ...] }（最近若干条，自动维护）。
  // 用来认出"这个人改过名"：提示词会给曾用名，避免模型把改名后的人当成新群友。
  memberAliases: {},
  // 群禁言（被踢出/禁言/不想理 的群）：{ [群号]: { at, reason, until } }
  // 命中的群**完全不触发 AI 运行**——消息照存档，但不烧 token；解禁前一个字都不发给模型。
  mutedGroups: {},
  // ── 群管理员指令（群内说「禁言 / 解除」）──
  // 管理员在群里直接发"禁言"→ 机器人立刻闭嘴（等价于对本群禁言，绝不调用算力），
  // 但**被 @ 时会回一句固定话术**（不装死）；管理员发"解除"→ 恢复正常发言。
  // 这两条指令本身不会触发 AI 对话（在入口层拦截并标记已读）。
  // admins: { [群号]: 管理员QQ号 }；键 '*' = 全局管理员（对所有群生效）。
  admin: {
    enabled: true,
    admins: {},
    // 禁言期间被 @ 时回的固定话术（留空用内置默认）
    muteReply: ''
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: '',                            // 专用模型 id（useChatModel=false 时生效）

    // ── 跨群聊长期记忆（第三层记忆：data/memory/_global/）──
    // 总开关。关掉后跨群档案与长期事件都不再读写，本地群友印象照常工作。
    globalEnabled: true,
    // 允许把 A 群学到的东西注入到 B 群（跨群记忆的核心开关）。
    crossGroupEnabled: true,
    // 私聊里知道的事是否允许出现在群里。
    // 默认 true：把私聊交代的事带到群里复述是主要用法。
    // （依然可以用 crossGroupExclude 单独屏蔽某些会话，或在 UI 里关掉。）
    crossGroupPrivateToGroup: true,
    // 这些会话的记忆不外泄也不吸收：["group:123", "private:456"]
    crossGroupExclude: [],

    // ── 表层记忆（最新一层：刚说过的话，限时跨群可见）──
    // 一句话刚说完就暂存在 _global/surface.json，任何会话都能立刻查到，
    // 所以"私聊问完，另一个群马上能复述"成立；超时自动清除，可手动/自动沉淀成长期记忆。
    surfaceEnabled: true,
    surfaceTtlMs: 600000,             // 保留时长：默认 10 分钟
    surfaceMaxPerPerson: 50,          // 每人最多暂存几条
    surfaceMaxInject: 6,              // 每次注入提示词几条
    surfacePrivateToGroup: true,      // 私聊刚说的话是否允许立刻出现在群里（默认开）

    // 长期事件/话题（约定、梗、恩怨、长期话题、稳定偏好）
    eventsEnabled: true,
    eventsAutoExtract: true,          // 整理记忆时顺带用模型抽取长期事件（模型自己很少主动记）
    eventsAutoExtractMax: 3,          // 单次最多抽几件
    eventsMaxInject: 6,               // 每次注入提示词的长期事件上限

    // 注入预算（跨群档案 + 长期事件合计字符数，防止提示词膨胀）
    peopleMaxInject: 6,               // 注入几个人
    factsPerPersonInject: 3,          // 每人注入几条事实
    crossGroupMaxChars: 1400,

    // ── 遗忘曲线 ──
    // 不靠定时扣分，而是读取时按半衰期实时折算；维护只负责淘汰已淡出阈值的条目。
    decayHalfLifeDays: 30,            // 基准半衰期（天）；importance 越高乘数越大（1→1x, 3→2.5x, 5→4x）
    decayMinWeight: 0.08,             // 有效权重低于此值且超过龄期 → 淘汰
    decayMinAgeDays: 7,               // 至少活过这么多天才允许被淘汰（防抖动）
    keepImportance: 4,                // importance ≥ 此值永不淘汰（约定/雷点/恩怨）
    decayIntervalMs: 1800000,         // 后台维护间隔（30 分钟）
    maxFactsPerPerson: 12,            // 每人最多保留几条事实
    maxEventsPerChat: 150,            // 每个会话最多保留几条长期事件
    maxEventsTotal: 400               // 长期事件总量上限
  },
  // ── 定时提醒（长期记忆库的一部分）──
  // 机器人可以用 remind_at 工具定一个时间点，到点后由编排器主动唤醒它，
  // 让它用自己的语气来找你（"该喝水了"），而不是干巴巴地播报。
  // 数据落在 data/memory/<人设>/_global/reminders.json —— 跟人设走，可手改可备份。
  reminder: {
    enabled: true,             // 总开关：关掉后不再到点提醒（已有提醒原样保留）
    checkIntervalMs: 20000,    // 调度器轮询间隔（纯本地，不烧 token）
    minDelaySec: 30,           // 最短提前量（秒）：比这更近的时间点直接拒，防手滑定到"已经过去"
    catchUpMinutes: 720,       // 应用重启后，迟到不超过这么久仍然补发（12 小时）
    missedNoteInPrompt: true,  // 迟到太久的提醒：不单独开一次对话，改为下次聊天时自然提一句
    fallbackRawText: true,     // 唤醒模型失败时，直接把提醒原文发出去（承诺不能丢）
    injectUpcoming: true,      // 把"这个会话还没到点的提醒"注入提示词，让它心里有数
    injectMax: 3,              // 最多注入几条
    maxPending: 200,           // 待触发提醒总量上限（防无限堆积）
    maxPendingPerChat: 20,     // 单个会话待触发上限
    maxPerDay: 20,             // 单日最多新建几条（防模型抽风刷屏）
    allowPrivateTarget: true,  // 允许"到点私聊某个人"（目标必须在本会话近期发过言）
    ttlDays: 400,              // 已完成/已取消记录保留天数（清理用）
    delivery: 'natural'        // natural = 让它用自己的话提醒；verbatim = 直接复读提醒原文
  },
  // ── 真人说话风格学习（默认开启）──
  // 本地采集真人语料与"图片/表情 → 真人反应"样本，后台用模型蒸馏成风格库，
  // 再注入提示词，让它的说话逻辑更像这个群里的真人。
  //
  // **成本说明**：
  //   - 采集：纯本地读 messages/*.json，不烧 token、不发请求。
  //   - 蒸馏：默认每攒 80 条新样本触发一次，冷却 6 小时；
  //     一次蒸馏喂 ≤240 条样本；管理员可在 UI 里关掉 autoDistill 只在手动点时花。
  //   - 注入：每会话最多 injectMaxItems 条 + injectMaxChars 字，预算受控。
  //
  // 关掉 = 完全休眠：不采集、不蒸馏、不注入，一个字节都不写。
  styleLearn: {
    enabled: true,             // ★ 默认开启（Phase 3）—— 采集免费，自动蒸馏才偶尔烧 token
    learnSpeech: true,         // 学说话逻辑（句式/语气词/长短/标点/口头禅）
    learnImageReaction: true,  // 学"看见图片"的反应
    learnSticker: true,        // 学"看见表情包"的反应
    learnEmoji: true,          // 学"看见 QQ 表情/emoji"的反应
    collectEnabled: true,      // 开关打开时是否采集新样本
    autoDistill: true,         // 后台自动蒸馏（要花 token，可关掉只手动点）
    distillMinSamples: 80,     // 攒够多少条新样本才值得蒸一次
    distillIntervalMs: 21600000, // 蒸馏冷却（默认 6 小时）
    maxSamples: 3000,          // 样本池上限（滚动丢弃最旧的）
    maxSpeechItems: 18,        // 风格库最多保留多少条说话逻辑
    maxReactionItems: 18,      // 风格库最多保留多少条图片/表情反应
    reactionWindowSec: 180,    // 图片发出后多久内的真人发言才算"反应"
    minTextLen: 2,             // 太短的发言不作为说话样本（"？"这种）——0 = 不过滤
    injectMaxItems: 8,         // 每次注入提示词多少条（说话逻辑 + 图片反应合计）
    injectMaxChars: 900,       // 注入字符预算
    // 给"被回应的图片"生成一句内容描述（视觉模型另一次调用，要钱）。
    // 打开后学到的是"看到猫图→可爱"，关掉只能学到"看到图→哈哈"。
    captionImages: false,
    captionMaxPerDay: 30,      // 描述图片的每日上限
    chatExclude: []            // 不学习的会话：["group:123"]
  },
  // 桌面端/控制台
  server: {
    port: 3210,
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true,        // 点关闭 = 最小化到托盘（关掉 = 直接退出）
    // 点关闭时先弹一次选择框（最小化到托盘 / 彻底退出）。
    //
    // 为什么默认 true：窗口是**无边框标题栏的原生窗口**，"点 X"的预期完全靠
    // 用户猜。原来只有 closeToTray 一个开关、默认缩到托盘且**不给任何反馈**，
    // 于是"点了 X 关不掉"成了最常见的反馈（用户以为程序卡了）。现在改成
    // 弹一次、并把选择记下来（勾"记住"后写回 closeAsk=false），
    // 之后行为完全由 closeToTray 决定，不再打扰。
    closeAsk: true
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效；新安装默认白色主题。
    theme: 'light',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000          // 界面轮询间隔
  },
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

let currentConfig = null;
let saveTimers = new Map();

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  currentConfig = deepMerge(getConfig(), patch);

  // ── 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率 ──
  // 前端只负责上报滑条位置（contextSliderPos），档位和概率一律由这里换算。
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  const posRaw = currentConfig?.store?.contextSliderPos;
  if (posRaw !== undefined && posRaw !== null) {
    const { tier, randomPercent } = sliderToTier(posRaw);
    currentConfig.store.contextTier = tier;
    currentConfig.store.randomPercent = randomPercent;
  }

  writeTextAtomic(CONFIG_FILE, JSON.stringify(currentConfig, null, 2));
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  if (store.unifiedTier !== false) return store;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return store;
  const pos = store.groupSliderPos?.[id];
  if (pos === undefined || pos === null) return store;
  const { tier, randomPercent } = sliderToTier(Number(pos));
  return { ...store, contextTier: tier, randomPercent };
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      writeTextAtomic(CONFIG_FILE, JSON.stringify(getConfig(), null, 2));
    } catch (error) {
      console.error('[config] 保存失败:', error?.message ?? error);
    }
  }, 400));
}
