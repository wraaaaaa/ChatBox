// 群友印象记忆：每个会话一个文件夹，每个群友一个以 QQ 号命名的 JSON 文件。
// 目录结构：
//   data/memory/group_<群号>/<QQ>.json
//   data/memory/private_<QQ>/<QQ>.json
// 每个成员文件：{ userId, name, impressions: [{ content, createdAt }], updatedAt, lastConsolidatedAt }
// 旧版单文件 data/memory/group_<群号>.json 会在首次访问时自动迁移。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';
import { GlobalMemoryStore } from './memory-global.js';
import { ReminderStore, describeReminder } from './reminders.js';
import { StyleStore } from './style-learn.js';
import { MemeStore, memeConfig } from './meme-store.js';
import { memoryChat } from './memory-llm.js';
import { currentMemoryKey } from './persona-store.js';
import { writeJsonAtomic } from './util.js';

// 记忆根目录不再是常量：它跟着「当前人设」走。
// 每个人设一棵独立的目录树（data/memory/<memoryKey>/），
// 于是"两个人设的记忆不会互相影响"是文件系统层面的事实，而不是靠过滤保证的。
function memRoot() {
  return path.join(DATA_DIR, 'memory', currentMemoryKey());
}

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function legacyFile(chatKey) {
  return path.join(memRoot(), `${chatDirName(chatKey)}.json`);
}

function chatDir(chatKey) {
  return path.join(memRoot(), chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function memberFile(chatKey, userId, name = '') {
  return path.join(chatDir(chatKey), memberFileName(userId, name));
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

function loadMember(chatKey, userId, name = '') {
  const file = memberFile(chatKey, userId, name);
  const raw = readJson(file, null);
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    impressions: Array.isArray(raw?.impressions) ? raw.impressions : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0
  };
}

function loadMeta(chatKey) {
  const raw = readJson(metaFile(chatKey), null);
  return { lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0 };
}

export class MemoryStore {
  constructor() {
    this.cache = new Map(); // chatKey -> Map(userId|_n_xx, member)
    this.cachePersona = null;   // 缓存属于哪个人设；切换人设时整份丢弃
    // 跨群聊长期记忆（人物档案 + 长期事件）。与本地印象解耦存放：
    // 本地文件坏了跨群层照常工作，反之亦然。
    this.global = new GlobalMemoryStore();
    // 定时提醒：同样住在 _global/ 下（跟人设走），但自成一份文件，
    // 坏掉/删掉都不影响人物档案与长期事件。
    this.reminders = new ReminderStore();
    // 真人说话风格学习：_style/ 目录，样本 + 蒸馏产物。
    this.style = new StyleStore({ chat: (messages, opts) => memoryChat(messages, opts) });
    // 梗知识库：_global/memes/ 目录，管理员手工维护 + 模型补充的梗。
    this.memes = new MemeStore();
    try { this.memes.ensureDocs(); } catch { /* 目录不可写不影响运行 */ }
  }

  /** 扫描所有有记忆的会话（文件夹或旧版单文件）。 */
  listChats() {
    const pk = currentMemoryKey();
    if (pk !== this.cachePersona) {
      this.cachePersona = pk;
      this.cache.clear();
    }
    const out = new Set();
    try {
      for (const f of fs.readdirSync(memRoot())) {
        if (fs.statSync(path.join(memRoot(), f)).isDirectory()) {
          const m = /^(group|private)_(\d+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        } else {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  /** 旧版单文件 → 新版每成员文件。迁移后旧文件移到 backups/。 */
  #migrateLegacy(chatKey) {
    const legacy = legacyFile(chatKey);
    if (!fs.existsSync(legacy)) return;
    try {
      if (fs.statSync(legacy).isDirectory()) return;
      const old = readJson(legacy, null);
      if (!old) return;
      const notes = getConfig().memberNotes || {};
      const nameToQq = {};
      for (const [qq, name] of Object.entries(notes)) {
        if (name) nameToQq[String(name)] = String(qq);
      }
      const migrated = [];
      for (const e of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
        if (!e?.content) continue;
        const target = String(e.target || '').trim();
        let userId = /^\d{5,15}$/.test(target) ? target : (nameToQq[target] || '');
        migrated.push({
          userId,
          name: target,
          content: String(e.content).slice(0, 300),
          createdAt: Number(e.createdAt) || Date.now()
        });
      }
      // 旧的 activeTopic/pendingThought 直接丢弃（本版只保留群友印象）
      for (const m of migrated) this.#appendRaw(chatKey, m.userId, m.name, m.content, m.createdAt);
      const backupDir = path.join(memRoot(), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, path.basename(legacy));
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(legacy, backup);
    } catch (error) {
      console.error('[memory] 旧记忆迁移失败:', error?.message ?? error);
    }
  }

  #ensureChat(chatKey) {
    // 人设换了 → 之前缓存的是另一个人设的记忆，必须整份丢掉重读
    const pk = currentMemoryKey();
    if (pk !== this.cachePersona) {
      this.cachePersona = pk;
      this.cache.clear();
    }
    this.#migrateLegacy(chatKey);
    if (!this.cache.has(chatKey)) {
      const map = new Map();
      try {
        for (const f of fs.readdirSync(chatDir(chatKey))) {
          if (!f.endsWith('.json') || f === '_meta.json') continue;
          const raw = readJson(path.join(chatDir(chatKey), f), null);
          if (!raw) continue;
          const key = raw.userId ? String(raw.userId) : `_n_${f}`;
          map.set(key, loadMember(chatKey, raw.userId, raw.name));
        }
      } catch { /* 尚无文件夹 */ }
      this.#mergeNameDuplicates(chatKey, map);
      this.cache.set(chatKey, map);
    }
    return this.cache.get(chatKey);
  }

  /**
   * 合并"同一个人被存成两份"的历史数据。
   *
   * 背景：早期没有 QQ 号时会按名字落文件（_n_xxx.json）。后来拿到 QQ 号再次写入时，
   * 会新建 <QQ>.json，但旧的 _n_ 文件不会被清理 → 同一个人在记忆里出现两次，
   * 印象重复、整理时互相干扰，也让"印象总数"虚高。
   *
   * 规则：无 QQ 号的条目，只要有同名（且该名字对应的条目有 QQ 号），
   * 就把它的印象并入该 QQ 号条目，然后删除 _n_ 文件。
   */
  #mergeNameDuplicates(chatKey, map) {
    const nameToId = new Map();
    for (const m of map.values()) {
      const uid = String(m.userId || '').trim();
      const nm = String(m.name || '').trim();
      if (uid && nm) nameToId.set(nm, uid);
    }
    const toDelete = [];
    for (const [key, m] of map.entries()) {
      const uid = String(m.userId || '').trim();
      if (uid) continue;                       // 已有 QQ 号，不是兜底条目
      const nm = String(m.name || '').trim();
      const targetId = nameToId.get(nm);
      if (!targetId) continue;
      const target = map.get(targetId);
      if (!target) continue;

      const seen = new Set(target.impressions.map((e) => e.content));
      let added = 0;
      for (const e of m.impressions) {
        if (seen.has(e.content)) continue;
        seen.add(e.content);
        target.impressions.push({ ...e });
        added += 1;
      }
      if (added) {
        target.impressions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(m.updatedAt) || 0);
        writeJson(memberFile(chatKey, targetId, target.name), target);
      }
      // 删除已被并入的兜底文件
      try { fs.rmSync(memberFile(chatKey, '', nm), { force: true }); } catch { /* ignore */ }
      toDelete.push(key);
      console.log(`[memory] 合并重复记忆：${nm}（无 QQ 号）→ ${targetId}，并入 ${added} 条`);
    }
    for (const k of toDelete) map.delete(k);
  }

  #appendRaw(chatKey, userId, name, content, createdAt = Date.now()) {
    const map = this.#ensureChat(chatKey);
    const key = userId ? String(userId) : `_n_${memberFileName('', name)}`;
    const member = map.get(key) || loadMember(chatKey, userId, name);
    const entry = {
      content: String(content ?? '').slice(0, 300),
      createdAt: Number(createdAt) || Date.now()
    };
    if (!member.impressions.some((e) => e.content === entry.content)) {
      member.impressions.push(entry);
    }
    member.userId = String(userId ?? member.userId ?? '');
    member.name = String(name || member.name || '');
    member.updatedAt = Date.now();
    writeJson(memberFile(chatKey, userId, name), member);
    map.set(key, member);
    return entry;
  }

  /** 记一条对群友的印象。extra: { userId, target, importance, pinned } */
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId ?? '').trim();
    const target = String(extra.target ?? '').trim().slice(0, 60);
    if (!userId && !target) return null;
    const entry = this.#appendRaw(chatKey, userId, target || userId, content);
    // 写穿到跨群档案：同一个人在任何群被记下，别的群也能认出来。
    const before = this.getMember(chatKey, userId).impressions.map((e) => e.content);
    this.#mirrorToGlobal(chatKey, userId, target || userId, before, { importance: extra.importance });
    return entry;
  }

  /**
   * 把本会话对某人的印象同步进跨群档案。
   * contents 传「本会话最终承认的全部印象」——由全局层负责收回已删除的部分，
   * 所以调用方不需要区分新增/删除。
   */
  #mirrorToGlobal(chatKey, userId, name, contents, { importance = 3 } = {}) {
    try {
      if (this.global?.enabled === false) return;
      const uid = String(userId ?? '').trim();
      // 没有 QQ 号就无法跨群对齐 —— 而"同一个号"正是跨群记忆的前提
      if (!/^\d{1,15}$/.test(uid)) return;
      const list = (Array.isArray(contents) ? contents : [contents])
        .map((c) => String(c ?? '').trim())
        .filter(Boolean);
      this.global.syncChatFacts(uid, list, { name, chatKey, importance });
    } catch (error) {
      console.warn('[memory] 同步跨群档案失败:', error?.message ?? error);
    }
  }

  /** 所有成员的印象（扁平列表，兼容旧消费方）。 */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const map = this.#ensureChat(chatKey);
    const memberImpression = [];
    for (const m of map.values()) {
      for (const e of m.impressions) {
        memberImpression.push({
          userId: String(m.userId || ''),
          target: String(m.name || m.userId || '某人'),
          content: e.content,
          createdAt: e.createdAt
        });
      }
    }
    memberImpression.sort((a, b) => b.createdAt - a.createdAt);
    return { memberImpression };
  }

  /** 成员级视图（记忆页签用）。 */
  members(chatKey) {
    const map = this.#ensureChat(chatKey);
    const list = [];
    for (const m of map.values()) {
      if (!m.impressions.length) continue;
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 单个成员的印象（含空成员）。 */
  getMember(chatKey, userId) {
    const map = this.#ensureChat(chatKey);
    const m = map.get(String(userId)) || loadMember(chatKey, String(userId));
    return {
      userId: String(m.userId || userId || ''),
      name: String(m.name || ''),
      impressions: (m.impressions || []).map((e) => ({ ...e })),
      updatedAt: Number(m.updatedAt) || 0
    };
  }

  /** 编辑群友印象（管理端）：QQ 号由调用方提供，自动回填名字，保存备注到配置。 */
  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    const entries = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const member = {
      userId: uid,
      name: finalName,
      impressions: entries,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    /*
     * 写穿跨群档案：管理端"编辑群友印象"保存时必须同步，
     * 否则本地改成 0 条了，别的群还在注入被删掉的那几条（与 remove() 同族的漏网）。
     */
    this.#mirrorToGlobal(chatKey, uid, finalName, member.impressions.map((e) => e.content));
    // 备注写入配置 memberNotes
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt,
      note: String(note ?? '').trim()
    };
  }

  /** 手动替换某成员的全部印象（管理端编辑用）。返回更新后的成员。 */
  replaceMember(chatKey, userId, name, contents) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const member = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    // 单个成员替换也备份原文件（保留最近一次）
    try {
      const backupDir = path.join(memRoot(), 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    this.#mirrorToGlobal(chatKey, uid, finalName, impressions.map((e) => e.content));
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt
    };
  }

  /** 删除某成员的印象文件。 */
  removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    const map = this.#ensureChat(chatKey);
    const m = map.get(uid) || loadMember(chatKey, uid);
    map.delete(uid);
    try { fs.rmSync(memberFile(chatKey, uid, m.name), { force: true }); } catch { /* ignore */ }
    // 只收回「本会话」的贡献；别的群还记得这个人就继续留着（跨群档案不该被单群删除连带清空）
    this.#mirrorToGlobal(chatKey, uid, m.name, []);
    return true;
  }

  remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;
    const map = this.#ensureChat(chatKey);
    let removed = false;
    // 删完要写穿跨群档案，所以先记下"这次动过谁"，循环结束后统一同步。
    // 漏了这一步的后果很具体：本地删干净了，别的群还会被注入这条已经删掉的印象
    // （"明明删了它怎么还记得"就是这么来的）。
    const touched = new Map();   // uid -> { name, contents }
    for (const [key, m] of [...map.entries()]) {
      if (userId) {
        if (String(m.userId) === String(userId)) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
          touched.set(String(m.userId), { name: m.name, contents: m.impressions.map((e) => e.content) });
        }
      } else if (target) {
        const matchName = String(target).trim();
        if (String(m.name || m.userId) === matchName) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
          touched.set(String(m.userId), { name: m.name, contents: m.impressions.map((e) => e.content) });
        }
      }
    }
    // 写穿：内容为空 = 让全局层收回这个人在本会话来源下的全部事实
    for (const [uid, info] of touched) this.#mirrorToGlobal(chatKey, uid, info.name, info.contents);
    return removed;
  }

  clear(chatKey) {
    const map = this.#ensureChat(chatKey);
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    writeJson(metaFile(chatKey), { lastConsolidatedAt: Date.now() });
  }

  /** 管理界面清除当前人设在指定聊天中产生的全部印象。 */
  removeChat(chatKey) {
    const dir = chatDir(chatKey);
    const old = legacyFile(chatKey);
    if (!fs.existsSync(dir) && !fs.existsSync(old)) return false;
    const members = this.members(chatKey);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    if (fs.existsSync(old)) fs.unlinkSync(old);
    this.cache.delete(chatKey);
    for (const member of members) {
      if (member.userId) this.#mirrorToGlobal(chatKey, member.userId, member.name, []);
    }
    return true;
  }

  /**
   * 生成提示词里的【对群友的印象】摘要。
   * opts.userIds 提供时只包含这些成员（相关成员注入，控制 token）。
   */
  formatForPrompt(chatKey, { userIds = null } = {}) {
    const notes = getConfig().memberNotes || {};
    const all = this.members(chatKey);
    if (!all.length) return '';
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))  // 无 QQ 号的旧数据始终带上
      : all.slice(0, 15);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      for (const e of m.impressions.slice(-3)) lines.push(`- ${who}：${e.content}`);
    }
    return lines.join('\n');
  }

  // ── 跨群聊长期记忆（委托 memory-global.js）──

  /**
   * 生成【跨群档案】+【长期记忆】注入文本。
   * 分工：本地印象负责"这个群里我认识谁"，这里负责"别的群里我知道什么" + "长期有效的事"。
   */
  formatGlobalForPrompt(chatKey, { userIds = null, maxChars = 0, chatLabeler = null } = {}) {
    try {
      if (this.global?.enabled === false) return '';
      return this.global.formatForPrompt(chatKey, { userIds, maxChars, chatLabeler });
    } catch (error) {
      console.warn('[memory] 生成跨群记忆失败:', error?.message ?? error);
      return '';
    }
  }

  /** 记一条长期事件（约定/梗/恩怨/长期话题/偏好）。 */
  noteEvent(chatKey, payload = {}) {
    try {
      if (this.global?.enabled === false) return null;
      return this.global.noteEvent({ chatKey, ...payload });
    } catch (error) {
      console.warn('[memory] 记录长期事件失败:', error?.message ?? error);
      return null;
    }
  }

  /** 跨群检索（memory_search 工具的后端）。 */
  searchMemory(opts = {}) {
    const empty = { query: '', people: [], events: [], total: 0 };
    try {
      if (this.global?.enabled === false) return empty;
      return this.global.search(opts);
    } catch (error) {
      console.warn('[memory] 检索长期记忆失败:', error?.message ?? error);
      return empty;
    }
  }

  globalStats() {
    try { return this.global?.stats?.() ?? null; } catch { return null; }
  }

  // ── 表层记忆（刚说过的话，限时跨群可见）──
  //
  // 与长期记忆的区别：长期记忆要"沉淀"（写进去就慢慢淡出），
  // 表层记忆是缓存（默认 10 分钟到期即删），但**立刻**任何会话都能查到 ——
  // 这样"私聊问完，另一个群马上能复述"才成立。

  /** 记一句表层记忆。没有 QQ 号或空文本时静默跳过（不阻塞聊天主流程）。 */
  observeSurface({ chatKey, userId, name = '', text, at = 0 } = {}) {
    try {
      if (this.global?.enabled === false) return null;
      return this.global.addSurface({ chatKey, userId, name, text, at });
    } catch (error) {
      console.warn('[memory] 记录表层记忆失败:', error?.message ?? error);
      return null;
    }
  }

  /** 查表层记忆（crossOnly=true 时只要"别的会话"的，用于跨群复述）。 */
  listSurface(opts = {}) {
    try {
      if (this.global?.enabled === false) return [];
      return this.global.listSurface(opts);
    } catch (error) {
      console.warn('[memory] 查询表层记忆失败:', error?.message ?? error);
      return [];
    }
  }

  getSurface(id) {
    try {
      if (this.global?.enabled === false) return null;
      return this.global.getSurface(id);
    } catch { return null; }
  }

  /** 手动/自动把一条表层记忆沉淀为长期记忆。 */
  promoteSurface(id, opts = {}) {
    try {
      if (this.global?.enabled === false) return { ok: false, reason: 'disabled' };
      return this.global.promoteSurface(id, opts);
    } catch (error) {
      console.warn('[memory] 沉淀表层记忆失败:', error?.message ?? error);
      return { ok: false, reason: 'error' };
    }
  }

  removeSurface(id) {
    try {
      if (this.global?.enabled === false) return false;
      return this.global.removeSurface(id);
    } catch { return false; }
  }

  // ── 定时提醒（委托 reminders.js）──

  /**
   * 生成【你定下的提醒】+【没赶上的提醒】注入文本。
   *
   * 副作用说明：被写进提示词的"漏掉的提醒"会在这里标记为已提示 ——
   * 它只该被自然提起一次，否则每次聊天都要道歉一遍。提示词构建是
   * 一次运行里只发生一次的动作，所以在这里落地是安全的。
   */
  formatRemindersForPrompt(chatKey, { now = Date.now() } = {}) {
    const store = this.reminders;
    if (!store || store.enabled === false) return '';
    const cfg = getConfig().reminder || {};
    const parts = [];
    if (cfg.injectUpcoming !== false) {
      const up = store.upcoming(chatKey, { limit: Math.max(1, Number(cfg.injectMax) || 3), now });
      if (up.length) {
        parts.push(`【你定下的提醒】还没到点（到点会由系统叫醒你，现在不用做什么）：\n${
          up.map((e) => `- ${describeReminder(e, now)}`).join('\n')}`);
      }
    }
    if (cfg.missedNoteInPrompt !== false) {
      const missed = store.missedNotes(chatKey, { limit: 3 });
      if (missed.length) {
        parts.push(`【没赶上的提醒】这几条到点时你不在线（应用没开），没发出去。聊天自然的话可以补一句抱歉+提醒，别硬插：\n${
          missed.map((e) => `- ${describeReminder(e, now)}`).join('\n')}`);
        store.ackMissed(missed.map((e) => e.id));
      }
    }
    return parts.join('\n\n');
  }

  /** 新建提醒（工具与控制台共用）。 */
  createReminder(payload = {}) {
    try {
      if (!this.reminders) return { ok: false, error: '提醒模块未加载' };
      return this.reminders.create(payload);
    } catch (error) {
      console.warn('[memory] 新建提醒失败:', error?.message ?? error);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 实时触发一条提醒（控制台"立即提醒"用）。 */
  fireReminderNow(id) {
    try {
      const item = this.reminders?.get(id);
      if (!item) return { ok: false, error: '找不到这条提醒' };
      return this.reminders.update(id, { dueAt: Date.now(), status: 'pending' });
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // ── 真人说话风格（委托 style-learn.js）──

  /** 采集一条风格样本（app.js 的 ingestMessage 调用）。 */
  observeStyle(input) {
    try {
      if (!this.style || !this.style.enabled) return null;
      return this.style.observe(input);
    } catch (error) {
      console.warn('[memory] 风格采样失败:', error?.message ?? error);
      return null;
    }
  }

  /** 【群里的说话方式】注入文本。 */
  formatStyleForPrompt(chatKey, opts = {}) {
    try {
      if (!this.style || !this.style.enabled) return '';
      return this.style.formatForPrompt(chatKey, opts);
    } catch (error) {
      console.warn('[memory] 生成风格参考失败:', error?.message ?? error);
      return '';
    }
  }

  styleStats() {
    try { return this.style?.stats?.() ?? null; } catch { return null; }
  }

  // ── 梗知识库（委托 meme-store.js）──
  // 与长期记忆的分工：memory_note_event 记的是"群里发生过的事"（谁跟谁玩什么梗、
  // 有什么恩怨），由遗忘曲线管理；梗库记的是"这个梗本身怎么用"，
  // 由管理员维护、永不过期、带适用场景与范例句。

  /** 【梗知识库】注入文本（按语境挑相关的几条）。 */
  formatMemesForPrompt(chatKey, opts = {}) {
    try {
      if (!this.memes || memeConfig().enabled !== true) return '';
      return this.memes.formatForPrompt(chatKey, opts);
    } catch (error) {
      console.warn('[memory] 生成梗库参考失败:', error?.message ?? error);
      return '';
    }
  }

  /** 检索梗（meme_search 工具的后端）。 */
  searchMemes(query, opts = {}) {
    try {
      if (!this.memes) return [];
      return this.memes.search(query, opts);
    } catch (error) {
      console.warn('[memory] 检索梗库失败:', error?.message ?? error);
      return [];
    }
  }

  /** 记一条梗（meme_note 工具/控制台共用）。 */
  addMeme(payload = {}) {
    try {
      if (!this.memes) return { ok: false, error: '梗库模块未加载' };
      if (memeConfig().enabled !== true) return { ok: false, error: '梗知识库未启用（设置 → 梗知识库）' };
      const r = this.memes.add(payload);
      if (r.ok && r.entry && !r.merged) {
        try { this.memes.ensureDocs(); } catch { /* ignore */ }
      }
      return r;
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 校验"模型自记的梗"是否需要人工确认（后续可扩展，现在直接落库）。 */
  memeStats() {
    try { return this.memes?.stats?.() ?? null; } catch { return null; }
  }

  listMemes(opts = {}) {
    try { return this.memes?.list?.(opts) ?? []; } catch { return []; }
  }

  markMemeUsed(id, context = '') {
    try { return this.memes?.markUsed?.(id, context) ?? null; } catch { return null; }
  }

  // ── 自动整理（consolidation）──

  consolidationState(chatKey) {
    const map = this.#ensureChat(chatKey);
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of map.values()) {
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt: loadMeta(chatKey).lastConsolidatedAt || lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  /**
   * 记录一次整理完成的时间。
   * 同时写会话级 _meta.json（供冷却判断）与各成员文件的 lastConsolidatedAt。
   * userIds 为空时只更新会话级时间。
   */
  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    try {
      fs.mkdirSync(chatDir(chatKey), { recursive: true });
      const prev = readJson(metaFile(chatKey), {}) || {};
      writeJson(metaFile(chatKey), { ...prev, lastConsolidatedAt: Number(at) || Date.now() });
    } catch (error) {
      console.warn('[memory] 写整理时间失败:', error?.message ?? error);
    }
    const map = this.#ensureChat(chatKey);
    for (const uid of userIds || []) {
      const key = String(uid ?? '').trim();
      if (!key) continue;
      const m = map.get(key);
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(memberFile(chatKey, m.userId, m.name), m); } catch { /* ignore */ }
    }
  }

  /**
   * 用整理结果整体替换本会话的印象（按成员写回各自文件）。
   * next.memberImpression: [{ userId?, target?, content }]
   */
  replaceConsolidated(chatKey, next) {
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    const groups = new Map(); // key -> { userId, name, contents }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const content = cut(item?.content, 300);
      if (!content) continue;
      const userId = cut(item?.userId, 40) || '';
      const name = cut(item?.target, 60) || userId;
      const key = userId || `_n_${memberFileName('', name)}`;
      if (!groups.has(key)) groups.set(key, { userId, name, contents: [] });
      groups.get(key).contents.push(content);
    }
    const map = this.#ensureChat(chatKey);
    // 整理前把整个会话文件夹备份到 data/memory/backups/<会话>/（保留最近一次）
    try {
      const backupDir = path.join(memRoot(), 'backups', chatDirName(chatKey));
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.mkdirSync(backupDir, { recursive: true });
      for (const m of map.values()) {
        const src = memberFile(chatKey, m.userId, m.name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
      }
      const metaSrc = metaFile(chatKey);
      if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, path.join(backupDir, '_meta.json'));
    } catch { /* 备份失败不阻塞整理 */ }
    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    for (const g of groups.values()) {
      for (const content of g.contents) {
        this.#appendRaw(chatKey, g.userId, g.name, content, now);
      }
      const file = memberFile(chatKey, g.userId, g.name);
      const member = loadMember(chatKey, g.userId, g.name);
      member.lastConsolidatedAt = now;
      member.updatedAt = now;
      writeJson(file, member);
      map.set(g.userId || `_n_${memberFileName('', g.name)}`, member);
    }
    writeJson(metaFile(chatKey), { lastConsolidatedAt: now });
    // 整理结论同步进跨群档案：在 A 群整理出的印象，B 群也能用上。
    for (const g of groups.values()) {
      if (!g.userId) continue;
      this.#mirrorToGlobal(chatKey, g.userId, g.name, g.contents);
    }
    const totalAfter = [...map.values()].reduce((n, m) => n + m.impressions.length, 0);
    return { memberImpression: groups.size ? this.query(chatKey).memberImpression : [], count: totalAfter };
  }
}
