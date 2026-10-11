// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import { getConfig } from './config.js';
import { normalizeMessageList, unquoteJsonString } from './util.js';
import { formatStickerList } from './stickers.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
import { expandForwardNodes, fetchForwardNodes } from './onebot.js';
import { parseWhen, repeatLabel } from './reminders.js';
import {
  searchImages, pixivIllustDetail, downloadFirstAvailable, imageUrlToDataUrl,
  describeResult, providerDisplayName, imageSearchConfigForChat, refererFor,
  reverseImageSearch, describeReverse, pickBestImage
} from './image-search.js';
import { describeMeme } from './meme-store.js';
import { biliHotVideos, lookupMemeOnBili } from './bili-meme.js';
import { discoverMemeCandidates } from './bili-discover.js';

/**
 * 每个会话的"最近搜到的图"。
 * 模型不可能把长图片 URL 一路记在上下文里，所以 search_image 只给它编号，
 * send_image 用同一个编号取回地址 —— 既省 token，也避免模型手抄 URL 抄错。
 * （纯内存，进程重启即失效；重启后模型重新搜一次即可，代价很低。）
 */
const IMAGE_HISTORY = new Map();     // chatKey -> { at, items: [{...result}] }
const IMAGE_HISTORY_MAX = 24;
const IMAGE_HISTORY_TTL = 30 * 60 * 1000;

function imageHistory(chatKey) {
  const key = String(chatKey || '');
  const hit = IMAGE_HISTORY.get(key);
  if (!hit || Date.now() - hit.at > IMAGE_HISTORY_TTL) {
    const fresh = { at: Date.now(), items: [] };
    IMAGE_HISTORY.set(key, fresh);
    return fresh;
  }
  return hit;
}

function pushImageHistory(chatKey, items, queryLabel = '') {
  const hist = imageHistory(chatKey);
  for (const item of items) {
    hist.items.push({ ...item, queryLabel, foundAt: Date.now() });
  }
  if (hist.items.length > IMAGE_HISTORY_MAX) hist.items = hist.items.slice(-IMAGE_HISTORY_MAX);
  hist.at = Date.now();
  return hist;
}

function findHistoryItem(chatKey, index) {
  const hist = imageHistory(chatKey);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 1 || i > hist.items.length) return null;
  return hist.items[i - 1];
}

function markSent(chatKey, item) {
  const hist = imageHistory(chatKey);
  const id = String(item.id || item.url);
  for (const it of hist.items) {
    if (String(it.id || it.url) === id) it.sent = true;
  }
}

/** 判断直链能不能交给 QQ 服务端去抓（防盗链的站点一律本地下载后内嵌）。 */
function canSendByUrl(url) {
  const s = String(url || '');
  if (!/^https?:\/\//i.test(s)) return false;
  return !refererFor(s);   // 需要 referer 的站点，QQ 抓不到
}

// 表情包/搜图共用的图片下载（带防盗链 referer 与体积上限）
async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl, 12 * 1024 * 1024, {
    headers: refererFor(safeUrl) ? { referer: refererFor(safeUrl) } : null
  });
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 供编排器复用：把一个图片地址下成 data URL（内部已做 SSRF 校验 + 体积限制）。
 * 风格学习里的"给被回应的图片生成一句描述"走的就是它。
 */
export async function imageToDataUrl(url) {
  return downloadImageAsDataUrl(url);
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

// 合并转发展开后随包附上的图片上限：一条转发可能有几十张图，全塞进上下文会顶爆
// （图片按 base64 计入请求体与上下文）。够看清内容即可，要更多再单独调 get_message_images。
const FORWARD_MAX_IMAGES = 4;
// 单张 / 单次回包的 data URL 体积上限（base64 字符数）。QQ 原图偶尔好几 MB，
// 超了直接跳过并如实说明，免得一条转发把整轮请求顶穿（顶穿了模型会直接报错）。
const FORWARD_MAX_IMAGE_CHARS = 6 * 1024 * 1024;
const FORWARD_MAX_TOTAL_CHARS = 12 * 1024 * 1024;
// get_message_images 一次最多回几张（口径比 read_forward 宽一点，因为这是模型点名要看的）
const MESSAGE_MAX_IMAGES = 8;

/**
 * read_forward 的统一回包：默认把转发里的图一并送到模型眼前，
 * 这样"展开看内容"这一步就能看到图，不必再多跑一轮 get_message_images。
 *
 * 三道闸：
 *   ① `withImages === false`（模型明说不要图）→ 只回文字 + 提示还有几张；
 *   ② `ctx.session.visionEnabled !== true` → 不带图。当前模型不能看图（如 glm-4.6
 *      这类纯文本模型）时塞图会直接 400（见 llm.js 的图片 400 兜底），
 *      所以这里必须与 orchestrator 的判据一致，**不能只看"有没有图"**；
 *   ③ 最多 FORWARD_MAX_IMAGES 张、单张与总量都设上限，并如实说明没带上的部分。
 */
async function forwardResult(ctx, { messageId, text, imageUrls = [], withImages = true, fromArchive = false }) {
  const notes = [];
  if (fromArchive) notes.push('该转发之前已展开，读的是存档');
  if (!imageUrls.length) {
    return ok({ messageId, text, images: 0, ...(notes.length ? { note: notes.join('；') } : {}) });
  }
  if (withImages === false) {
    notes.push(`这条转发里还有 ${imageUrls.length} 张图没给你（你这次只要文字）；要看就用 get_message_images 传同一个 messageId`);
    return ok({ messageId, text, images: imageUrls.length, note: notes.join('；') });
  }
  if (ctx.session?.visionEnabled !== true) {
    notes.push(`这条转发里有 ${imageUrls.length} 张图，但当前模型不支持图片输入，看不到图，只能按文字内容理解（别声称看过图）`);
    return ok({ messageId, text, images: imageUrls.length, note: notes.join('；') });
  }

  const picked = imageUrls.slice(0, FORWARD_MAX_IMAGES);
  const dataUrls = [];
  const failed = [];
  let chars = 0;
  for (let i = 0; i < picked.length; i++) {
    const url = picked[i];
    if (chars + FORWARD_MAX_IMAGE_CHARS > FORWARD_MAX_TOTAL_CHARS) break;   // 预算用完，剩下的不下了
    try {
      const dataUrl = await downloadImageAsDataUrl(url);
      if (dataUrl.length > FORWARD_MAX_IMAGE_CHARS) { failed.push('过大'); continue; }
      chars += dataUrl.length;
      dataUrls.push(dataUrl);
    } catch (e) {
      failed.push(String(e?.message ?? e).slice(0, 40));
    }
  }
  if (!dataUrls.length) {
    notes.push(`转发里有 ${imageUrls.length} 张图，但一张都没取到（${failed.join('；').slice(0, 80) || '体积超限'}）`);
    return ok({ messageId, text, images: imageUrls.length, note: notes.join('；') });
  }
  const rest = imageUrls.length - dataUrls.length;
  const tails = [];
  if (rest > 0) {
    const reasons = [];
    const dropped = picked.length - dataUrls.length;
    if (dropped > 0) reasons.push(`取不到或体积超限 ${dropped} 张`);
    const overCap = imageUrls.length - picked.length;
    if (overCap > 0) reasons.push(`超出单次上限还有 ${overCap} 张`);
    tails.push(`还有 ${rest} 张没附上（${reasons.join('，')}）；要看就再用 get_message_images 传 messageId=${messageId}`);
  }
  if (notes.length) tails.push(notes.join('；'));
  const head = `消息 ${messageId} 的合并转发已展开（共 ${imageUrls.length} 张图，这里附上 ${dataUrls.length} 张${tails.length ? `；${tails.join('；')}` : ''}）：\n${String(text ?? '').slice(0, 1800)}`;
  return { content: imageParts(head, dataUrls) };
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 */
export function buildToolDefs() {
  return [
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          ctx.emit('session-update', ctx.session.id);
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个表情。两种用法（二选一）：① stickerId 精确发送（id 从 list_stickers 获取）；② query 按含义/情绪挑一个最贴切的发（如 query="无语""安慰""大笑"）—— 不确定 id 时用 query 更省事。一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id（与 query 二选一）' },
          query: { type: 'string', description: '按含义/情绪/场景挑一个最贴切的表情（与 stickerId 二选一）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        }
      },
      async execute(ctx, args) {
        try {
          const byId = unquoteJsonString(args.stickerId);
          const query = String(args.query ?? '').trim();
          let sticker = null;
          if (byId) {
            sticker = await ctx.stickers.find(byId);
            if (!sticker) return err(`找不到表情 ${byId}，请先用 list_stickers 获取有效 id，或改用 query 按含义挑`);
          } else if (query) {
            // 按语境/情绪挑：优先带备注的，其次使用次数高的
            const found = ctx.stickers.pickBest ? ctx.stickers.pickBest(query) : null;
            sticker = found || null;
            if (!sticker) {
              const list = await ctx.stickers.list(query, 8);
              const first = list?.stickers?.[0];
              if (first) sticker = await ctx.stickers.find(first.id);
            }
            if (!sticker) return err(`没找到和"${query}"对得上的表情。换一个说法，或先用 list_stickers 看看库里有什么。`);
          } else {
            return err('要传 stickerId 或 query 其中一个');
          }
          if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          try {
            await validateImageUrl(sticker.url); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
          } catch (error) {
            return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
          const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.label || sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, stickerId: sticker.id, note: '表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'search_image',
      description: '搜图（默认接 pixiv，也可以搜图库）：把想要的图找出来，结果带缩略图，你能直接看到内容。找你打算发出去的图时用它，然后用 send_image 按编号发。要点：(1) 搜索词用作品/角色的原名或标签最准（"初音ミク""原神 甘雨""cyberpunk city"），中文口语描述常常搜不到；(2) 默认已屏蔽 AI 生成图，如果结果里还是有明显的 AI 图，直接换一张，不要发；(3) 一次别搜太多，1~3 张够用，先看再发；不合适就换个词再搜。搜不到图是正常的（很多关键词本来就没有对应作品），换词或老实说没找到，不要编。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词（作品名/角色名/标签，中英日文都行）' },
          limit: { type: 'integer', description: '想要几张候选，默认 3，最多 10' },
          provider: { type: 'string', description: '可选图源：pixiv（默认）| safebooru | konachan | yandere | custom:<id>' },
          stage: { type: 'string', description: '可选搜索严格度：auto（默认，逐级放宽）| strict（带全年龄过滤）| normal | loose' },
          page: { type: 'integer', description: '可选翻页（默认 1），同一关键词想看更多时加' },
          hideAi: { type: 'boolean', description: '可选：临时改变"屏蔽 AI 图"（默认跟随设置）' },
          allowR18: { type: 'boolean', description: '可选：允许 R18 结果（仅在管理员设置里开了总开关后才有效）' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const cfg = imageSearchConfigForChat(ctx.chatKey);
          if (!cfg.enabled) return err('搜图功能已关闭（设置 → 搜图服务）');
          let allowR18 = args.allowR18 === true && cfg.allowR18 === true;
          if (args.allowR18 === true && cfg.allowR18 !== true) {
            // 管理员没开总开关：忽略参数，并在结果里说明，避免模型以为图源坏了
            allowR18 = false;
          }
          const res = await searchImages(String(args.query ?? ''), {
            cfg,
            provider: args.provider ? String(args.provider) : cfg.provider,
            limit: Number(args.limit) || cfg.defaultLimit,
            stage: args.stage ? String(args.stage) : 'auto',
            page: Number(args.page) || 1,
            hideAi: args.hideAi === undefined ? cfg.hideAi : args.hideAi !== false,
            allowR18,
            seen: new Set(imageHistory(ctx.chatKey).items.map((it) => String(it.id || it.url)))
          });
          if (!res.items.length) return err('没有找到可用的图（可能都被 AI 屏蔽/分级过滤掉了），换个搜索词或把 hideAi 临时关掉试试');

          const picked = res.items.slice(0, Math.min(10, Math.max(1, Number(args.limit) || cfg.defaultLimit)));
          const hist = pushImageHistory(ctx.chatKey, picked, res.query);
          const startIndex = hist.items.length - picked.length + 1;
          const lines = picked.map((it, i) => `[${startIndex + i}] ${describeResult(it)}`);
          const notes = [];
          if (res.degraded) notes.push(res.degraded);
          if (res.dropped?.ai) notes.push(`已屏蔽 ${res.dropped.ai} 张 AI 生成图`);
          if (res.dropped?.r18) notes.push(`已过滤 ${res.dropped.r18} 张 R18`);
          if (res.dropped?.seen) notes.push(`跳过 ${res.dropped.seen} 张刚发过的`);
          if (args.allowR18 === true && cfg.allowR18 !== true) notes.push('管理员未开启 R18，本次按全年龄过滤');
          const tail = ctx.session?.visionEnabled === true
            ? `（下面是图片本身，看一下再决定发哪张；不合适就换词重搜${res.degraded ? '。注意这次是降级图源，画风/精度可能不如 pixiv，发之前先看图合不合适' : ''}）`
            : `（当前模型不能看图，请按上面的编号与标题挑一张发；别声称自己"看过"这些图。不合适就换词重搜${res.degraded ? '。注意这次是降级图源，画风/精度可能不如 pixiv' : ''}）`;
          const head = `用「${res.query}」在 ${providerDisplayName(res.provider, cfg)} 搜到 ${picked.length} 张${notes.length ? `（${notes.join('，')}）` : ''}。发图用 send_image(index=编号)：\n${lines.join('\n')}\n${tail}`;

          // 视觉模型直接看图判断是否贴切；无视觉模型时退化为纯文本列表
          const dataUrls = [];
          if (ctx.session?.visionEnabled === true) {
            for (const it of picked.slice(0, 4)) {
              try { dataUrls.push(await imageUrlToDataUrl(it.url, { maxBytes: 4 * 1024 * 1024 })); } catch { /* 单张失败不影响列表 */ }
            }
          }
          if (!dataUrls.length) return ok(head);
          return { content: imageParts(head, dataUrls) };
        } catch (error) {
          return err(`搜图失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'send_image',
      description: '把一张图发到当前聊天（独立气泡，一条一张图，不能和文字同一个气泡；想配话就先用 send_message 单独说）。三种用法：(1) index = search_image 结果里的编号（推荐）；(2) url = 群友发来的或你已知的公网图片直链；(3) pixivId = pixiv 作品号（如 12345678，从链接里能看到）。发之前确认这张图确实贴题；搜图失败就别硬发。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'search_image 返回的编号（1 开始）' },
          url: { type: 'string', description: '公网图片直链（http/https）' },
          pixivId: { type: ['integer', 'string'], description: 'pixiv 作品 id' },
          caption: { type: 'string', description: '可选：一句话说明（图片描述，部分客户端会先显示它；不是配文）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        }
      },
      async execute(ctx, args) {
        try {
          const cfg = imageSearchConfigForChat(ctx.chatKey);
          if (!cfg.enabled) return err('搜图功能已关闭（设置 → 搜图服务），不能发图');

          // ── 定位要发的那张图 ──
          let item = null;
          if (args.index !== undefined && args.index !== null && String(args.index).trim() !== '') {
            item = findHistoryItem(ctx.chatKey, args.index);
            if (!item) {
              const hist = imageHistory(ctx.chatKey);
              const hint = hist.items.length
                ? `本次会话最近搜到的编号是 1~${hist.items.length}（最新的在后），请用这些编号，或先 search_image 再发`
                : '本次会话还没有搜过图，请先 search_image 拿到编号，或者直接用 url 参数';
              return err(`找不到编号 ${args.index} 的图。${hint}`);
            }
          } else if (args.pixivId !== undefined && args.pixivId !== null && String(args.pixivId).trim() !== '') {
            const detail = await pixivIllustDetail(String(args.pixivId), { cookie: cfg.cookie, timeoutMs: cfg.timeoutMs });
            const rated = String(detail.rating) === 'r18';
            if (rated && cfg.allowR18 !== true) return err(`pixiv 作品 ${detail.id} 是 R18，管理员没开允许 R18，已拒绝发送`);
            if (detail.ai === true && cfg.hideAi !== false) {
              // 屏蔽 AI 图是管理员的硬要求，不允许用"直接给作品号"绕过
              return err(`pixiv 作品 ${detail.id} 被标注为 AI 生成图，当前「屏蔽 AI 图」是开着的，不能发（要发人工画的请换一张）`);
            }
            item = { ...detail, url: detail.candidates[0] || '', candidates: detail.candidates, reference: `https://www.pixiv.net/artworks/${detail.id}` };
          } else if (args.url) {
            const url = await validateImageUrl(String(args.url));
            item = { url, candidates: [url], title: '', author: '', tags: [], source: '直链', reference: '' };
          } else {
            return err('请给 index（search_image 的编号）、pixivId 或 url 之一');
          }

          // ── 画质提升：把搜索结果里的 540px 预览图换成原图/大图 ──
          // 搜索接口给的地址是"省流量的缩略图"（同一作品 36KB vs 原图 1.5MB），
          // 直接把缩略图发出去会明显糊。这里先探一次原图地址与体积，再决定发什么。
          try {
            const best = await pickBestImage(item, cfg);
            if (best.candidates.length) {
              item = { ...item, candidates: best.candidates, pickedQuality: best.quality, pickedNote: best.note };
            }
          } catch { /* 取不到更好的就用原候选 */ }

          // ── 下载（本地一定要先拿到图：既为了内嵌兜底，也为了体积可控）──
          // 上限用 maxImageMb（画质上限）而不是 maxDownloadMb —— 发原图必然更大；
          // maxDownloadMb 仍然作为硬上限兜底。
          const maxBytes = Math.round(Math.max(
            Math.max(0.5, Number(cfg.maxDownloadMb) || 8),
            Math.max(1, Number(cfg.maxImageMb) || 12)
          ) * 1024 * 1024);
          const candidates = (item.candidates || []).length ? item.candidates : [item.url, item.thumb].filter(Boolean);
          const got = await downloadFirstAvailable(candidates, { maxBytes });

          // ── 决定发送方式 ──
          let mode = cfg.sendMode;
          if (mode === 'auto') mode = canSendByUrl(got.url) ? 'url' : 'base64';
          let source = null;
          if (mode === 'url') {
            source = { file: got.url };
          } else {
            const b64 = `base64://${got.buffer.toString('base64')}`;
            // 内嵌有大小上限：base64 会把体积撑大约 1/3，腾讯侧对单图也有硬限制，
            // 超过 4MB 的图宁可退回直链让 QQ 自己去抓（P 站图床抓不到时还有下面的重试兜底）。
            source = got.buffer.length <= 4 * 1024 * 1024 ? { file: b64 } : { file: got.url };
          }

          const label = item.title || item.author || item.source || '图片';
          let result = null;
          try {
            result = await ctx.sender.sendImage(ctx.chatKey, source, {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null,
              summary: String(args.caption ?? item.title ?? '').slice(0, 80),
              label
            });
          } catch (error) {
            // 直链发失败（被墙/防盗链/太大）→ 本地内嵌再试一次
            if (String(source.file).startsWith('http')) {
              const b64 = `base64://${got.buffer.toString('base64')}`;
              result = await ctx.sender.sendImage(ctx.chatKey, { file: b64 }, {
                replyToMessageId: args.replyToMessageId ?? null,
                atUserId: args.atUserId ?? null,
                summary: String(args.caption ?? item.title ?? '').slice(0, 80),
                label
              });
              mode = 'base64';
            } else {
              throw error;
            }
          }

          markSent(ctx.chatKey, item);
          ctx.session.sent.push({
            type: 'image',
            text: `[图片:${label}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit('session-update', ctx.session.id);
          return ok({
            sent: true,
            messageId: result?.message_id ?? null,
            what: `${item.title || '（无标题）'}${item.author ? ` by ${item.author}` : ''}`,
            sizeKb: Math.round(got.buffer.length / 1024),
            quality: item.pickedQuality || 'preview',
            qualityNote: item.pickedNote || '',
            mode,
            reference: item.reference || item.pageUrl || '',
            note: '图片已发出（独立气泡）。不要输出"已发送"类汇报，按需要补一句话或结束。'
          });
        } catch (error) {
          return err(`发图失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'meme_search',
      description: '查梗知识库：网梗、游戏梗、群内黑话的含义、适用场景和范例句。用法：聊到某个梗但不确定怎么用、或者想找"现在这个话题能接什么梗"时，把当前话题/关键词丢进来查（query 传梗名或一句语境都行）。查到的 useCases（什么场景能用）和 examples（范例句）是管理员写的，照那个语感用；不适用的场景别硬套。查到后如果决定用其中一条，顺手把它的名字填进 usedText（只是统计）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '梗名或当前话题/语境（留空 = 列出最常用的几条）' },
          tag: { type: 'string', description: '可选：按标签过滤（如 kards / 无畏契约 / 阴阳怪气）' },
          kind: { type: 'string', description: '可选：game 游戏梗 | net 网梗 | group 群内黑话 | anime 二次元 | other' },
          limit: { type: 'integer', description: '可选：最多返回几条，默认 8' },
          usedText: { type: 'string', description: '可选：如果你确定接下来要用其中某一条，把它的名字填这里（只用于统计，不影响发送）' }
        }
      },
      async execute(ctx, args) {
        try {
          const memes = ctx.memory?.memes;
          if (!memes) return err('梗知识库模块未加载');
          if (memes.enabled === false) return err('梗知识库未启用（设置 → 梗知识库）');
          const found = ctx.memory.searchMemes(String(args.query ?? ''), {
            chatKey: ctx.chatKey,
            tag: String(args.tag ?? ''),
            kind: String(args.kind ?? ''),
            limit: Number(args.limit) || 8
          });
          if (!found.length) {
            return ok({
              found: 0,
              note: '梗库里没有匹配的条目。别硬编一个梗出来 —— 要么换个词再查，要么这次就不玩梗。学到新梗可以用 meme_note 记下来（记之前先确认自己没理解错）。'
            });
          }
          // 统计：哪条梗真的被用上了（管理端看得到，用来淘汰没用的梗）
          const usedText = String(args.usedText ?? '').trim();
          if (usedText) {
            const hit = found.find((e) => e.text === usedText || (e.aliases || []).includes(usedText));
            if (hit) ctx.memory.markMemeUsed(hit.id, String(ctx.session?.triggerText || '').slice(0, 120));
          }
          return ok({
            found: found.length,
            memes: found.map((e) => ({
              id: e.id,
              text: e.text,
              aliases: e.aliases,
              kind: e.kind,
              means: e.means,
              source: e.source,
              useCases: e.useCases,
              examples: e.examples,
              avoid: e.avoid,
              tags: e.tags,
              priority: e.priority,
              scope: e.scope,
              used: e.useCount
            })),
            note: '用的时候要贴语境：examples 是范例句，可以改写成你自己的语气，但别把梗用在 avoid 描述的场景里。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'meme_from_bili',
      description: '去 B 站找梗（免登录，不需要任何 Key）。三种用法：①term=某个说法 → 求证它是不是"真的有人这么说"，并给出搜索建议与视频链接当出处；②discover=true（或什么都不传）→ 主动看看"最近 B 站在流行什么整活"：它会从热门视频标题里提炼并验证出一批候选梗词，帮你在群里发现新梗；③hot=true → 只看当下热门视频标题（谈资）。群里冒出一个你不认识的新说法时用①；想主动找点新梗、或者冷场想抛话题时用②。',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: '要查的梗/说法。传了就查这个说法在 B 站的证据' },
          discover: { type: 'boolean', description: 'true = 主动发现当下的候选梗（从热门标题提炼并用搜索建议验证）；不传 term 时默认走这个' },
          hot: { type: 'boolean', description: 'true = 只拉一批当下热门视频标题（不要提炼梗，纯看谈资）' },
          limit: { type: 'integer', description: '可选：hot/discover 时看几条，默认 12，最多 30' }
        }
      },
      async execute(ctx, args) {
        try {
          const term = String(args.term ?? '')
            .replace(/\[CQ:[^\]]*\]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
          const limit = Math.min(30, Math.max(1, Number(args.limit) || 12));

          // ── 模式 ② 主动发现（无 term，且没显式要 hot）──
          if (!term && args.hot !== true && args.hot !== 'true') {
            if (getConfig().meme?.biliProactive === false) {
              return err('管理员关闭了"主动发现网梗"。要么传 term 求证某个说法，要么用 hot=true 只看热门视频标题。');
            }
            let found;
            try {
              found = await discoverMemeCandidates({ limit, maxProbe: Math.min(8, limit) });
            } catch (error) {
              return err(`B 站检索失败：${error?.message ?? error}`);
            }
            if (!found.length) {
              return ok({
                mode: 'discover',
                found: 0,
                note: '这批热门标题里没提炼出明确的候选梗（B 站搜索建议没有命中）。不用硬造，正常说话就行；也可以换个时机再看。'
              });
            }
            return ok({
              mode: 'discover',
              found: found.length,
              candidates: found.map((c) => ({ term: c.term, evidence: c.evidence, url: c.urls[0] })),
              note: '这些是从当下热门视频标题里提炼、并经 B 站搜索建议验证过"确实有大量人在搜"的说法 —— 是真·在传的梗。挑你确实理解含义的用，不懂的别硬套；想记进梗库先确认含义。'
            });
          }

          // ── 模式 ③ 只看热门视频 ──
          if (args.hot === true || args.hot === 'true') {
            let videos;
            let source = 'ranking';
            try {
              videos = await biliHotVideos({ limit });
            } catch (rankingError) {
              // 排行榜偶尔会被 B 站风控挡住（-352），退回热门接口 —— 别让整个功能挂掉
              try {
                videos = await biliHotVideos({ kind: 'popular', limit });
                source = 'popular';
              } catch (popularError) {
                return err(`B 站查询失败：排行榜(${rankingError?.message ?? rankingError})；热门(${popularError?.message ?? popularError})`);
              }
            }
            if (!videos.length) return err('B 站榜单接口没有返回任何视频');
            return ok({
              mode: 'hot',
              source,
              count: videos.length,
              videos: videos.map((v) => ({
                title: v.title,
                author: v.author,
                view: v.view,
                like: v.like,
                url: v.url
              })),
              note: '这些是当下 B 站的热门视频标题，可以挑眼熟的当谈资；别硬把不相干的视频扯进话题。'
            });
          }

          // ── 模式 ① 求证某个说法 ──
          const found = await lookupMemeOnBili(term);
          return ok({
            mode: 'lookup',
            term: found.term,
            exists: found.exists,
            evidence: found.evidence,
            suggestions: found.suggestions.map((s) => s.value),
            videos: found.videos.map((v) => ({
              title: v.title,
              author: v.author,
              view: v.view,
              like: v.like,
              url: v.url
            })),
            urls: found.urls,
            note: `${found.exists
              ? `B 站确实有人这么说（${found.evidence}），可以引用 urls 里的链接当出处。`
              : 'B 站没有找到明确证据。'}exists=false 时不要把这个说法当成已有梗去用；要记进梗库前先确认含义（结合群里的上下文，或直接问一句）。确认含义后可用 meme_note 记进梗库。`
          });
        } catch (error) {
          return err(`B 站查询失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'meme_note',
      description: '把学到的新梗记进梗知识库（群里刚出现、你搞懂了的梗；或者你想补充某个梗的用法）。字段尽量填全，尤其 useCases（什么场景能用）和 examples（范例句）—— 没有这两样的梗以后没法用。同一个梗名再记一次是"补充更新"，不会重复建条目。不确定含义的梗别记，记错了以后会一直用错。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '梗的名字（简短，如"美跳是区"）' },
          means: { type: 'string', description: '这个梗是什么意思（一两句）' },
          aliases: { type: 'array', items: { type: 'string' }, description: '别名/别的叫法' },
          kind: { type: 'string', description: 'game 游戏梗 | net 网梗 | group 群内黑话 | anime 二次元 | other' },
          source: { type: 'string', description: '出处（哪款游戏/哪场比赛/哪个主播）' },
          useCases: { type: 'array', items: { type: 'string' }, description: '适用场景（最重要的字段）' },
          examples: { type: 'array', items: { type: 'string' }, description: '范例句（希望自己怎么说）' },
          avoid: { type: 'string', description: '什么情况下别用' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（检索用）' },
          priority: { type: 'integer', description: '1~5，常用梗填 4~5，冷门填 2' },
          scope: { type: 'string', description: 'global = 所有会话都能用（默认）；chat = 只在这个会话用' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          const memes = ctx.memory?.memes;
          if (!memes) return err('梗知识库模块未加载');
          if (memes.enabled === false) return err('梗知识库未启用（设置 → 梗知识库）');
          if (getConfig().meme?.autoNote === false) {
            return err('管理员关闭了"模型自动记梗"（设置 → 梗知识库），这个梗请让管理员手动加');
          }
          const r = ctx.memory.addMeme({
            text: args.text,
            means: args.means,
            aliases: args.aliases,
            kind: args.kind,
            source: args.source,
            useCases: args.useCases,
            examples: args.examples,
            avoid: args.avoid,
            tags: args.tags,
            priority: args.priority,
            scope: args.scope === 'chat' ? 'chat' : 'global',
            chatKey: args.scope === 'chat' ? ctx.chatKey : '',
            origin: 'model'
          });
          if (!r.ok) return err(r.error);
          return ok({
            saved: true,
            merged: r.merged === true,
            id: r.entry.id,
            text: r.entry.text,
            note: r.merged ? '已补充更新这条梗。' : '已记进梗库。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'reverse_image_search',
      description: '以图搜图：拿一张图片去反查它的出处 / 找同款（更清晰的版本、原作品页）。三种用法：(1) messageId = 群里那条带图消息的 #数字（群友发图问"这图哪来的/有没有原图/这什么作品"时用这个）；(2) url = 图片直链；(3) index = 前面 search_image 结果里的编号。会同时查 iqdb（找同款与更高清版本）和 trace.moe（判断是不是动画截图、出自哪一集），如果管理员配了 SauceNAO key 还会精确给出 pixiv 作品号。查到的结果带相似度，相似度高的（≥85%）才可信；再把 pixiv 作品号交给 get_illust_detail 就能看到人气数据。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '带图消息的 QQ 消息 id（聊天记录里的 #数字）' },
          url: { type: 'string', description: '图片直链（http/https）' },
          index: { type: 'integer', description: '可选：前面 search_image 结果里的编号' },
          limit: { type: 'integer', description: '可选：最多返回几条结果，默认 6' }
        }
      },
      async execute(ctx, args) {
        try {
          const cfg = imageSearchConfigForChat(ctx.chatKey);
          if (!cfg.enabled) return err('搜图功能已关闭（设置 → 搜图服务）');
          // ── 找到要查的图 ──
          let url = String(args.url ?? '').trim();
          let fromMessage = null;
          if (!url && args.messageId !== undefined && args.messageId !== null && String(args.messageId).trim() !== '') {
            const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
            if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
            const img = (entry.media || []).find((m) => m.kind === 'image' && m.url);
            if (!img) return err(`消息 ${args.messageId} 里没有可用的图片地址（可能是表情或已过期）`);
            url = img.url;
            fromMessage = entry;
          }
          if (!url && args.index !== undefined && args.index !== null && String(args.index).trim() !== '') {
            const item = findHistoryItem(ctx.chatKey, args.index);
            if (!item) return err(`找不到编号 ${args.index} 的图，请先 search_image 或改用 messageId/url`);
            url = item.url;
          }
          if (!url) return err('请给 messageId（群友发的那条图）、url 或 index 之一');

          // ── 下载成字节（iqdb 要字节，trace.moe 要公网 URL）──
          const safeUrl = await validateImageUrl(url);
          const got = await downloadFirstAvailable([safeUrl], { maxBytes: 8 * 1024 * 1024 });
          const rev = await reverseImageSearch(got.buffer, {
            cfg,
            imageUrl: safeUrl,
            mime: got.mime,
            timeoutMs: Math.max(20000, Number(cfg.timeoutMs) * 2)
          });

          const limit = Math.min(10, Math.max(1, Number(args.limit) || 6));
          const picked = rev.items
            .filter((it) => !(it.rating === 'r18' && cfg.allowR18 !== true))
            .slice(0, limit);
          const notes = [];
          if (rev.backends.length) notes.push(`可用后端：${rev.backends.join(' / ')}`);
          if (!cfg.sauceNaoKey) notes.push('未配置 SauceNAO key，无法做"精确反查 pixiv 作品号"（设置 → 搜图服务里可填）');
          if (rev.errors.length) notes.push(`部分后端失败：${rev.errors.join('；').slice(0, 120)}`);
          if (!picked.length) {
            return ok({
              found: 0,
              note: `没查到匹配的出处${notes.length ? `（${notes.join('，')}）` : ''}。可能这张图不在公开图库里（原创/新图/AI 图/群内自摄），别硬编出处；可以换个说法告诉对方"没查到"，或者用 get_message_images 先看清图里是什么角色再按角色搜。`
            });
          }
          const lines = picked.map((it, i) => describeReverse(it, i + 1));
          return ok({
            found: picked.length,
            from: fromMessage ? `消息 ${fromMessage.mid}（${fromMessage.senderName || '群友'}发的）` : url.slice(0, 80),
            results: lines,
            note: `${notes.join('；')}。相似度 ≥85% 基本可以认定是同一张；只是"同款/相似"的别当成出处。查到 pixiv 作品号后用 get_illust_detail 看人气数据，再决定要不要 send_image 发原图。`
          });
        } catch (error) {
          return err(`以图搜图失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_illust_detail',
      description: '查一个 pixiv 作品的人气数据与可用画质（收藏数/点赞/浏览/尺寸）——判断"这张图好不好看、值不值得发"就靠它。用法：传 pixivId（作品号，从链接 artworks/数字 或反查结果里拿）。返回的 qualityNote 会说明能不能发原图。',
      parameters: {
        type: 'object',
        properties: {
          pixivId: { type: ['integer', 'string'], description: 'pixiv 作品号' }
        },
        required: ['pixivId']
      },
      async execute(ctx, args) {
        try {
          const cfg = imageSearchConfigForChat(ctx.chatKey);
          const detail = await pixivIllustDetail(String(args.pixivId ?? ''), { cookie: cfg.cookie, timeoutMs: cfg.timeoutMs });
          if (detail.rating === 'r18' && cfg.allowR18 !== true) {
            return err(`pixiv 作品 ${detail.id} 是 R18，当前不允许查看/发送`);
          }
          const pick = await pickBestImage({ ...detail }, cfg);
          return ok({
            id: detail.id,
            title: detail.title,
            author: detail.author,
            tags: (detail.tags || []).slice(0, 12),
            bookmarkCount: detail.bookmarkCount,
            likeCount: detail.likeCount,
            viewCount: detail.viewCount,
            size: `${detail.width}×${detail.height}`,
            pages: detail.pageCount,
            ai: detail.ai === true ? 'AI 生成' : (detail.ai === false ? '人工绘制' : '未知'),
            hasOriginal: Boolean(detail.original),
            qualityNote: detail.original
              ? `可以发原图（${pick.quality}，约 ${pick.sizeKb ? `${pick.sizeKb}KB` : '体积未知'}）`
              : '拿不到原图地址（多半是 R18 或需要登录）——想发原图要在设置里填 pixiv 登录 Cookie',
            pageUrl: detail.pageUrl,
            note: '收藏数越高说明越受欢迎（同人图里 1000+ 算热门，10000+ 是名作）。'
          });
        } catch (error) {
          return err(`查作品失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'list_stickers',
      description: '查看/搜索你的表情库。**强烈建议传 query 按含义/情绪搜**（如"无语""安慰""嘲笑""晚安""点赞"），会按相关度返回最贴切的几个；不传 query 则按备注完整度+使用次数列出。返回里 noteReady 表示这条有没有备注。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按含义/情绪/适用场景搜索（匹配备注/标签/情绪/用法）；不传则列出常用的' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    {
      name: 'list_unnoted_stickers',
      description: '列出还没有备注的表情（按使用次数排）。攒到一批时可以用它挑几个补备注 —— 备注好了以后挑表情才准。也可以看看都有哪些表情是你常用但没记过的。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '最多返回几条，默认 30' } }
      },
      async execute(ctx, args) {
        try {
          const list = ctx.stickers.unnoted(Math.min(100, Math.max(1, Number(args.limit) || 30)));
          return ok({ count: list.length, stickers: list, hint: '看到眼熟的可以用 sticker_note 补一句备注。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id' } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(args.stickerId);
          if (!sticker) return err(`找不到表情 ${args.stickerId}`);
          if (!sticker.url) return err('该表情没有图片地址');
          const dataUrl = await downloadImageAsDataUrl(sticker.url);
          return { content: imageParts(`表情 ${sticker.id}（当前备注：${sticker.localNote || sticker.desc || '无'}）。看完可以顺手用 sticker_note 记一下它是什么梗。：`, [dataUrl]) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    {
      name: 'sticker_note',
      description: '给一个表情写/改备注（你以后靠它挑表情，所以写得越具体越好）：note=这表情在表达什么，tags=关键词，moods=适合的情绪场合（如 无语/开心/生气/安慰/戏谑），usage=什么场景用，avoid=什么场景别用。建议每认识一个常用表情就记一条。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id' },
          note: { type: 'string', description: '这个表情的意思 / 在表达什么（主要依据）' },
          label: { type: 'string', description: '可选：给它起个短名字（默认用 note 开头几个字）' },
          tags: { type: 'array', items: { type: 'string' }, description: '关键词（可选）' },
          moods: { type: 'array', items: { type: 'string' }, description: '适合的情绪场合，如 ["无语","嘲讽"]（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' },
          avoid: { type: 'string', description: '什么场合别用（可选）' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.stickers.note(String(args.stickerId), {
            note: args.note,
            label: args.label,
            tags: args.tags,
            moods: args.moods,
            usage: args.usage,
            avoid: args.avoid
          });
          if (!entry) return err(`找不到表情 ${args.stickerId}`);
          return ok({ updated: true, id: entry.id, label: entry.label, localNote: entry.localNote, tags: entry.tags, moods: entry.moods });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库，并顺手写备注（收藏前先 get_message_images 看图确认是不是值得收藏）。note 写"这表情什么意思 + 什么场景用"，能大幅提高以后用得准的概率。同一条消息重复调用 = 补充/修改备注（此时不用再传图片地址，只补你这次想改的字段即可），不会重复收藏，也不会冲掉之前写好的标签/情绪。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别这个表情）' },
          label: { type: 'string', description: '可选：短名字' },
          tags: { type: 'array', items: { type: 'string' }, description: '关键词（可选）' },
          moods: { type: 'array', items: { type: 'string' }, description: '适合的情绪场合（可选）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!imageMedia) return err('该消息没有可收藏的图片');
          const saved = ctx.stickers.collect(args.messageId, {
            url: imageMedia.url,
            note: String(args.note ?? ''),
            label: String(args.label ?? ''),
            tags: Array.isArray(args.tags) ? args.tags : [],
            moods: Array.isArray(args.moods) ? args.moods : []
          });
          return ok({ collected: true, id: saved.id, label: saved.label, note: saved.localNote, tags: saved.tags, moods: saved.moods, noteHint: '以后用 list_stickers 传 query 就能按含义搜到它。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            target = Number(target);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : `${m.senderName || '某人'}(${m.senderId})`,
            senderId: m.self ? undefined : String(m.senderId || ''),
            text: m.text
          }))
        });
      }
    },
    {
      name: 'read_forward',
      description: '展开查看合并转发的聊天记录，并把转发里的图一并给你看（默认带图，最多 4 张）。消息文本出现 [合并转发聊天记录] 或 [转发消息 …] 占位符时用。参数填那条转发消息前的 #数字（千万别用方括号里那串长 id —— 那是内部用的 res_id，填进去会报 download forward message payload is empty）。只要文字不要图就传 withImages:false。展开结果会写回存档，以后再看就是展开的文本，不用重复调；之后想单独再看某几张图，也可以用 get_message_images 传同一个 #数字。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' },
          withImages: { type: 'boolean', description: '可选，默认 true：附上转发里的图片（最多 4 张；要看清内容就保持默认）。只想要文字时传 false' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          // 已展开（收消息时就展开过 / 之前展开过）→ 直接读存档，不再请求 QQ
          const fromArchive = String(entry.text || '').startsWith('[合并转发 共');
          let text = entry.text;
          let imageUrls = (entry.media || [])
            .filter((m) => m.kind === 'image' && m.url)
            .map((m) => m.url);
          if (!fromArchive) {
            // 传收消息时抓下来的 res_id，message_id 只作兜底。
            // ⚠️ 绝对不能只传负数 message_id：桥会把这个数字当 res_id 发给服务器，
            // 必报 retcode=100 "download forward message payload is empty"（见 onebot.js）。
            const { nodes } = await fetchForwardNodes(ctx.onebot, { resId: entry.forwardResId, mid: entry.mid });
            const ex = await expandForwardNodes(nodes);
            if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
            text = ex.text;
            imageUrls = (ex.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
            // 写回存档：一次展开，永久升级这条记录（模型/存档页都受益）
            ctx.store.updateByMid(ctx.chatKey, entry.mid, {
              text: ex.text,
              appendMedia: ex.media || [],
              forwardResId: entry.forwardResId || null
            });
          }
          return await forwardResult(ctx, {
            messageId: entry.mid,
            text,
            imageUrls,
            withImages: args.withImages,
            fromArchive
          });
        } catch (error) {
          return err(`展开失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : `${entry.senderName || '某人'}(${entry.senderId})`,
          senderId: entry.self ? undefined : String(entry.senderId || ''),
          text: entry.text,
          reply: entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用；合并转发展开之后，传那条转发自己的 #数字 也能看到转发里的图（read_forward 时没看全、或只要其中几张时用）。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
          if (!urls.length) {
            const hint = String(entry.text || '').includes('[合并转发')
              ? '（这是合并转发，先 read_forward 展开；展开后转发里的图会一起收进这条消息）'
              : '（表情包用 get_sticker_image；[语音]/[视频]/[文件] 这类占位符看不到内容）';
            return ok(`消息 ${args.messageId} 没有可查看的图片${hint}`);
          }
          // 上限同 read_forward 的理由：一条消息可能带几十张图，全塞进上下文会顶爆
          const picked = urls.slice(0, MESSAGE_MAX_IMAGES);
          const dataUrls = [];
          const failed = [];
          let chars = 0;
          for (const url of picked) {
            if (chars + FORWARD_MAX_IMAGE_CHARS > FORWARD_MAX_TOTAL_CHARS) break;
            try {
              const dataUrl = await downloadImageAsDataUrl(url);
              if (dataUrl.length > FORWARD_MAX_IMAGE_CHARS) { failed.push('过大'); continue; }
              chars += dataUrl.length;
              dataUrls.push(dataUrl);
            } catch (e) { failed.push(String(e?.message ?? e).slice(0, 40)); }
          }
          if (!dataUrls.length) return err(`图片获取失败：${failed.join('；') || '体积超限'}`);
          const parts = [];
          if (urls.length > dataUrls.length) parts.push(`共 ${urls.length} 张，只取了 ${dataUrls.length} 张`);
          if (failed.length) parts.push(`${failed.length} 张取不到或过大`);
          const note = parts.length ? `（${parts.join('；')}）` : '';
          return { content: imageParts(`消息 ${args.messageId} 的图片内容${note}：`, dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记一条对群友的长期印象（下次运行会自动看到）。只记"以后和这个人打交道时用得上"的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。userId 必须填对方的 QQ 号（不知道就先调 get_active_members / get_recent_messages 查）；target 填备注名/群名片/昵称，用于展示。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
          target: { type: 'string', description: '对方名字（备注名/群名片/昵称）' },
          content: { type: 'string', description: '印象内容（≤120字，稳定、可跨多次聊天使用）' }
        },
        required: ['category', 'userId', 'content']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。先用 get_active_members 查准确 QQ 号再记。`);
        }
        const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', String(args.content ?? ''), {
          userId,
          target: String(args.target ?? '').trim()
        });
        return ok({ saved: true, entry });
      }
    },
    {
      name: 'memory_query',
      description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
        }
      },
      async execute(ctx, args) {
        const mem = ctx.memory.query(ctx.chatKey);
        const userId = String(args.userId ?? '').trim();
        const list = userId
          ? mem.memberImpression.filter((e) => String(e.userId) === userId)
          : mem.memberImpression;
        return ok({ memberImpression: list });
      }
    },
    {
      name: 'memory_remove',
      description: '删除一条过时/不再准确的对群友印象。userId 优先按 QQ 号删；target 按名字删；两者都不传则删全部印象。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
          target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
          content: { type: 'string', description: '可选：只删这条内容' }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
          userId: String(args.userId ?? '').trim(),
          target: String(args.target ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
    },
    {
      name: 'memory_search',
      description: '主动回忆：跨群检索你记过的长期记忆（人物档案 + 长期事件）。想知道"这人我以前是不是见过/聊过什么""上次那个约定是啥""群里这个梗哪来的"就查它。不传 query 时可以按 userId 精确看某个人。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词（人名/话题/梗都行）。留空 = 只按 userId 与时间筛选' },
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号' },
          kind: { type: 'string', description: '可选：只看某类事件（promise 约定 / joke 梗 / grudge 恩怨 / topic 长期话题 / preference 偏好 / event 其他）' },
          days: { type: 'integer', description: '可选：只看最近 N 天内产生的记忆' },
          limit: { type: 'integer', description: '可选：返回条数上限（默认 12，最大 50）' }
        }
      },
      async execute(ctx, args) {
        const g = ctx.memory?.global;
        if (g?.enabled === false) return err('长期记忆未启用（设置 → 记忆里可以打开）');
        const found = ctx.memory.searchMemory({
          query: String(args.query ?? '').trim(),
          userId: String(args.userId ?? '').trim(),
          chatKey: ctx.chatKey,
          kinds: args.kind ? [String(args.kind)] : null,
          days: Number(args.days) || 0,
          limit: Number(args.limit) || 12
        });
        if (!found.total) return ok({ found: 0, note: '没有匹配的长期记忆。别硬编，就当没记过。' });
        // 命中即强化：被想起来的记忆更不容易淡忘（复习效应）
        try {
          g.reinforce({
            factIds: found.people.flatMap((p) => p.facts.map((f) => f.id)),
            eventIds: found.events.map((e) => e.id)
          });
        } catch { /* 强化失败不影响返回 */ }
        return ok({ found: found.total, people: found.people, events: found.events });
      }
    },
    {
      name: 'memory_note_event',
      description: '记一件"长期有效的事"：约定（答应了做什么）、梗（群里管X叫Y）、恩怨、某人正在长期纠结的事、稳定偏好。这类记忆由遗忘曲线管理，importance 越高记得越久。不要记一次性的临时闲聊。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一句话说清这件事（≤120 字，写"谁做了什么/是什么"，不要写成流水账）' },
          kind: { type: 'string', description: 'promise 约定 / joke 梗 / grudge 恩怨 / topic 长期话题 / preference 偏好 / event 其他（默认 event）' },
          scope: { type: 'string', description: 'chat = 只在这个会话有效（默认）；global = 跟人走，跨群都该记得（如某人的长期偏好）' },
          participants: { type: 'array', items: { type: ['integer', 'string'] }, description: '涉及的 QQ 号（可选，填了以后能按人检索）' },
          importance: { type: 'integer', description: '重要度 1~5，默认 3。约定/雷点/恩怨用 4~5；梗/闲聊用 2。4 及以上不会被遗忘曲线淘汰。' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        const g = ctx.memory?.global;
        if (g?.enabled === false) return err('长期记忆未启用');
        const text = String(args.text ?? '').trim();
        if (!text) return err('text 不能为空');
        const event = ctx.memory.noteEvent(ctx.chatKey, {
          text,
          kind: String(args.kind ?? 'event'),
          scope: args.scope === 'global' ? 'global' : 'chat',
          participants: Array.isArray(args.participants) ? args.participants : [],
          importance: Number(args.importance) || 3
        });
        if (!event) return err('记录失败（内容为空或长期记忆已被关闭）');
        return ok({ saved: true, id: event.id, kind: event.kind, scope: event.scope, importance: event.importance });
      }
    },
    {
      name: 'memory_forget',
      description: '删掉记错的/过时的长期记忆：事件传 eventId，人物事实传 userId + content。传 resolve=true 表示"这事翻篇了"——保留记录但不再主动提起。',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: '要删的事件 id（memory_search 返回过）' },
          userId: { type: ['integer', 'string'], description: '人物事实所属 QQ 号' },
          content: { type: 'string', description: '要删的那条事实原文（配合 userId 使用）' },
          resolve: { type: 'boolean', description: 'true = 不删除，只标记为已了结/翻篇' }
        }
      },
      async execute(ctx, args) {
        const g = ctx.memory?.global;
        if (g?.enabled === false) return err('长期记忆未启用');
        const eventId = String(args.eventId ?? '').trim();
        if (eventId) {
          const done = args.resolve === true ? g.resolveEvent(eventId) : g.forgetEvent(eventId);
          return ok({ ok: done, eventId, resolved: args.resolve === true });
        }
        const userId = String(args.userId ?? '').trim();
        const content = String(args.content ?? '').trim();
        if (!userId || !content) return err('请传 eventId，或同时传 userId 与 content');
        const removed = g.forgetFact(userId, { content });
        return ok({ ok: removed > 0, removed });
      }
    },
    {
      name: 'recall_recent',
      description: '查"这个人最近在别的地方说过什么"。想复述/接上某人在私聊或别的群刚说过的话时用它——比如有人私聊交代了一件事，你去群里自然地转达。默认查最近 10 分钟内的原话（表层记忆），也一并给长期记忆里相关的条目。传 userId 精确查某人，不传则看本次对话相关的人。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '要查的 QQ 号。留空 = 本次对话里涉及的成员' },
          query: { type: 'string', description: '可选：关键词。留空 = 只要"最近说的原话"' },
          includeLongTerm: { type: 'boolean', description: '是否同时查长期记忆（默认 true）' },
          limit: { type: 'integer', description: '返回条数上限（默认 8，最大 30）' }
        }
      },
      async execute(ctx, args) {
        const g = ctx.memory?.global;
        if (g?.enabled === false) return err('跨群记忆未启用（设置 → 记忆里可以打开）');
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 8));
        const uid = String(args.userId ?? '').trim();
        // 不指定人就查本次对话相关的人，避免把全库的人一股脑倒出来
        let targets = [];
        if (uid) {
          targets = [uid];
        } else if (typeof ctx.relevantUserIds === 'function') {
          targets = [...ctx.relevantUserIds()].map(String).filter(Boolean).slice(0, 6);
        }
        const recent = [];
        const seen = new Set();
        const pushRecent = (list) => {
          for (const s of list) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            recent.push(s);
          }
        };
        if (targets.length) {
          for (const t of targets) {
            pushRecent(ctx.memory.listSurface({ userId: t, chatKey: ctx.chatKey, limit }));
          }
        } else {
          pushRecent(ctx.memory.listSurface({ chatKey: ctx.chatKey, limit }));
        }
        recent.sort((a, b) => (b.at || 0) - (a.at || 0));

        const out = {
          recent: recent.slice(0, limit).map((s) => ({
            id: s.id,
            userId: s.userId,
            name: s.name || s.userId,
            from: s.chatKey === ctx.chatKey ? '本会话' : s.chatKey,
            text: s.text,
            minutesAgo: Math.max(0, Math.round((Date.now() - (s.at || Date.now())) / 60000)),
            note: '表层记忆，会过期。要长期留着就调 memory_promote'
          }))
        };
        if (args.includeLongTerm !== false) {
          const found = ctx.memory.searchMemory({
            query: String(args.query ?? '').trim(),
            userId: uid,
            chatKey: ctx.chatKey,
            limit
          });
          out.longTerm = { people: found.people, events: found.events, total: found.total };
        }
        if (!out.recent.length && !(out.longTerm?.total)) {
          return ok({ found: 0, note: '没查到最近说过的话。别硬编，就当不知道。' });
        }
        return ok({ found: (out.recent?.length || 0) + (out.longTerm?.total || 0), ...out });
      }
    },
    {
      name: 'memory_promote',
      description: '把一条"表层记忆"（recall_recent 返回的、某人最近说的原话）沉淀成长期记忆，这样它就不会随 10 分钟到期被清掉了。当某人交代的事以后还用得上（约定、长期偏好、要长期记住的梗）时用它。surfaceId 来自 recall_recent 或【刚刚在别处提到】里的 id。',
      parameters: {
        type: 'object',
        properties: {
          surfaceId: { type: 'string', description: '表层记忆 id' },
          text: { type: 'string', description: '可选：沉淀时的措辞（整理成一句话）。留空 = 用原话' },
          kind: { type: 'string', description: 'promise 约定 / joke 梗 / grudge 恩怨 / topic 长期话题 / preference 偏好 / event 其他（默认 event）' },
          importance: { type: 'integer', description: '重要度 1~5，默认 3。约定/雷点用 4~5（不会被遗忘曲线淘汰）。' },
          as: { type: 'string', description: 'event = 存成长期事件（默认）；fact = 存成那个人的长期事实' }
        },
        required: ['surfaceId']
      },
      async execute(ctx, args) {
        const g = ctx.memory?.global;
        if (g?.enabled === false) return err('跨群记忆未启用');
        const id = String(args.surfaceId ?? '').trim();
        if (!id) return err('surfaceId 不能为空');
        const item = ctx.memory.getSurface(id);
        if (!item) return err('没有找到这条表层记忆（可能已过期）');
        // 允许指定措辞：把口语原话整理成"事实句"，但内容必须来自原话
        const rewritten = String(args.text ?? '').trim();
        if (rewritten && rewritten !== item.text) {
          // 先按新措辞存进表层，再沉淀，保证 promote 走的是同一份数据
          const updated = g.addSurface({
            userId: item.userId, name: item.name, chatKey: item.chatKey, text: rewritten
          });
          if (updated) item.id = updated.id;
        }
        const r = ctx.memory.promoteSurface(item.id, {
          kind: String(args.kind ?? 'event'),
          importance: Number(args.importance) || 3,
          as: args.as === 'fact' ? 'fact' : 'event'
        });
        if (!r.ok) return err(`沉淀失败（${r.reason || '未知原因'}）`);
        return ok({ saved: true, as: r.kind, userId: item.userId, text: rewritten || item.text });
      }
    },
    {
      name: 'remind_at',
      description: '定一个定时提醒：到了那个时间点，系统会把你叫醒，你可以主动发消息提醒对方（哪怕群里没人说话）。别人说"提醒我""到点叫我""明天记得跟我说"时用它。时间必须自己算成绝对时间点：先看【当前时间】，再算出目标时刻，格式如 "2026-09-13 08:00"，也接受 "08:00"（下一个该时刻）或 "30分钟后"。不要传"明天早上"这种相对说法。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '到点要提醒的事，写成给他看的一句话（如"该吃药了"）' },
          when: { type: 'string', description: '绝对时间点："2026-09-13 08:00" / "08:00" / "30分钟后"' },
          note: { type: 'string', description: '可选：给未来的自己留一句背景（为什么定这个、跟谁有关），到点时你会看到' },
          repeat: {
            type: 'object',
            description: '可选：周期重复。kind=none 一次性（默认）/ daily 每天 / weekly 每周（可给 weekdays）/ interval 每隔一段时间（给 intervalMs，或 every+unit）',
            properties: {
              kind: { type: 'string', description: 'none | daily | weekly | interval' },
              weekdays: { type: 'array', items: { type: 'integer' }, description: 'weekly 用：1=周一 … 7=周日' },
              intervalMs: { type: 'integer', description: 'interval 用：间隔毫秒数' },
              every: { type: 'number', description: 'interval 用：数量（配合 unit）' },
              unit: { type: 'string', description: 'interval 用：m=分钟 h=小时 d=天' }
            }
          },
          toUserId: { type: ['integer', 'string'], description: '可选：到点私聊这个 QQ 号（必须是本会话里出现过的人）。不传就在当前聊天提醒。' },
          importance: { type: 'integer', description: '重要度 1~5，默认 3（只影响展示排序）' }
        },
        required: ['text', 'when']
      },
      async execute(ctx, args) {
        try {
          const store = ctx.memory?.reminders;
          if (!store) return err('提醒模块未加载');
          if (store.enabled === false) return err('定时提醒功能已关闭（设置 → 记忆 → 定时提醒）');
          const text = String(args.text ?? '').trim();
          if (!text) return err('text 不能为空（写清楚到点要提醒什么）');
          const parsed = parseWhen(args.when);
          if (!parsed.ok) return err(parsed.error);
          const maxAhead = Date.now() + 366 * 86400000;
          if (parsed.at > maxAhead) return err('时间定得太远了（超过一年），先定个近一点的');

          // 目标会话：默认当前会话；指定了人就发私聊（但那人必须在本会话近期发过言）
          let targetChatKey = ctx.chatKey;
          let targetName = '';
          const toRaw = String(args.toUserId ?? '').trim();
          if (toRaw) {
            const uid = Number(toRaw);
            if (!Number.isInteger(uid) || uid <= 0) {
              return err(`toUserId 必须是数字 QQ 号（收到：${JSON.stringify(args.toUserId)}）。${memberHint(ctx)}`);
            }
            const known = ctx.store.activeMembers(ctx.chatKey, 30).find((m) => String(m.userId) === String(uid));
            if (!known) {
              return err(`在这个会话里没见过 ${uid}，不能给他定私聊提醒（防止乱发骚扰消息）。${memberHint(ctx)}`);
            }
            if (getConfig().reminder?.allowPrivateTarget === false) {
              return err('管理员关闭了"私聊提醒"，只能在当前会话提醒');
            }
            targetChatKey = `private:${uid}`;
            targetName = known.name || String(uid);
          }

          const trig = Array.isArray(ctx.session?.trigger) ? ctx.session.trigger.filter((m) => !m.self) : [];
          const last = trig[trig.length - 1] || null;
          const res = ctx.memory.createReminder({
            text,
            note: String(args.note ?? '').trim(),
            dueAt: parsed.at,
            chatKey: targetChatKey,
            targetUserId: toRaw ? Number(toRaw) : '',
            targetName,
            creatorId: last?.senderId || ctx.selfId || '',
            creatorName: last?.senderName || '',
            repeat: args.repeat || null,
            importance: Number(args.importance) || 3,
            source: 'model'
          });
          if (!res.ok) return err(res.error);
          const when = new Date(res.item.dueAt);
          const pad = (n) => String(n).padStart(2, '0');
          const mins = Math.round((res.item.dueAt - Date.now()) / 60000);
          return ok({
            scheduled: true,
            id: res.item.id,
            at: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`,
            inMinutes: mins,
            repeat: repeatLabel(res.item.repeat),
            where: targetChatKey === ctx.chatKey ? '当前会话' : `私聊 ${targetName || targetChatKey}`,
            note: '到点系统会叫醒你，届时用你自己的语气主动发消息；现在不用再说什么。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'remind_list',
      description: '查看你定过的定时提醒（默认只看当前会话）。别人问"你不是说要提醒我吗""我让你提醒我啥来着"时用它，别凭印象编。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'chat = 只看当前会话（默认）；all = 看全部（含别处定的）' },
          status: { type: 'string', description: '可选：pending 待触发 / done 已完成 / canceled 已取消 / missed 错过' }
        }
      },
      async execute(ctx, args) {
        try {
          const store = ctx.memory?.reminders;
          if (!store) return err('提醒模块未加载');
          const all = String(args.scope ?? 'chat') === 'all';
          const list = store.list({
            chatKey: all ? '' : ctx.chatKey,
            status: String(args.status ?? '') || 'pending,running',
            limit: 30
          });
          if (!list.length) return ok({ count: 0, note: '当前没有符合条件的提醒。' });
          const pad = (n) => String(n).padStart(2, '0');
          return ok({
            count: list.length,
            reminders: list.map((e) => {
              const d = new Date(e.dueAt);
              return {
                id: e.id,
                text: e.text,
                at: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
                repeat: repeatLabel(e.repeat),
                where: e.chatKey === ctx.chatKey ? '这里' : e.chatKey,
                status: e.status
              };
            })
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'remind_cancel',
      description: '取消一条定时提醒（对方说"不用提醒我了""取消刚才那个"时用）。id 从 remind_list 拿，不要自己编。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '提醒 id（remind_at 返回的 id，或 remind_list 里的 id）' } },
        required: ['id']
      },
      async execute(ctx, args) {
        try {
          const store = ctx.memory?.reminders;
          if (!store) return err('提醒模块未加载');
          const item = store.get(String(args.id ?? '').trim());
          if (!item) return err('找不到这条提醒（先用 remind_list 看看真实 id）');
          if (item.chatKey !== ctx.chatKey && String(item.creatorId || '') !== String(ctx.selfId || '')) {
            // 跨会话取消要留个门槛：只允许取消"当前会话里定下的"或 id 完全正确且状态待触发
            if (item.status !== 'pending') return err('这条提醒不属于当前会话，且已经不在待触发状态，不能取消');
          }
          const r = store.cancel(item.id);
          if (!r.ok) return err(r.error);
          return ok({ canceled: true, id: item.id, text: item.text });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'style_note',
      description: '记一条"这个群里的人是怎么说话的"观察，用于让自己的说话方式更像他们（如"他们夸人爱说 6"、"看到抽象图一般回 ？"）。只在确实观察到稳定规律时用，别记具体八卦。kind=speech 说话逻辑 / kind=reaction 图片表情反应。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'speech 说话逻辑 | reaction 图片/表情反应' },
          text: { type: 'string', description: '一句话规律（≤40字，写"怎么说"而不是"说了什么"）' },
          confidence: { type: 'number', description: '可选：把握程度 0~1，默认 0.7' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          const style = ctx.memory?.style;
          if (!style || !style.enabled) return err('风格学习未开启（设置 → 记忆 → 真人说话风格学习）');
          const kind = String(args.kind ?? 'speech') === 'reaction' ? 'reactions' : 'speech';
          const r = style.addItem(kind, String(args.text ?? ''), {
            confidence: Number(args.confidence) || 0.7,
            source: 'model'
          });
          if (!r.ok) return err(r.error);
          return ok({ saved: true, kind: r.kind, result: r.result });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'web_search',
      description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const result = await webSearch(String(args.query ?? ''));
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          return ok(result);
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const result = await webFetch(String(args.url ?? ''));
          const body = String(result.body || '');
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > 20000,
            content: body.slice(0, 20000)
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    }
  ];
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
