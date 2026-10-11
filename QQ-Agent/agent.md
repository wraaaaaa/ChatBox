# QQ Agent 二次开发指南

> 基线：2026-09-22，本目录的 0.3.0 免安装包。面向后续在此项目工作的开发 Agent。
> 本文描述本地实现，不代表上游仓库或 README 中的历史版本。修改相关功能时应重新核对实现，并同步更新本文。

## 1. 工作约定

- 用中文沟通。先定位实际调用链，再做范围明确的修改；不要在功能开发中顺手重写整个项目。
- 本目录是带运行时与用户数据的应用目录，不是干净源码仓库。当前没有 `.git`、根目录锁文件、`scripts/` 或构建配置。`tests/community-removal.test.mjs` 是本地新增的隔离回归测试，不是完整历史测试套件。
- 保留现有功能及兼容处理。代码里有大量历史故障说明，它们是定位线索；注释与实现不一致时，以实现和可重复验证结果为准。
- `data/`、`snowluma/config/`、`snowluma/data/`、`snowluma/logs/` 按真实运行数据处理。不要为了测试清空、覆盖或迁移它们；不要把密钥、Cookie、聊天原文、登录数据库写入文档或提交。
- 默认只改业务源码和与任务直接相关的文件。不要编辑 `node_modules/`、SnowLuma 打包脚本、原生二进制或第三方客户端产物。
- 普通开发验证用隔离数据和模拟服务。启动真实实例可能恢复积压消息、执行提醒、调用付费模型和向 QQ 发消息，不把它当作无副作用的验证步骤。
- 交付说明必须区分：静态检查、模拟验证、真实模型验证、真实 QQ 验证。没有执行的项目不能写成通过。

## 2. 项目定位与技术栈

这是一个 QQ 群聊/私聊 AI 机器人：OneBot v11 协议端负责连接 QQ，Node.js 后端负责消息存档、触发调度、模型与工具调用，原生网页提供管理控制台，Electron 提供桌面窗口和托盘。

- 根包：`qq-agent@0.5.0-alpha`，界面版本 `v0.5alpha`，JavaScript ESM（`type: module`），要求 Node.js >= 20。
- 直接依赖：`ws`、`undici`、`js-yaml`；开发依赖声明 Electron `^33.4.11`。
- 前端：普通 HTML/CSS/JavaScript，无 React/Vue、无打包步骤；`ui/app.js` 是普通浏览器脚本，不是 ESM 模块。
- 后端：`node:http` 手写路由，没有 Express，也没有 ORM。
- 持久化：业务侧主要是 JSON/文本文件、内存缓存和原子写入；SnowLuma 自身另有 SQLite 数据库，不属于业务存储层。
- 包内 SnowLuma：`1.14.13`；自带 `snowluma/node.exe`，本次确认版本 `v22.13.0`。
- 主项目使用 MIT 许可；SnowLuma 适用自己的 EULA/隐私条款，不能把主项目许可套到它的发布物上。

“无状态”仅指每次 Agent 运行重新组装模型上下文，不跨运行延续同一个完整 messages 数组。聊天记录、记忆、人设、提醒、用量仍然有状态并持久化；单次运行内部仍支持多轮工具调用。不要据此宣称 token 成本严格恒定。

## 3. 启动与生命周期

### 桌面启动

```powershell
# 在项目根目录执行；会启动真实应用
& .\node_modules\electron\dist\electron.exe .
```

`启动QQ机器人.bat` 实际也是直接调用包内 Electron。批处理文件刻意保持 ASCII，修改时保留此约定，避免 Windows cmd 编码问题。

2026-09-27 针对用户反复遇到的 Electron 原生欢迎页做了明确例外处理：包内 `node_modules/electron/dist/resources/default_app.asar` 的无应用参数分支改为立即退出；原件保存在同目录的 `default_app.asar.before-no-welcome`。正常启动传入 `.`，不会进入该分支。重装 Electron 依赖可能覆盖此改动；若需还原，先退出 Electron，再将备份复制回 `default_app.asar`。Windows 当前用户的 `electron.app.Electron` 开机启动项已禁用，`data/config.json` 的 `server.autoStart` 为 `false`；这些属于本机状态，不是包内可移植设置。

启动链：

```text
启动QQ机器人.bat
  → electron/main.js
    → 设置 QQ_AGENT_DATA_DIR、申请单实例锁
    → 若有初始化任务，先等待旧进程退出并清理数据
    → 动态导入 src/app.js，createApp()
    → core.start()，取得实际 HTTP 端口
    → BrowserWindow 加载控制台，初始化托盘/开机启动
```

Electron 关闭行为由 `server.closeAsk`、`server.closeToTray` 控制。未记住偏好时存在关闭确认对话框，不要根据旧使用说明推断“关窗必退出”。窗口关闭与应用退出是不同流程；退出会调用核心清理。

### 无窗口入口

```powershell
# 同样会启动真实后端，不能直接用于无副作用测试
& .\snowluma\node.exe .\src\server.js
```

`src/server.js` 调用相同的 `createApp()` / `start()`，并处理 SIGINT。它不具备 Electron 的单实例锁。

### 地址与运行目录

- 控制台监听 `127.0.0.1`，默认 3210；占用时尝试后续端口，最多检查从基准端口开始的 10 个端口。调用方应使用 `start()` 返回值。
- 源码默认 OneBot WS 是 3001、HTTP 是 3000；`使用说明.md` 中出现相反配置。以实际配置和协议端监听为准，不能按文档硬改端口。
- SnowLuma WebUI 地址从它的 `config/runtime.json` 读取，代码回退端口为 5099。
- `src/config.js` 在模块加载时确定 `DATA_DIR`：`QQ_AGENT_DATA_DIR` 优先，否则根目录 `data/`。测试必须在导入任何业务模块之前设置环境变量。
- 仅修改 `QQ_AGENT_DATA_DIR` **不会隔离 SnowLuma**：其目录默认仍指向根目录 `snowluma/`，令牌同步等逻辑仍可能访问真实协议端配置。模拟测试必须同时隔离/替换这些依赖。
- `createApp()` 本身包含初始化、数据恢复等副作用，不只有 `start()` 才会读写数据。

## 4. 核心消息流程

```text
OneBotClient 收到事件
  → app.js 分流群聊/私聊/拍一拍，排除自身回显
  → 白名单/拒绝名单/群员屏蔽过滤
  → 解析消息段、引用、@、媒体及合并转发
  → 管理员本地指令与禁言逻辑
  → ChatStore.appendIncoming()：按 mid 去重、落盘未读
  → 风格采样、身份记录、表层记忆，发出 chat-update
  → Orchestrator.onIncoming() / scheduleWake()
  → 聚批、触发计划、并发闸门、消费未读，创建运行会话
  → buildSystemPrompt() + buildUserPrompt()
  → chatCompletionWithRetry() ↔ executeTool()
  → SendQueue → OneBot HTTP API → 出站消息留档
  → 会话结束、用量统计、SSE 通知
  → 存在新未读时安排下一次运行
```

关键语义：

1. 同一 `chatKey` 最多一个模型运行；不同聊天受 `maxConcurrentRuns` 限制并行。运行期间的新消息留在未读区。
2. 触发判定发生在消费未读之前。未命中时标记已读并保留 `skip` 原因，不创建真实运行、不调用模型。
3. 防抖等待计划保存在 `pendingPlans`，不是落盘会话。计划复用随机数与批次指纹，避免预判和执行各掷一次骰子。
4. 私聊不受群聊概率档位限制，但仍受接入名单、暂停、模型配置等条件影响。“始终响应”不等于无条件必定发送。
5. `done` 表示发过内容，`noreply` 表示正常结束但未发言；`error`、`aborted` 等不是正常完成。
6. 有请求级重试和运行级重试。运行级最多 3 次尝试，且已经发送内容的运行不在该循环内重试。
7. 另有失败触发批放回未读、后续 drain 和启动恢复机制。因此不能把上一条理解为全链路保证 exactly-once；修改失败恢复时必须验证“部分发送后出错”是否重复回复。
8. 普通模型文本通常用于内部展示，但 `api.textFallback` 开启时存在受过滤的发言兜底。`pickTextFallback()` 会拦截部分括号独白、协议残留等；不能把所有 assistant 文本直接广播到 QQ。
9. `api.endAfterSend` 可在发送成功且本轮无查询工具时提前结束。新增工具要检查 `SEND_TOOLS`、`QUERY_TOOLS` 分类。

## 5. 模块导航

| 文件 | 职责及修改入口 |
| --- | --- |
| `electron/main.js` | 桌面入口、数据目录、单实例、窗口/托盘、退出和自动启动 |
| `src/server.js` | 无窗口启动入口 |
| `src/app.js` | 总装、SnowLuma 子进程/日志/健康检测/令牌同步、入站事件、HTTP 路由、SSE、用量聚合 |
| `src/config.js` | 默认配置、读盘、深合并、保存、按聊天派生档位 |
| `src/app-info.js` | 从 package.json 读取版本、关于页署名 |
| `src/factory-reset.js` | 初始化确认、目录边界、重启任务、分阶段清理及失败恢复 |
| `src/onebot.js` | WS 事件与重连、HTTP action、CQ/消息段和合并转发解析 |
| `src/store.js` | 每聊天消息存档、mid 去重、已读/未读、失败批回放、历史查询 |
| `src/orchestrator.js` | 聚批/触发/并发、模型运行、恢复、主动机会、记忆维护和提醒调度 |
| `src/sessions.js` | 运行记录、索引、节流落盘、结束/中断恢复、用量累计 |
| `src/prompt.js` | 系统规则、角色/记忆/历史/本次触发拼装、上下文档位判定 |
| `src/tier-slider.js` | 无依赖的档位换算，供 config 与 prompt 共用，避免循环导入 |
| `src/llm.js` | OpenAI 兼容 Chat Completions、提供商解析、超时/重试、400 兼容、usage |
| `src/prompt-cache.js` | 稳定提示词/工具缓存标记与厂商判定 |
| `src/tools.js` | 工具 schema、会话绑定执行、参数解析与返回内容 |
| `src/sender.js` | 每聊天串行发送、限频、消息切分、图片重试、自身消息留档 |
| `src/util.js`、`src/md-to-plain.js` | 原子写、事件总线、串行链、消息规范化、CQ 转义、Markdown 转纯文本 |
| `src/personas.js`、`src/persona-store.js` | 内置角色、角色管理/切换、memoryKey、记忆迁移与吸收 |
| `src/persona-distill.js` | 从聊天/文本样本蒸馏角色卡 |
| `src/memory.js` | 按人设和聊天组织的成员印象/本地记忆，组合其他记忆子系统 |
| `src/memory-global.js` | 人物档案、跨聊天事件、短期表层记忆、权重衰减与提示词检索 |
| `src/memory-llm.js` | 后台整理/蒸馏的模型调用配置 |
| `src/reminders.js` | 时间解析、重复计划、提醒持久化与领取状态 |
| `src/style-learn.js` | 说话风格采样、图片描述入口、蒸馏和风格注入 |
| `src/meme-store.js` | 梗库、Markdown 导入、检索、合并、使用记录 |
| `src/bili-meme.js`、`src/bili-discover.js` | B 站资料获取与梗候选发现 |
| `src/stickers.js`、`src/sticker-manager.js` | 表情数据规范化、检索/评分、同步与备注 |
| `src/image-search.js` | 多图源搜图、过滤/排序、冷却与降级、下载、反向搜图 |
| `src/web-search.js`、`src/safe-fetch.js` | 搜索服务、网页读取、安全 URL/DNS/重定向/响应大小检查 |
| `src/providers.js` | 提供商目录、密钥解析、模型列表/测试、旧 DSH 导入能力 |
| `src/vision-scan.js`、`src/model-vision-docs.js` | 模型视觉探测、内置资料与运行时能力判定 |
| `src/model-identity.js` | 新会话渠道标识与历史用量中的模型名称 |
| `src/admin.js`、`src/mute.js`、`src/identity.js` | 本地管理员命令、群禁言、QQ 身份和曾用名 |
| `ui/index.html`、`ui/app.js`、`ui/style.css`、`ui/refresh.css` | 页面骨架、全局状态/渲染/事件/API/SSE、基础样式与新版界面 |

当前业务 JavaScript 共 44 个文件：`src/` 42 个、Electron 入口 1 个、前端脚本 1 个。大文件尤其是 `app.js`、`orchestrator.js`、`tools.js` 和 `ui/app.js` 耦合较多，改动前先搜索调用点。

## 6. 数据与配置契约

### 标识及落盘

- 内部聊天键为 `group:<id>` / `private:<id>`；消息文件与部分 HTTP 路径使用 `group_<id>` / `private_<id>`。不要混用。
- `id` 是聊天内本地递增序号，`mid` 是 QQ 消息编号，可能为负数。引用/查询消息时核对需要哪一种。
- 消息时间戳一般为毫秒；OneBot 入站 `event.time` 以秒转换。提醒和用量变更尤其要检查单位。
- `data/messages/*.json` 保存 `{ chatKey, nextLocalId, messages }`。去重当前仅比较最近 500 条非自身消息，不是无限历史去重。
- `data/sessions/*.json` 保存运行触发、提示词、调用过程、发送结果、状态和用量。不要因“无状态”删除它们。
- `data/memory/<memoryKey>/` 隔离各人设记忆，包含聊天成员记忆、`_global/`、`_style/`；提醒位于人设的 `_global/reminders.json`。
- 梗库当前使用共享 `data/memory/memes/`，有旧路径兼容。不要照旧注释把所有记忆都迁入同一个人设目录。
- `data/stickers.json` 和用量汇总等为独立业务数据。SnowLuma 数据与它们分开管理。
- 文件写入优先复用 `writeTextAtomic()` / `writeJsonAtomic()`，并考虑缓存失效、旧数据兼容和写入失败；不要只修改磁盘文件却保留内存旧值。

### 配置修改

`DEFAULT_CONFIG` 是默认值来源；`getConfig()` 懒加载并缓存；`updateConfig()` 递归深合并后原子写盘。其“浅合并”旧注释与实现不符。

- 普通对象递归合并，数组替换；需要删除映射旧键时使用已有 `{ __replace__: value }` 协议。发送空对象不能清除旧映射。
- `setRuntimeConfig()` 只换内存值，不写盘；测试宜使用完整默认配置副本再覆盖。
- `store.contextSliderPos` 保存时派生档位和概率；前后端滑条边界需保持一致。
- 新配置需要同时核对：默认值、后端消费者、API 脱敏/保存、对应 UI 渲染、`bindSettingsEvents()`、`saveConfig()` 和旧配置回退。
- UI 仅渲染当前设置分栏。保存当前页时不能读取不存在的其他分栏 DOM 并把其值误写成空。
- 配置 GET 使用脱敏副本和 `hasKey`/`hasXxx` 标记。未修改密钥时不要回传空串覆盖真实值，主动清空要走明确语义。

## 7. 工具、模型与前后端联动

`buildToolDefs()` 当前定义 36 个工具，实际送给模型的集合会按视觉、搜索、搜图、提醒等开关裁剪。

新增/修改工具时：

1. 在 `tools.js` 更新名称、描述、JSON 参数 schema 和 `execute(ctx, args)`。
2. 使用 `ctx.chatKey` 等绑定上下文确定发送目标；不要让模型自由提供任意群号绕过接入限制。
3. 检查 `orchestrator.js` 的工具过滤、发送/查询分类和统计，必要时更新 `prompt.js` 规则。
4. 返回现有 `{ content, isError }` 结构；失败应明确返回错误，部分发送成功要保留成功记录。
5. 工具图片返回可用 content parts；编排器把文本置入 `tool` 消息，把图片放在全部对应 tool 回复之后的 `user` 消息。保留 tool_call_id 配对，不能直接把图片数组塞进 tool content。
6. 更新 UI 的 `TOOL_META` 或相关展示，覆盖功能关闭、非法参数、失败和成功路径。

模型适配主要在 `llm.js`：当前调用使用非流式 `stream: false`，UI 的实时变化来自 SSE/活动事件，不代表模型网络请求是流式的。已有温度、图片能力、思考参数和缓存标记等 400 兼容路径，修改时检查重试顺序与实际请求体。

HTTP 路由集中在 `app.js::handleHttp()`，主要族包括：状态/config、providers/models、sessions/chats、memory-global/memory-files、personas、reminders、style、memes、stickers/image-search、usage、snowluma、pause/admins/muted-groups/identity。精确参数以路由代码和 UI 调用处为准。

UI 的 `api()` 负责请求，`connectSSE()` 订阅 `/api/events`，同时存在轮询和增量/分页更新。改动事件名称或载荷时同步生产端、订阅端和回退轮询；避免高频全量重绘破坏滚动位置、焦点或用户未保存输入。动态文本插入 HTML 前复用 `esc()` 等转义。

2026-09-27 起已移除价格表、成本估算和远程价格拉取。用量页只统计实际调用的 Token、次数和缓存命中率，旧记录仍能按会话总量回退；历史记录中的旧价格字段不再参与计算，也不要为清理功能去修改真实 `data/`。SnowLuma 运行面板已并入设置中的「SnowLuma · OneBot」，原独立页签不再显示。人设常用字段位于首屏，其余字段保留在高级折叠菜单；保存接口仍按当前分区提交。

2026-10-09：亮色、暗色的品牌配色集中在 `ui/refresh.css`，主色为 `#4D6BFE`，界面采用独立的高透明磨砂玻璃卡片。默认仍为亮色主题，原有手动主题偏好保留。背景视频位于 `ui/assets/background-loop.mp4`，是用户指定 Steam Workshop 视频的项目内副本，不依赖原始盘符路径；HTML video 静音循环、`object-fit: cover` 自动铺满，允许按窗口比例裁剪，保持画面比例。顶栏「暂停背景」保存本机播放偏好，页面隐藏时停播；系统减少动态效果且无手动偏好时默认暂停，视频失败回退静态背景。静态路由为 MP4 提供流式 GET/HEAD 和单段字节范围响应（206/416），沿用 UI 目录路径保护。不要用父级 opacity 动画的 `fill-mode: both` 永久挡住卡片的背景模糊。旧暗色迁移标记 `qqa-white-theme-v1` 继续保留；原组件在 `ui/style.css`，新版覆盖规则在后加载的 `refresh.css`。

2026-09-27 起，「设置 → 记忆」展开为跨群档案/长期记忆、定时提醒、说话风格库三个功能配置子项；顶层「记忆」页展示它们产生的记录及各聊天的群友印象。会话、存档、记忆三页均有单项、勾选多项和一键清空入口；存档详情还可以清空单条或多选消息。新清空入口使用应用内确认弹窗，取消不会发删除请求。统一写接口为 `POST /api/data/delete`，`area` 取 `sessions`、`chats`、`memory`，用 `ids` 或 `all:true` 选择范围；存档消息用 `chatKey` + `messageIds`。会话不删运行/等待中记录，存档不删正在处理的聊天，记忆不删正在运行或整理的对象。清空只针对当前人设记忆树中的活跃记录，不修改白名单、角色、密钥、用量汇总、SnowLuma 或旧迁移备份。测试只能在隔离目录使用这些清空接口，绝不能对真实 `data/` 发清空请求。

2026-09-28 起，上述三个记忆设置子项同时显示各自已保存记录的数量、部分内容预览、完整管理页入口和「初始化记录」按钮。初始化分别清空当前人设的跨群档案/长期事件/表层记忆、全部提醒、全部风格样本与已学规则；它调用现有 `POST /api/data/delete` 的三个特殊记忆 id，保留功能开关及参数，保留原有运行中保护和确认弹窗。设置页进入时只读取记录，浏览器预览和测试不得对真实 `data/` 点确认清空。

2026-10-09 按用户要求进一步整合：跨群档案、提醒、风格的三个伪条目已从顶层「记忆」列表移除。功能参数、摘要、初始化和完整记录管理统一位于「设置 → 记忆」对应子项；「查看和管理记录」在本页展开，不再跳到顶层记忆页。三个详情加载函数改为写入 `#settings-memory-records`，异步完成时检查当前分区和目标节点，避免切页后写错面板。提醒/风格 SSE 只更新摘要和适合刷新的管理面板，不重建参数表单，以保留尚未保存的输入。顶层「记忆」只管理聊天群友印象；其全选、多选清空和一键清空仅提交实际聊天键，不能发送 `all:true` 连带清空设置中的三类功能记录。后端特殊记忆 id 与原有忙碌保护继续保留，未迁移或删除真实数据。

同日修正空记忆占位：`GET /api/memory-files` 不再根据白名单自动补零记录项，只有元数据的空目录也不显示；保留正在整理的聊天，以便追踪进度。前端 `loadMemoryView()` 同样过滤空占位，兼容尚未重启的旧后端，并在所选记录已不存在时清掉右侧详情。因此清空记录不会因白名单而再次显示空卡片，不需要删除白名单配置。针对真实使用记录执行初始化须先取得用户明确范围，复用现有删除 API 与忙碌保护，不能把初始化授权理解为重置配置或 QQ 登录。

同日简化模型接入：「模型 API」改为 DeepSeek、GLM、GPT、其他四个按钮，预设模型点击后只弹出 API Key 输入，官方地址自动填入；已有同端点密钥可以留空复用，跨端点不能复用旧密钥。自定义提供商表单、拉取列表和已有模型管理位于「其他」，温度、工具轮数、思考与发言行为保留在默认关闭的高级设置中。接入操作立即保存，高级设置仍通过「保存设置」提交；刷新接入摘要时不能重绘整个表单而丢失未保存的参数。仅因模型不支持图片而禁用的复选框不能覆盖用户原来的图片输入偏好。

预设目录唯一来源为 `src/model-catalog.js`，通过 `GET /api/model-catalog` 提供给 UI。2026-10-09 核对：DeepSeek V4.1 Flash 使用 `deepseek-flash`，V4 Pro 使用 `deepseek-v4-pro`；GLM 提供 5.3、5.3 Flash/FlashX、5.2；GPT 提供 6.1 Sol、6 Astra、6 Sol、6 Luna。参考官方 [DeepSeek 更新记录](https://api-docs.deepseek.com/updates/)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[GLM-5.3 Flash/FlashX](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)、[GPT-6 指南](https://developers.openai.com/api/docs/guides/latest-model)。更新目录时核对实际请求 ID、协议、图片能力与思考限制，不能只修改显示名称。

`POST /api/model-connection` 使用 `providers.connectModel()` 校验并一次持久化端点、模型、密钥与目录，响应脱敏，失败不会切换当前模型；保留其他供应商密钥和模型显示名。GPT-6 官方端点通过 `src/openai-responses.js` 调用 Responses API，适配工具定义、函数调用/结果、图片、加密推理重放与 token 用量；`orchestrator` 已有 assistant.raw 用于重放，不要在存档/后续轮次中丢弃。其他端点继续走 Chat Completions。GLM-5.2/5.3 的关闭思考档位收敛到 low，保留 `reasoning_content` 供工具结果后的续轮使用。模型连通性测试走对应协议，不会因点击“保存”而自动调用付费模型。

本次验证：`node --test tests/community-removal.test.mjs tests/model-connection.test.mjs` 共 19 项通过；隔离 HTTP 和 Edge 中点击全部 10 个预设，验证密钥弹窗、保存失败、同厂商密钥复用、自定义多模型添加/切换、未保存高级参数保留与保存回读；390px 宽四个厂商页无横向溢出。截图在 `output/playwright/models-desktop.png`、`models-mobile.png`、`model-key-dialog.png`。外部模型和 QQ 消息发送未做真实调用测试，不能将模拟协议测试描述为真实连通性已验证。后端模块改动需要完整重启 QQ Agent，单纯刷新 WebUI 不会热加载 Node 模块。

### 关于页与完整初始化（2026-10-09）

「设置 → 关于」显示 `v0.5alpha` 和「基于 Kondius 的 QQ Agent 开发，由 wraaaaaa 维护。」原作者由根目录 `LICENSE` 的版权声明核实；许可证保留，署名不恢复推广网站、上传或遥测功能。版本唯一来源为根 `package.json` 的 `version` 与 `displayVersion`，`GET /api/version` 同时返回署名信息。

完整初始化入口为「初始化全部内容」：第一次确认展示清理范围，第二次必须输入「初始化」。`POST /api/factory-reset/prepare` 仅发放三分钟单次确认令牌，不清理数据；`confirm` 验证令牌、输入、同源访问及忙碌状态后，在数据目录旁写入 `data.factory-reset.json`，暂停调度并安排完整进程重启。运行中、记忆整理、风格蒸馏、视觉扫描或桥接启动时拒绝初始化。提交成功不等于清理完成，UI 等待 `/api/factory-reset/status` 的对应完成标记，显示失败或完成反馈。

新进程在导入业务模块前等待旧进程退出、关闭项目内置 SnowLuma，重新校验绝对目录，分阶段移走并清理整个 `data/` 和内置 `snowluma/config`、`snowluma/data`、`snowluma/logs`。密钥、接口、供应商、所有自定义设置、人设、消息/会话、记忆、提醒、风格、梗库、表情缓存、用量、日志及旧备份一并清除，以完整 `DEFAULT_CONFIG` 创建配置，不能深合并旧配置。保留程序、依赖、内置素材和内置人设；API、供应商留空，开机启动和 SnowLuma 自动启动关闭。SnowLuma 使用外部 QQ 客户端，电脑 QQ 自身登录文件不属于项目数据，绝不删除或关闭 QQ 客户端。外部共享 SnowLuma、目录联接、符号链接和危险目录拒绝清理；仅对存在初始化任务的启动应用删除范围限制，普通启动保留原数据目录兼容性。

清理前移动失败恢复原目录；进入删除阶段后失败保留任务及明确错误，下次完整启动继续清理，不伪报完成。Electron 自动重启后清理其网页存储和缓存、关闭开机启动；无窗口入口此次重启保持原监听端口以让浏览器读取结果，但配置文件的端口仍恢复默认。客户端清除 `qqa-` 偏好，初始化完成自动进入模型接入页。初始化功能只在用户二次确认后执行，本轮开发未初始化真实项目数据。

验证：44 个业务脚本语法检查、`node --test tests/community-removal.test.mjs tests/model-connection.test.mjs tests/factory-reset.test.mjs` 共 28 项通过。隔离 Edge 实测两级取消、错误输入禁用、准备及确认失败反馈、真正跨进程清理/重启/回读默认配置、旧 API/自定义源/备份/桥接数据删除、网页偏好恢复及 390px 窄屏无横向溢出。另以临时复制的 Node 运行时验证精确停止旧桥接且不误杀清理进程。预览入口 `tests/factory-reset-preview.mjs` 仅用于工具创建的临时目录，完成后须关闭其重启子进程并清理临时目录。截图为 `output/playwright/about-*.png`；没有在真实 Electron 数据或 QQ 客户端执行初始化，也未调用外部模型。

## 8. 不应破坏的现有边界

2026-10-09：自定义设置统一使用默认关闭的原生 `details/summary`，右侧小箭头旋转，支持鼠标和键盘展开。范围包括「其他」中的自定义模型接入、自定义搜索源（含 Bing 地址及已有服务管理）、自定义搜图源、图片屏蔽标签、会话搜图覆盖、独立记忆模型、分群响应档位、响应关键词与禁言回复；人设附加规则继续位于原有高级折叠菜单。折叠只控制展示，不移除或重建内部字段；保留原字段 ID、隐藏 JSON、密钥缓存和保存事件，防止收起后丢失输入或清空配置。记忆模型和分群档位的外层折叠菜单沿用原有开关控制显隐。官方服务选择及人设常用字段仍可直接操作。

此次 `ui/app.js` 语法与 19 项隔离回归通过；隔离 Edge 实测九个自定义折叠区的默认收起、展开/收起，搜索菜单的键盘操作与未保存输入保留，模型/搜索/图源添加、图源密钥保留、记忆专用模型选择、分群档位及话术的收起后保存回读，以及模拟保存失败反馈。六个相关设置页在 390px 视口下展开和收起均无页面横向溢出。截图位于 `output/playwright/custom-settings-desktop.png` 和 `custom-settings-mobile.png`；未修改真实配置和 QQ 登录，未调用真实模型、搜索或搜图接口。

2026-10-09：WebUI 顶栏提供全局「刷新页面」按钮，直接调用 `window.location.reload()`，在任何页签都可使用。

- 接入过滤与工具发送目标绑定不能只靠提示词约束。新增入口必须检查名单、禁言和授权路径。
- 保持本地监听及现有 API token 检查。`server.token` 留空时 API 并无通用强身份认证，不应直接暴露到公网。
- 模型或消息提供的 URL 应使用 `safe-fetch.js` 相关检查，保留 DNS/IP 固定、逐跳重定向校验、大小限制。不要为解决某个图源失败全局打开内网访问。
- Electron 保持 `contextIsolation: true`、`nodeIntegration: false`。
- 不给 QQ 对话工具新增任意 shell、任意文件读写或任意管理配置能力。
- SnowLuma 进程管理按本安装目录匹配，不能用“杀掉所有 node.exe/electron.exe”修复问题。
- 人设切换涉及 memoryKey 和缓存，跨群/私聊记忆还存在独立共享开关。修改时验证隔离范围，不能假定所有记忆共享规则相同。

## 9. 验证方法与当前基线

社区上传、网站/交流群入口、介绍页和二维码、自动更新检查及遥测已移除。保留本地版本显示、用量看板和 `report_feedback` 本地控制台工具。历史配置中的遥测字段即使仍存在也不会生效；不为清理功能而改写真实运行数据。

### 已执行的检查

2026-09-22 清理后，41 个业务 JavaScript 文件使用包内 Node 执行 `--check` 全部通过。新增 6 项隔离回归测试，在系统 Node.js 24.14.1 和 Electron 内置 Node.js 20.18.3 下通过：删除接口返回 404、本地版本和控制台、配置保存与密钥保留、聊天去重/模拟发送/用量统计、36 个工具及本地反馈、12 个设置分栏与消息行渲染、无外部请求及残留入口。

2026-09-27 UI 改造后，当前 40 个业务 JavaScript 文件的 `node --check` 全通过。此次记录管理增加后，8 项隔离回归测试通过（含旧暗色首屏迁移及三类数据清空与忙碌状态保护）。隔离浏览器检查了记忆设置子菜单、记忆记录页勾选与清空控件，并验证批量清空弹窗出现及取消不执行；此前还实测过 12 个设置分栏的保存反馈、模型连通性失败提示、用量筛选与明细、主导航、白色默认主题与旧后端暗色配置不覆盖、人设常用项与高级项互不覆盖，并修正 390px 窄屏设置页溢出。白色界面的入场、卡片与背景动效已在浏览器中检查；预览仅监听随机本地端口，没有启动 SnowLuma、QQ 或模型调用；真实外部链路仍需在用户自己的配置下验收。

2026-09-28 记忆设置记录入口调整后，`ui/app.js` 语法检查和 8 项隔离回归测试通过；其中清空测试分别检查提醒、风格、跨群档案互不误删。隔离 Edge 浏览器查看了三个设置子项的摘要与初始化按钮，跨群档案的确认弹窗文案及取消操作，并从提醒设置进入完整记录页。浏览器控制台唯一错误是预览服务器未提供 `favicon.ico`（404）。这些结果不代表已在用户真实数据上执行初始化。

2026-10-09 视频玻璃 UI 与记忆入口整合后，当前隔离回归共 10 项：新增 MP4 HEAD/字节范围/非法范围/目录边界，以及视频暂停/隐藏页面/减少动态效果/播放失败分支；原前端回归补充完整管理留在设置、顶层记忆无伪条目、一键清空只提交聊天键的实际执行检查。包内 Node 对修改的前后端脚本进行语法检查。隔离 Edge 浏览器实测五个主页、十二个设置分栏保存、三个完整管理面板、风格记录添加/置顶/删除、保存失败提示、全局刷新、视频循环和暂停偏好、亮色/暗色、减少动态效果；390px 视口的所有主页和设置分栏没有横向溢出。控制台预期的网络错误包括缺失 favicon 的 404、隔离 OneBot 群列表的 502，以及主动模拟保存失败的 500，没有发现 JavaScript 页面异常。未启动真实 SnowLuma/QQ/模型，也未验收 Electron 隐藏窗口的实际 GPU 开销。

同日空占位修正后，隔离回归增至 11 项，通过白名单无记录不显示、保存后显示、删除后不回填、仅元数据目录不显示、正在整理仍显示，以及旧后端空占位过滤和详情清除检查。修改的前后端脚本通过包内 Node 语法检查。

执行方式：`node --test tests/community-removal.test.mjs`。测试自行创建临时数据目录，禁止外部 fetch，只开启随机端口的本地 HTTP 服务，不调用应用 `start()`，不连接真实 QQ。前端验证使用 DOM 桩实际执行渲染函数，不等同于桌面窗口视觉验收。

需要在浏览器里复查 UI 时运行 `node tests/ui-smoke-server.mjs`，打开输出的 `UI_SMOKE_URL`；它只使用临时数据、隔离的 SnowLuma 路径和不会自动启动的网关配置。结束进程后临时数据会清理。

包内 `snowluma/node.exe` 执行这份集成测试时曾以 Windows 原生异常码 3221225477 退出，因此这里只将它用于语法检查，不宣称该运行时的集成测试通过。真实模型和 QQ 链路未验证。

可重复执行的 PowerShell 语法检查：

```powershell
$files = @(Get-ChildItem .\src -Filter *.js) +
         @(Get-ChildItem .\electron -Filter *.js) +
         @(Get-Item .\ui\app.js)
foreach ($file in $files) {
    & .\snowluma\node.exe --check $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "语法检查失败：$($file.FullName)" }
}
```

### 后续按改动选择验证

- 纯函数：使用 Node 自带断言/测试能力覆盖实际边界，特别是滑条 10/20/90、负数消息号、时间解析及参数兼容。
- 配置/存储：临时目录 + 假数据，验证旧配置加载、保存回读、密钥保留、映射删除和缓存更新。
- 调度/重试：模拟 OneBot 和 LLM，检查重复事件、运行中新消息、暂停恢复、不回复、部分发送后失败、重启恢复。
- HTTP：隔离应用和协议端，检查请求/响应、授权、错误路径及 SSE。不能只验证 200 状态。
- UI：实际执行相关渲染/交互，检查控制台异常、保存回读、切页及滚动；语法检查捕获不了缺失变量和 DOM 错误。
- 真实端到端：在用户指定的测试聊天和配置下进行；实际调用与发送结果单独报告。

测试隔离不能只设置 `QQ_AGENT_DATA_DIR`：还需替换 OneBot 地址、禁用 SnowLuma 自动启动并隔离其目录/令牌探测，关闭主动搭话和不需要的后台网络功能，使用模拟模型与新端口，并清理本次创建的服务/定时器。

## 10. 已知文档偏差与后续关注点

以下是开发注意事项，不是本轮已修复的问题：

- README 的 `npm start`、`npm run server`、`npm test` 和发布脱敏命令在当前包中缺少对应 scripts/文件，不能直接作为已存在的开发流程。
- README 的测试数量、性能倍数、源码规模属于文档陈述，本轮未复验；当前源码已明显多于其中的早期规模描述。
- “首次为空/已全部脱敏”的说明不能代表当前目录状态：目前存在消息、会话、日志和协议端数据库。分享发布前需另做明确范围的数据处理。
- OneBot 端口、自动启动和关窗行为在 README、使用说明、默认配置之间存在差异；排查时核对实际生效配置。
- 重试、失败放回未读与中断恢复共同作用，发送幂等性要整条链路验证，不能只看局部重试守卫。
- 大文件内有旧注释与后续实现不一致的情况，例如配置合并、梗库路径、会话落盘频率。不要直接把注释当测试结论。
- 无现成 Git 基线，当前有社区功能/本地 UI 数据管理回归与模型接入/协议适配隔离测试。若后续任务需要版本管理或更多测试基础设施，应作为明确范围的工程工作推进，不擅自把当前运行数据整体纳入仓库。

## 11. 每次二次开发的收尾

2026-10-09 按用户要求整理临时产物：根目录 `.playwright-cli/`、`output/` 和两个隔离预览临时目录已移动至 `D:\开发\垃圾\QQ-Agent-临时产物-20261009-205516`，原路径与文件统计见该目录的 `移动清单.json`。本文此前的 `output/playwright/*.png` 验证截图现位于其 `项目产物/output/playwright/` 下；后续浏览器验证可重新创建项目内输出目录。保留 `tests/` 的回归与隔离预览脚本，未移动真实 `data/`、SnowLuma 数据、依赖或运行素材。

记录改了什么、影响哪些入口、执行了哪些验证、仍有哪些未验证项。改变配置结构、数据布局、工具协议或启动方式时更新本文；新增回归测试应覆盖真实行为风险，不仅复述实现。保持普通功能修改、数据迁移和运行环境操作各自可追踪。
