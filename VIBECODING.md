# ChatBox：AI 开发交接与项目全量上下文

> 最近更新：2026-10-11（Asia/Shanghai）
>
> 当前阶段：R003，QQ-Agent v0.5alpha 已原样复制到 `QQ-Agent/`，等待具体二次开发要求。
>
> 本文件可独立交接；实际开发前仍须读取当前仓库根目录三文档及相关源码。

## 1. 接手后首先要知道的事实

仓库是 `https://github.com/wraaaaaa/ChatBox.git`，本机目录 `D:\开发\WeChat aibox`，当前 `main` 跟踪 `origin/main`。基础提交 `cb535c1` 只有根 `LICENSE`；R001 建立三文档，R002 记录项目规则窗口，R003 按用户要求导入 QQ-Agent 供后续改造。尚未新增微信接入或其他改造功能。

原始项目位于 `D:\临时工程\qq bot\QQ-Agent-爆改版-0.3.0-免安装版`。本轮完整复制到根目录的 `QQ-Agent/`，没有编辑任何源文件或副本原始文件。准确盘点为 385 个文件、62 个子目录、425,663,251 字节；逐文件 SHA-256 与目录核对通过，复制前后源内容未变。核对清单留在本机 `.git/qq-agent-import/`，不推送其中的本机数据路径。

目录名含 0.3.0，实际 `QQ-Agent/package.json` 为 `qq-agent@0.5.0-alpha`，显示版本 `v0.5alpha`。继承的是 QQ 群聊/私聊 AI 机器人及控制台：Node >=20、JavaScript ESM、Electron、原生 HTML/CSS/JS、手写 HTTP/SSE、OneBot v11、模型与工具编排。没有 React/Vue、Express、ORM，也没有根包 scripts、锁文件或打包配置。

本地完整副本包括原有依赖、真实配置、聊天数据和 SnowLuma 运行时；Git 仅提交业务源码、素材、现有测试、启动入口及源文档。`data/`、`node_modules/`、`snowluma/` 整包被根 `.gitignore` 排除，未删掉本地文件。远端源码克隆不能直接得到当前完整便携运行环境；恢复运行时方法及其未验证边界见根 README。

根 `LICENSE` 保持 GNU GPL v3 原文，`QQ-Agent/LICENSE` 保持源项目 MIT 原文及 Kondius 署名，SnowLuma 保留自带独立 EULA/隐私条款。不得用根许可证覆盖源许可证或把第三方包视作本项目自有代码。

用户追加要求清理的两份旧安装包已移出项目至 `D:\开发\垃圾\ChatBox-旧安装包-20261011`；根 `fatfish.md` 是无关的既有人设提示词，未修改、未提交。它不是现有运行入口自动加载的配置。

本轮在系统 Node v24.14.1 下完成 44 个业务 JS 语法检查和 28 项现有隔离回归测试，全部通过。未启动真实副本、未连接真实 QQ、未调用外部模型，也未验证干净克隆后的完整安装和运行。导入、静态检查、模拟测试、真实运行是不同证据，不能合并宣称部署成功。

## 2. 必须遵守的长期规则

本项目以根目录 `AGENTS.md` 为项目规则权威入口。本文完整复制主要规则，是为了单独发送给其他 AI 时仍能恢复约束。接手者应读取仓库中的最新版 `AGENTS.md`；若规则副本不一致，先核对用户最新明确指令和当前文件，再把三份文档同步修正。不得静默忽略冲突。用户在当前会话的明确要求和工具的上级安全约束仍应遵守。

### 项目全局规则窗口及执行环境

2026-10-10 起，原主开发对话改为 **ChatBox 项目全局规则与说明**，对话 ID 为 `01a1014c-a0af-7fa1-a491-4eda1ced4637`。其职责是集中接收用户新增、修改和撤销的项目全局规则与说明，整理适用范围和生效日期，写入 `AGENTS.md` 并同步 README 与本文件，保留轮次记录，正常提交、推送并核对远端。“全局”仅指本项目的所有开发对话和接手者。

具体开发可以在其他对话开展，每轮继续执行原有文档和 Git 闭环。用户引用该规则窗口时，接手者先读取仓库最新版三份文档，需要核对原意时再查用户引用的对话；无法访问原对话时，用最新版规则文件恢复已记录的上下文。引用窗口便于查找来源，不代替核对实际仓库。

后续规则变更必须修正受影响的旧内容并记录生效日期；临时讨论、建议和单次任务要求不自动升级为长期规矩。其他开发对话仍需维护各自实际交付的进度，不把进度只留在聊天中。

用户于 2026-10-09 明确指定 Windows 命令执行默认使用 PowerShell 7（`pwsh.exe`）；只有确实依赖 Windows PowerShell 5.1 兼容特性时才使用 5.1，并解释例外。支持指定 shell 的执行工具应显式选择 `pwsh.exe`。

### 规则一：每轮开发自动提交并推送 Git

用户明确要求：**“你的每次开发都要自动进行 git push。”** 用户已经授权正常的开发提交和推送，不要在每轮结束时重复索要许可。

每轮实现、修复或文档开发都要检查变更、执行适用验证、同步三份文档，然后对本轮明确涉及的文件执行 `git add`、`git commit` 和 `git push`。仓库当前分支为 `main`，推送目标为 `origin` 的对应分支；接手时先核对当前分支和上游，不能盲目切换或覆盖。

不要使用 `git add .` 把不相关文件、用户未提交的修改、运行数据或密钥一起提交。禁止为了完成推送而强推、重写共享历史、删除用户修改或执行破坏性重置。远程领先、权限不足、网络错误、验证失败或冲突时，先进行能安全完成的排查和修复；不能安全完成则如实报告原因、已完成步骤和剩余事项，不能把“尝试推送”写成“推送成功”。没有任何变化的检查不需要制造空提交。

### 规则二：持续维护适合人类的完整中文 README

用户要求创建中文 `README.md`，同时服务不懂编程的新手和希望二次开发的程序员。每个实际实现的功能都要写明：

- 功能用途、适用场景、前置条件和限制。
- 从准备环境到启动、部署、使用的逐步教程，提供可复制命令、实际示例、预期结果和常见问题。
- 功能的实现原理、关键代码位置、输入输出、配置项和异常处理。
- 修改不同功能或配置会产生什么效果，哪些模块也会受影响，以及修改后的验证方法。

没有实现的功能必须标注“未实现”；没有验证的操作必须标注“未验证”。禁止用计划冒充可用功能，禁止编造安装命令、配置参数、演示结果或部署成功记录。

### 规则三：持续维护可独立交接的详细 AI 文档

用户要求这份 Markdown 能在切换模型、切换 harness 或由其他人进行 vibe coding 改造时，帮助接手 AI 充分理解项目当前状态并继续开发。

本文件必须持续解释架构、程序入口、模块职责、调用链、数据契约、跨文件依赖、配置和状态存储、修改影响、验证结果、已知问题和下一步工作。重要关系必须写出实际文件路径与符号，不能只罗列文件名。涉及关联修改时，列出需要一起检查的生产者、消费者和验证点。

不能保证任何改动都零缺陷；应通过当前源码核对、必要的适用测试、明确的影响分析和如实记录验证边界来降低连锁故障风险。

### 规则四：每轮同步维护三份 Markdown

用户要求：**“以上的三份 markdown 你都需要根据项目每轮开发进行详细跟进。”** 三份文档分别是 `AGENTS.md`、`README.md`、`VIBECODING.md`。

每轮都要检查三份文档是否需要更新，并同步本轮进度、功能状态、使用方法、代码关系、影响和验证结论。即使某个文档的规则正文不变，也要维护其中的本轮记录，使三份文件对应同一轮项目事实。先更新文档，再与本轮代码一起提交和推送。重要规则不能只停留在聊天记录或依赖模型记忆。

## 3. 目录、原始资料与版本管理边界

```text
ChatBox/
├── AGENTS.md                    项目规则、进度与恢复入口
├── README.md                    当前中文教程和人类开发说明
├── VIBECODING.md                本交接文档
├── LICENSE                      原仓库 GPL v3 正文
├── .gitignore                   本地数据与运行时提交边界
├── .gitattributes               QQ-Agent 原始字节/换行保留
└── QQ-Agent/
    ├── AGENTS.md / agent.md     原包指令入口与源码导航
    ├── README.md / 使用说明.md / 快速开始.txt
    ├── LICENSE / package.json / 启动QQ机器人.bat
    ├── electron/main.js         桌面与生命周期
    ├── src/                    42 个业务模块
    ├── ui/                     页面、脚本、样式和背景视频
    ├── assets/                 图标
    ├── tests/                  3 个回归文件和 2 个隔离预览入口
    ├── data/                   仅本地：真实配置与业务记录
    ├── node_modules/           仅本地：原包依赖及 Electron
    └── snowluma/               仅本地：第三方桥接程序、Node、配置、数据库、日志
```

根三文档描述本仓库现状。`QQ-Agent/AGENTS.md` 指向既有 `agent.md`；保留它们是原样复制要求，不是在根目录新增第二套规则。源文档中的“无 .git”、旧路径、旧界面、历史测试数量及历史模型目录仅作为源包上下文，接手时仍核对当前源码；不要为更新这轮导入而改动原件。后续真实功能开发依用户要求更新受影响资料。

`.gitattributes` 对 `QQ-Agent/**` 设置 `-text whitespace=cr-at-eol`，防止 Git 自动转换原有换行，并使空白检查接受原有 CRLF 行尾。63 个进入 Git 的原包文件已用 `git hash-object --no-filters` 与索引对象逐一核对，字节差异为零。导入文件数不等于提交文件数，运行时和真实数据在本地保留但不上传。新增需要追踪的源码时检查忽略规则；不要强制 `git add -f` 真实运行目录。`node_modules/electron/dist/electron.exe` 为 188,784,128 字节，超过普通 GitHub 单文件限制。

## 4. 功能清单与真实入口

以下功能均为原包已有源码，R003 没有改变行为；本轮只对现有回归覆盖部分做隔离验证，未逐项真实业务验收。

| 功能 | 用户入口 | 主要实现与关联 |
| --- | --- | --- |
| QQ 群聊/私聊、接入名单与响应调度 | 设置中的接入/行为与 SnowLuma · OneBot | onebot、app、config、orchestrator、store |
| 模型接入、官方预设/自定义目录、视觉能力 | 设置 → 模型 API | model-catalog、providers、llm、openai-responses、vision-scan、ui |
| 运行会话与消息存档 | 会话、存档 | sessions、store、app 的 HTTP/SSE、ui |
| 人设、角色切换、独立记忆与蒸馏 | 设置 → 人设 | personas、persona-store、persona-distill、prompt、memory |
| 群友印象、跨群档案/长期事件/表层记忆 | 记忆及设置 → 记忆子项 | memory、memory-global、memory-llm、orchestrator |
| 定时提醒、重复计划与风格学习 | 设置 → 记忆的提醒/风格子项 | reminders、style-learn、orchestrator、tools、prompt |
| 联网搜索、网页读取、搜图与反向搜图 | 设置中的搜索/搜图 | web-search、safe-fetch、image-search、tools |
| 表情、梗库、B 站候选 | 对应设置与工具调用 | stickers、sticker-manager、meme-store、bili-meme、bili-discover |
| 管理员、禁言与 QQ 身份 | 设置及本地管理员命令 | admin、mute、identity、onebot、app |
| Token 调用用量与缓存命中统计 | 用量 | sessions、model-identity、llm、app；不包含价格/成本估算 |
| 主题、玻璃卡片、背景视频、折叠自定义设置 | 顶栏和设置 | ui/index.html、app.js、style.css、refresh.css |
| 单项/多选/整类记录清理与完整初始化 | 各记录管理页；设置 → 关于 | app 删除路由、factory-reset、electron；确认与忙碌保护 |

当前 UI 顶层为会话、存档、记忆、用量、设置。设置已有 13 个分栏，三个记忆功能记录在各自设置子项内管理；顶层记忆只管理聊天群友印象，不能通过顶层一键清空误删三类功能记录。关于页版本与署名来自 `src/app-info.js`，完整初始化需两次确认，第二次输入“初始化”。

### 4.1 启动与停止顺序

桌面入口在 `QQ-Agent/` 内执行 `启动QQ机器人.bat` 或 `& .\node_modules\electron\dist\electron.exe .`。BAT 使用自身所在目录；`electron/main.js` 解析数据路径，设置 `QQ_AGENT_DATA_DIR`，请求单实例锁，必要时先执行 pending 初始化，动态导入 `src/app.js`，调用 `createApp()`/`start()`，创建 BrowserWindow 和托盘。关闭窗口是否退出取决于 `closeAsk`/`closeToTray`；正常完整退出用托盘退出入口。

无窗口入口是 `& .\snowluma\node.exe .\src\server.js`；它调用相同业务核心并处理 SIGINT，但没有 Electron 单实例锁。不要与桌面实例同时启动来测试。源包 Electron 的 `default_app.asar` 已做无参数不显示欢迎页补丁，并保留 `default_app.asar.before-no-welcome` 原件；重装依赖会覆盖补丁。

`createApp()` 本身就含读盘、恢复和写入副作用；真实 `start()` 还会连接协议端、恢复调度/提醒。因此这两条真实启动入口不能用作无副作用测试，R003 未执行。Electron 单实例和 browser storage 可能与原目录实例共享，目录复制不等于桌面配置完全隔离。

### 4.2 核心调用链

```text
OneBotClient WS 事件
 → app.js：群/私聊分流、自身回显排除、名单和管理员过滤、媒体解析
 → ChatStore.appendIncoming()：mid 去重、存档与未读
 → 身份/风格/表层记忆采样 + chat-update
 → Orchestrator.onIncoming()/scheduleWake()：聚批、触发、并发、消费未读
 → buildSystemPrompt()/buildUserPrompt()：角色、记忆、历史、工具
 → chatCompletionWithRetry() ↔ executeTool()
 → SendQueue → OneBot HTTP action → 发出内容留档
 → sessions/usage/记忆持久化 → SSE 和 UI 轮询更新
```

同一 `chatKey` 最多一个模型运行，跨聊天受 `maxConcurrentRuns` 闸门控制；运行中新消息留在未读。未命中触发的批次标记已读并保留 skip 原因。pendingPlans 是内存等待计划，不是落盘运行会话。`done` 表示发过内容，`noreply` 为正常结束但未发言，error/aborted 不算正常完成。失败恢复、重试和部分发送交织，不能宣称全链路 exactly-once。

“无状态 Agent”只表示每轮重组模型上下文，不代表消息/记忆/提醒/用量无持久状态。`api.textFallback` 有受过滤的纯文本发言兜底，`api.endAfterSend` 可能在发送类工具成功且无查询类工具时提前结束；新增工具同步 `SEND_TOOLS`/`QUERY_TOOLS` 和 prompt 分类。

## 5. 模块、上下游与改动影响

表内路径均相对 `QQ-Agent/`。

| 文件 | 职责和关键关系 | 修改时同时核对 |
| --- | --- | --- |
| electron/main.js、src/server.js | 桌面/无窗口生命周期，调用 createApp/start/stop | 数据目录、重启、退出、单实例、factory-reset |
| src/app.js | 总装、OneBot 入站、SnowLuma 子进程/令牌同步、handleHttp、SSE、用量 | 路由 UI 消费者、存储、忙碌保护、start/stop |
| src/config.js | DEFAULT_CONFIG、getConfig、updateConfig、setRuntimeConfig、档位派生 | 默认值、深合并/删除、API脱敏、当前设置分栏 saveConfig |
| src/onebot.js、src/sender.js | WS事件/HTTP action、消息段/合并转发、SendQueue 串行发送与限频 | app事件、tools目标绑定、store出站留档、重试/部分成功 |
| src/store.js、src/sessions.js | 聊天记录/未读/去重、会话索引/状态/用量与恢复 | app删除/分页、orchestrator失败批回放、模型标识 |
| src/orchestrator.js | 聚批/触发/并发、工具轮次、主动机会、记忆/提醒调度 | store、prompt、llm、tools分类、发送状态和恢复 |
| src/prompt.js、src/tier-slider.js | 系统/用户上下文、无依赖档位换算 | config、orchestrator、工具可见性、token预算和人设记忆 |
| src/llm.js、src/openai-responses.js | 模型请求、超时/重试/400兼容；Responses函数/图片/推理适配 | providers、model-catalog、orchestrator assistant.raw重放、用量 |
| src/providers.js、src/model-catalog.js | 模型目录、connectModel校验、密钥解析/保存、模型列表和测试 | UI接入弹窗、同端点密钥复用、跨端点禁止复用、请求协议 |
| src/prompt-cache.js、src/model-identity.js | 缓存标记与模型展示/历史用量标识 | llm请求体、sessions、usage旧记录回退 |
| src/tools.js | buildToolDefs/executeTool，36个工具及参数/上下文绑定 | prompt、orchestrator工具筛选/分类、UI TOOL_META、sender |
| src/personas.js、src/persona-store.js、src/persona-distill.js | 角色卡、人设管理、memoryKey、记忆迁移与蒸馏 | config切换、memory目录、prompt、UI保存 |
| src/memory.js、src/memory-global.js、src/memory-llm.js | 群友印象、全局档案/事件/表层记忆、后台整理模型 | persona路径、orchestrator、prompt检索、删除/SSE与忙碌保护 |
| src/reminders.js、src/style-learn.js | 提醒时间/重复/领取，风格样本/蒸馏/注入 | orchestrator调度、tools、prompt、设置内记录管理 |
| src/stickers.js、src/sticker-manager.js、src/image-search.js | 表情同步/规范化/评分，搜图过滤/下载/反搜/降级 | tools、sender、图片配置与UI、网络失败/冷却 |
| src/web-search.js、src/safe-fetch.js | 多搜索服务/网页读，URL/DNS/重定向/大小保护 | tools、自定义源配置、认证字段、网络超时 |
| src/meme-store.js、src/bili-meme.js、src/bili-discover.js | 梗库导入/检索/合并，B站资料/候选 | tools、UI、来源与记录生命周期 |
| src/admin.js、src/mute.js、src/identity.js | 管理员命令、禁言、账号身份/曾用名 | app过滤、onebot事件、相关设置保存 |
| src/vision-scan.js、src/model-vision-docs.js | 视觉探测/内置资料、运行时能力 | providers、llm、工具集合与UI图片偏好 |
| src/app-info.js、src/factory-reset.js | 版本署名，prepare挑战/目录边界/pending重启/分阶段清理 | app初始化路由、electron重启/旧进程退出、config默认恢复 |
| src/util.js、src/md-to-plain.js | 原子写、事件/串行链、CQ转义、消息规范化与文本转换 | 所有存储/消息消费者；不要绕过原子写和转义 |
| ui/index.html、ui/app.js、ui/style.css、ui/refresh.css | 页面/全局状态、api/connectSSE/轮询、分栏渲染与保存 | handleHttp事件契约、esc转义、异步目标检查、输入保留 |

后端模块需完整退出重启才加载修改；刷新 WebUI 只重载前端。不要因 README 里的历史入口或模型名推断当前服务必可用。模型目录是复制时源码常量，更新前另行核对实际协议/请求 ID/图片/思考参数，本轮没有验证外部模型支持范围。

## 6. 配置、接口与持久化契约

### 6.1 默认值、配置加载和生效

| 配置 | 源码默认与行为 | 影响 |
| --- | --- | --- |
| QQ_AGENT_DATA_DIR | 在导入 config 模块前决定 DATA_DIR；默认项目 data/；桌面入口解析后设定 | 改动影响全部业务存储，但不能独立隔离 SnowLuma |
| server | 127.0.0.1:3210，端口占用时从基准检查10个；closeAsk/closeToTray/autoStart控制桌面 | 使用start返回实际端口，退出与关窗分开 |
| snowluma.wsUrl/httpUrl | ws://127.0.0.1:3001 / http://127.0.0.1:3000 | WS收事件、HTTP发action；旧使用说明中反向端口不能照抄 |
| snowluma.dir/autoLaunch | 默认根 snowluma/；可配置外部目录与自动启动 | 自定义外部目录、令牌同步、已有协议端需要额外核对 |
| api.baseUrl/apiKey/model | 默认留空 | 仅复制代码无法调用模型，UI保存接入即持久化；连通性测试才发测试请求 |
| api | temperature=0.8、maxRounds=12、timeoutMs=180000、promptCache=auto、thinking=low | 工具轮数/超时/缓存/推理均会改变调用行为；遵守兼容处理 |
| providers及密钥映射 | 当前模型/目录与独立提供商密钥保存 | 允许同端点留空复用，禁止跨端点复用旧密钥；常规配置/列表GET脱敏，专用回读接口见下文 |
| store.contextSliderPos | 保存时派生档位/概率 | tier-slider、prompt和UI范围共同变化 |
| 名单、人设、记忆/提醒/风格、搜索/搜图 | DEFAULT_CONFIG中完整默认 | 新字段同时检查后端消费者、HTTP脱敏/保存、UI分栏/保存及旧配置回退 |

持久化真实配置没有在本轮重新填写或归零。`getConfig()` 懒加载并缓存；`updateConfig()` 递归深合并普通对象、替换数组并原子写盘。删除映射旧键用 `{ __replace__: value }`，空对象不会清空。`setRuntimeConfig()` 只改内存，测试在完整默认配置副本上覆盖。UI只渲染当前分栏，saveConfig不能用缺失DOM覆盖其他栏的参数；未修改密钥时不能用空串覆盖真实值。

### 6.2 HTTP 与事件

路由集中在 `src/app.js::handleHttp()`，UI由 `api()` 发请求、`connectSSE()` 订阅 `/api/events`，另有轮询/分页回退。主要路由族：状态/config、model-catalog/model-connection/providers/models、sessions/chats、memory-global/memory-files、personas/reminders/style、memes/stickers/image-search、usage、snowluma、pause/admins/muted-groups/identity、version/factory-reset。关于页读取 `GET /api/version`；初始化使用 `POST /api/factory-reset/prepare`、`POST /api/factory-reset/confirm` 和 `GET /api/factory-reset/status`。

常规 `GET /api/config` 和 `GET /api/providers` 返回脱敏信息。`GET /api/providers/key`、`GET /api/api-key`、`GET /api/search-key` 是供本机界面专用的明文密钥回读接口，通过 `keyEndpointAllowed()` 校验来源；不能把所有 GET 都描述为脱敏，也不能将这些回读结果写入日志、交接或提交。

`POST /api/model-connection` 调用 providers.connectModel()，校验后一次保存端点/模型/密钥/目录，失败保持现有连接，返回 `{ ok: true, provider: sanitizeProvider(result.provider), model: result.model }`。后端发出包含 `configUpdated` 的 status 事件，UI再回读配置；响应没有 config 属性。默认兼容路径走 Chat Completions；源码识别的官方 GPT-6端点走 Responses，工具调用和图片/加密推理重放通过 openai-responses.js，不能丢弃 assistant.raw。GLM续轮保留 reasoning_content。此处描述当前复制源码处理，不代表已经真实验证这些外部产品。

`POST /api/data/delete` 用 `area=sessions|chats|memory` 与 `ids` 或 `all:true`；消息清理用 chatKey/messageIds。特殊记忆 id 为 `__global__`、`__reminders__`、`__style__`。普通清理不重置人设/白名单/密钥/用量/SnowLuma，保留运行/整理/发送中的忙碌保护。顶层群友印象清空只提交聊天键，不能发送all:true连带删三类设置记录。

完整初始化是独立的二次确认、短期一次性挑战与冷重启流程，通过 factory-reset.js 在新进程清理项目数据与内置桥接配置/数据/日志；先检查旧进程退出和目录边界，移动阶段失败恢复，删除阶段失败明确未完成并留待下次继续。电脑 QQ 客户端自身登录文件不在清理范围。测试只能对自身隔离夹具执行，不对真实 data 发清理请求。

### 6.3 数据标识与路径

- 聊天键为 `group:<id>` / `private:<id>`，文件和部分路径用 `group_<id>` / `private_<id>`；本地消息id与QQ mid不同，mid可为负数。
- `data/messages/*.json` 为 `{ chatKey, nextLocalId, messages }`；入站event.time秒换为毫秒，去重比较最近500条非自身消息，不能声称无限历史去重。
- `data/sessions/*.json` 保存触发、提示词、模型轮次、工具、发送、状态和用量，索引/累计另由sessions维护。
- `data/memory/<memoryKey>/` 为人设记忆，含聊天印象、`_global/`、`_style/`；提醒在`_global/reminders.json`。共享梗库在`data/memory/memes/`并兼容旧路径。
- `data/config.json`、旧配置备份、stickers、用量、日志及媒体缓存也是真实数据；文件写入复用writeTextAtomic()/writeJsonAtomic()，检查内存缓存和旧格式。
- SnowLuma的config/data/logs及SQLite主库/WAL/SHM属于第三方桥接；不与业务JSON混为一层。备份/恢复先正常退出应用与桥接，不把在线文件复制宣称为数据库事务一致性备份。
- `snowluma.dir`、环境变量可能指向源目录或其他真实实例；未来启动前仅核对路径是否相互引用，不在文档/终端输出密钥、账号、聊天原文。

## 7. 验证、升级与恢复

R003复制核对清单在`.git/qq-agent-import/source-manifest.json`与`verification.json`，包含本机路径；不能添加到提交。原根LICENSE与fatfish.md的哈希在preserved-files.json，旧安装包移动后哈希也核对一致。测试后重新核对385个源/副本文件，变化为零。根三文档严格UTF-8、代码块成对、R000–R003与规则窗口ID、本地链接检查通过；暂存范围排除私有目录/用户无关文件，凭据模式扫描无候选，git diff与暂存空白检查通过。该模式扫描不是全面凭据审计。提交后另核验远端SHA。

在 `QQ-Agent/` 下运行现有检查：

```powershell
node --version
node --test tests/community-removal.test.mjs tests/model-connection.test.mjs tests/factory-reset.test.mjs
$checkFiles = @(Get-ChildItem .\src -Filter *.js -File) + @(Get-ChildItem .\electron -Filter *.js -File) + @(Get-Item .\ui\app.js)
foreach ($checkFile in $checkFiles) {
    node --check $checkFile.FullName
    if ($LASTEXITCODE -ne 0) { throw "语法检查失败：$($checkFile.FullName)" }
}
```

本轮实际使用系统Node v24.14.1：28/28测试通过，44/44脚本语法检查通过。三个测试文件分别12/7/9项，使用新临时DATA_DIR、替代SnowLuma目录、fixture密钥与模拟fetch；HTTP测试仅随机loopback监听，不调用真实app.start()。factory-reset跨进程仅清理自身临时目录。包内Node历史有原生集成异常，系统Node优先；不能把历史异常或旧版本测试数当本次失败/结果。

隔离UI预览入口为`node tests/ui-smoke-server.mjs`，输出随机URL；本轮未执行浏览器交互验收。`factory-reset-preview.mjs`供隔离重启预览，同样不可拿真实数据测试。

新克隆须安装Node>=20与依赖，并另行准备符合其条款的SnowLuma包或配置外部OneBot。没有根npm scripts，不能执行猜测的npm start。使用npm install/npx electron .重建普通开发环境的流程见根README，R003未实测，且不能保证与原便携依赖/补丁完全一致。

升级前正常退出，保存完整业务data和桥接config/data，以及当前代码/运行时副本。git pull --ff-only只更新追踪文件，ignored真实数据和运行时不随Git备份；升级存储格式前检查旧数据迁移。恢复失败先退出相关实例，复制经核对的备份至对应目录，保留失败副本供诊断；不强推/重置共享历史，不盲目初始化真实账号数据。

## 8. 轮次、问题与下一步

| 轮次 / 上海日期 | 交付 | 验证与边界 |
| --- | --- | --- |
| R000 / 2026-10-03 | 本地绑定ChatBox仓库，main跟踪origin/main | 初始cb535c1仅LICENSE |
| R001 / 2026-10-03 | 固定四项规则、中文Git教程、独立AI交接 | 三文档UTF-8/代码块/链接/一致性核对；无业务代码 |
| R002 / 2026-10-10 | 规则窗口职责、引用ID及PowerShell7偏好同步 | 三文档检查；99fe14a曾与远端一致；无业务修改 |
| R003 / 2026-10-11 | 原样导入QQ-Agent、划定本地/远端边界、清理指定旧安装包、更新三文档 | 385文件/62目录、425663251字节、SHA-256一致；44语法/28隔离测试通过；真实QQ/模型/克隆环境未验证；提交推送以Git实查为准 |

本轮业务/API/配置/数据格式完全未改，没有新增产品功能或迁移。后续改造目标、微信接入方式及验收条件仍待用户指定；不能因目录名或这份文档清单自行开始某个改造。

已知边界：本地副本继承真实设置；外部SnowLuma路径/同QQ端口/单实例共享需在真实启动前核对。源码克隆缺少便携运行时、数据与原Electron补丁。源包说明存在历史路径、端口和测试数，根文档提供本仓库现状，但任何未来功能改动仍沿实际调用链核实。R003仅记录复制时模型目录，没有重新确认外部供应商当前支持。

下一轮从R004继续：先读取三文档与用户新任务，核对Git，梳理受影响生产者→接口/数据→消费者→验证；在QQ-Agent内开发并同步配置/存储/UI/说明。不要编辑依赖或第三方打包文件来做普通业务功能。

## 9. 接手与每轮交付闭环

1. 确认根目录，读AGENTS/README/本文，核对用户最新明确授权；阅读相关QQ-Agent/agent.md和真实源码。
2. 检查git status --short --branch、remote -v、branch -vv、近期提交；保留已有改动。根fatfish.md目前是用户未跟踪文件，不混入本轮。
3. 明确这轮可验收行为，沿模块表读取修改点及上下游、配置默认、存储、错误与重试。
4. 实现范围内改动，选用现有适用隔离检查；真实QQ和付费模型的验证单独记录，初始化须按用户实际范围。
5. 三文档同步同一R编号/上海日期，记录完成、未验证、问题、影响和下一步；切阶段或压缩前落盘。
6. git diff --check，检查暂存差异与秘密/真实数据边界，明确添加本轮文件，正常commit/push。
7. git rev-parse HEAD与git ls-remote origin refs/heads/main核对；只有推送成功且SHA相符才报告已推送，失败保留本地提交并说明实际原因。

可以把本文件全文和下列指令交给接手模型：

```text
接手ChatBox项目：先读根AGENTS.md/README.md/VIBECODING.md并核对Git和QQ-Agent当前源码。
项目规则窗口为ChatBox 项目全局规则与说明，ID 01a1014c-a0af-7fa1-a491-4eda1ced4637。
Windows默认pwsh.exe；每轮三文档同编号同步，验证后自动正常提交/推送并核对远端，不重复请求已授权推送。
R003原样导入QQ-Agent v0.5alpha；真实数据/依赖/SnowLuma在本地但不在Git。不得以测试为由清空、启动或覆盖真实数据。
未实现微信改造，未验收真实QQ/模型与干净克隆运行；本轮44语法/28隔离测试通过。具体下一步以用户提供的新任务为准。
只能访问文档而不能核对源码时，明确只能分析，不能声称修改或运行成功。
```
