// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import { OneBotClient } from './onebot.js';
import { getConfig } from './config.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
  stickerStats, listUnnoted, stickerLabel, searchStickers
} from './stickers.js';

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        this.entries = mergeStickerLibrary(this.entries, fetched);
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  /**
   * 按含义/情绪挑一个最合适发送的表情（不触发同步，用当前内存快照）。
   * 有 query 时按相关度打分，无命中就返回 null（调用方再决定要不要看全部）。
   */
  pickBest(query = '') {
    const candidates = searchStickers(this.entries, query, 5);
    if (!candidates?.length) return null;
    // searchStickers 返回的是精简 item，需要回查完整条目（含 url）
    const top = candidates[0];
    return this.entries.find((e) => e.id === top.id) || null;
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  /** 表情库概况（控制台展示用）。 */
  stats() {
    return stickerStats(this.entries);
  }

  /** 还没写备注的表情（控制台"待备注"清单 / 引导模型补备注）。 */
  unnoted(limit = 200) {
    return listUnnoted(this.entries, limit);
  }

  /** 按 id 直接取（不触发同步）——控制台编辑用。 */
  peek(ref) {
    return findSticker(this.entries, ref);
  }

  /**
   * 删除一条表情（只删本地库条目；QQ 收藏那边不受影响，下次同步可能又回来）。
   * 主要用于清理"收藏错了/重复的"本地条目。
   */
  remove(ref) {
    const target = findSticker(this.entries, ref);
    if (!target) return { ok: false, error: '找不到这个表情' };
    this.entries = this.entries.filter((e) => e.id !== target.id);
    saveStickerStore(this.entries);
    return { ok: true, removed: { id: target.id, label: stickerLabel(target) } };
  }

  /** 手动新增一条本地表情（不依赖 QQ 收藏）。 */
  add({ url, label = '', note = '', tags = [], moods = [], usage = '', source = 'manual' } = {}) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('需要一个 http(s) 图片地址');
    const id = `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      id,
      resId: id,
      url: u,
      md5: '',
      desc: String(label || '').slice(0, 40),
      label: String(label || '').slice(0, 24),
      localNote: String(note || ''),
      tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 20) : [],
      moods: Array.isArray(moods) ? moods.map(String).filter(Boolean).slice(0, 12) : [],
      usage: String(usage || ''),
      avoid: '',
      source,
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    saveStickerStore(this.entries);
    return entry;
  }

  /**
   * 收藏一条消息里的图片到本地表情库（不入 QQ 收藏）。
   *
   * 支持三种来源：
   *   1. 模型自己看中（collect_sticker 工具，走 messageId + note）
   *   2. 管理员控制台手动贴 URL（url 直传）
   *   3. 被收藏过再补备注（同 messageId 二次调用 = 更新备注，不再新增）
   */
  collect(messageId, { url, note = '', tags = [], moods = [], label = '', usage = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    const useId = String(messageId ?? '').trim();
    if (!useId) throw new Error('缺少消息 id');
    url = String(url || '');
    // 已收藏过 → 本次视为"补充备注"，不重复入库、也不占限频额度。
    // ⚠️ 这个判断必须在"url 必填"校验**之前**：二次调用是模型回头补一句备注，
    //    它通常只传 messageId + note，不会再传图片地址（也没必要）；
    //    旧实现先校验 url，于是"补充备注"永远抛错，备注功能形同虚设（真实 bug）。
    const id = `collected_${useId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      // 只把**本次确实提供**的字段传下去，空值不覆盖旧值（applyStickerNote 也做了这层保护）
      return this.note(id, {
        note: note || undefined,
        label: label || undefined,
        usage: usage || undefined,
        tags: Array.isArray(tags) && tags.length ? tags : undefined,
        moods: Array.isArray(moods) && moods.length ? moods : undefined
      });
    }
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    // 限频只在真正新增时生效
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    const entry = {
      id,
      resId: id,
      url,
      md5: '',
      desc: String(label || note || '').slice(0, 40),
      label: String(label || '').slice(0, 24),
      localNote: String(note || ''),
      tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 20) : [],
      moods: Array.isArray(moods) ? moods.map(String).filter(Boolean).slice(0, 12) : [],
      usage: String(usage || ''),
      avoid: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    return entry;
  }
}
