// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig, DEFAULT_CONFIG } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { downloadImageBuffer } from './image-search.js';

// 直链被 QQ 下载失败时（外链防盗链/过期签名/被墙），本地拉取转 base64 重发。
// 与 tools.js 里 send_image 的兜底同思路；send_sticker 原先没有这层，导致
// 一张源 URL 返回 400 的表情就能让整轮回复失败（表现成"只思考不回复"）。
const DOWNLOAD_FAIL_RE = /download failed|retcode=100|HTTP (400|401|403|404|502|503)/i;
async function trySendAsBase64(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  try {
    const { buffer } = await downloadImageBuffer(String(url), { maxBytes: 4 * 1024 * 1024 });
    return `base64://${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;

export class SendQueue {
  constructor({ onebot, store, onSent = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    // 回退值必须与 config.js 的默认值一致（80）。此前这里是 8，
    // 配置缺失/为 0 时限频突然收紧 10 倍，行为不可预测。
    if (minute.length >= Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE)) {
      throw new Error(`发送频率超限（每分钟最多 ${cfg.maxPerMinute || DEFAULT_MAX_PER_MINUTE} 条），请等一会再发`);
    }
    if (hour.length >= Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR)) {
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of list) {
      const plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该在 QQ 里看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      const gap = this.#gap(text, isLast);
      promises.push(chain(async () => {
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        const data = await this.onebot.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        });
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text, ts, mid: data?.message_id ?? null });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') sent.push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else failed.push({ index: i, text: parts[i], error: String(r.reason?.message ?? r.reason) });
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      if (sent.length === 0) throw new Error(detail);
      console.warn(`[sender] 部分发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed };
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const sendOpts = {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      };
      const rec = (mid) => {
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts, mid: mid ?? null });
        this.onSent?.({ chatKey, text: `[表情包]`, messageId: mid ?? null, sticker: sticker.id });
      };
      try {
        const data = await this.onebot.sendSticker(kind, id, sticker.url, sendOpts);
        rec(data?.message_id);
        return { message_id: data?.message_id ?? null };
      } catch (error) {
        // 直链被 QQ 下载失败（外链防盗链/过期签名/被墙）→ 本地转 base64 再发一次
        if (DOWNLOAD_FAIL_RE.test(String(error?.message ?? error))) {
          const b64 = await trySendAsBase64(sticker.url);
          if (b64) {
            const data = await this.onebot.sendSticker(kind, id, b64, sendOpts);
            rec(data?.message_id);
            return { message_id: data?.message_id ?? null };
          }
        }
        throw error;
      }
    });
  }

  /**
   * 发送一张图片（搜图功能的出口）。独立气泡，一条消息一张图。
   *
   * 发送策略由调用方决定（见 tools.js 的 send_image）：
   *   - 'url'    ：把公网直链交给 OneBot，由 QQ 服务端去抓（省流量，但外链可能被墙/防盗链）
   *   - 'base64' ：本地下载后内联发送（一定能发出去，代价是多传一份数据）
   * options: { replyToMessageId, atUserId, summary }
   */
  sendImage(chatKey, source, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') return Promise.reject(new Error(`非法会话 key：${chatKey}`));
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(500, 1200)); // 发图前也留一点真人节奏
      const sendOpts = {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null,
        summary: options.summary ?? ''
      };
      const file0 = String(source.file || '');
      const label = String(options.label || '图片').slice(0, 80);
      const rec = (mid) => {
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text: `[图片:${label}]`, ts, mid: mid ?? null });
        this.onSent?.({ chatKey, text: `[图片:${label}]`, messageId: mid ?? null });
      };
      try {
        const data = await this.onebot.sendImage(kind, id, file0, sendOpts);
        rec(data?.message_id);
        return { message_id: data?.message_id ?? null };
      } catch (error) {
        // 直链被 QQ 下载失败（外链防盗链/过期签名/被墙）→ 本地转 base64 再发一次
        if (DOWNLOAD_FAIL_RE.test(String(error?.message ?? error))) {
          const b64 = await trySendAsBase64(file0);
          if (b64) {
            const data = await this.onebot.sendImage(kind, id, b64, sendOpts);
            rec(data?.message_id);
            return { message_id: data?.message_id ?? null };
          }
        }
        throw error;
      }
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      await sleep(randInt(300, 900));
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }
}
