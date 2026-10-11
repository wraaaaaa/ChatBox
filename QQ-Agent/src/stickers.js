// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './util.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    // localNote = AI/管理员写的"这个表情在说什么"，是选表情时最主要依据。
    localNote: String(entry.localNote ?? '').trim(),
    // label：人类可读的简称，给列表/目录用；没有就退回 desc/note 的首段。
    label: String(entry.label ?? '').trim().slice(0, 24),
    tags,
    usage: String(entry.usage ?? '').trim(),
    // mood/emotion：适合什么情绪场合（开心/无语/生气/安慰…），专供按语境检索。
    moods: Array.isArray(entry.moods)
      ? entry.moods.map((m) => String(m ?? '').trim()).filter(Boolean).slice(0, 12)
      : [],
    // avoid：什么场合别用（防止在严肃话题甩表情），会一起注入提示词。
    avoid: String(entry.avoid ?? '').trim().slice(0, 160),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

/** 一条表情的"可读名字"：label > desc > note 首段 > id 短码。 */
export function stickerLabel(entry) {
  if (!entry) return '';
  const direct = String(entry.label || '').trim();
  if (direct) return direct;
  const desc = String(entry.desc || '').trim();
  if (desc) return desc;

  const note = String(entry.localNote || '').trim();
  if (note) return note.length > 12 ? `${note.slice(0, 12)}…` : note;
  const id = String(entry.id || '');
  return id ? `表情${id.slice(-6)}` : '未命名表情';
}

/**
 * 选出"和当前语境最贴切"的表情。
 *
 * 为什么需要它：以前给模型的是"按使用次数排序的前 N 个"，它在聊 A 话题时
 * 看到的却是聊天记录的常客 —— 挑选只能靠撞运气。这里改成按语境打分：
 *   label/desc 命中 > tags/moods > note/usage > avoid
 * 与 meme-store 的 scoreRelevance 同思路，权重按"这个字段有多像语境描述"来定。
 */
export function scoreStickerRelevance(entry, tokens) {
  const bag = tokens && tokens.words ? tokens : { words: new Set(), chars: new Set() };
  if (!bag.words.size && !bag.chars.size) return 0;
  const norm = (s) => String(s ?? '').toLowerCase();
  const nameText = norm(`${stickerLabel(entry)} ${entry.desc}`);
  const midText = norm([...(entry.tags || []), ...(entry.moods || [])].join(' '));
  const bodyText = norm([entry.localNote, entry.usage].join(' '));
  let score = 0;
  for (const w of bag.words) {
    if (nameText.includes(w)) score += 6;
    else if (midText.includes(w)) score += 4;
    else if (bodyText.includes(w)) score += 2;
  }
  return score;
}

/** 中文按字切、英文数字按词切 —— 与 meme-store 同款、够用且零依赖。 */
const STICKER_NOISE_CHARS = '的了是我你他她它们在有和就都也还很太要不要会能可能这个那个什么怎么为以及与其但而且所以如果因为被把让给对从到向跟同跟吃喝玩做说想来看去到过着过啊吧呢吗呀哦噢嗯哈呵嘿唉诶咦哇啦咯喔嘛呗了下上中前后点卖买天气时候现在今天明天昨天一天一起一点一个一样一直一下儿自己别人家人东西南北大小多少好坏了完开过来回去出进对错真假新旧快慢高低长短冷热'.split('');

export function tokenizeStickerText(text) {
  const s = String(text ?? '').toLowerCase();
  const words = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) words.add(w);
  for (const w of s.match(/[\u4e00-\u9fa5]{2,4}/g) || []) words.add(w);
  const chars = new Set();
  for (const ch of s.replace(/[^\u4e00-\u9fa5]/g, '')) {
    if (!STICKER_NOISE_CHARS.includes(ch)) chars.add(ch);
  }
  return { words, chars };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  writeJsonAtomic(file, entries, 2);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      // 本地认知层（label/note/tags/moods/avoid/usage）一律以本地为准 ——
      // 同步 QQ 收藏时绝不能把 AI 或管理员写下的备注冲掉。
      label: old?.label || '',
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      moods: old?.moods || [],
      avoid: old?.avoid || '',
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

/**
 * 列出/搜索表情。
 *
 * 检索范围**包含备注、标签、情绪、适用场景** —— 所以模型可以直接用"无语"
 * "安慰"这种说法找到对的表情，而不是只能靠 desc 里那几个字碰运气。
 * 有 query 时按相关度排序；无 query 时按 备注完整度 → 使用次数 排序。
 */
export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim();
  const max = Math.max(1, Math.min(500, Number(limit) || 48));

  const toItem = (e) => ({
    id: e.id,
    label: stickerLabel(e),
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    moods: e.moods || [],
    usage: e.usage || '',
    avoid: e.avoid || '',
    useCount: e.useCount || 0,
    noteReady: Boolean(e.localNote || e.usage || e.tags?.length)
  });

  if (!q) {
    const sorted = [...list].sort((a, b) => {
      const na = a.localNote ? 1 : 0;
      const nb = b.localNote ? 1 : 0;
      return nb - na || (b.useCount || 0) - (a.useCount || 0);
    });
    return {
      total: list.length,
      matched: sorted.length,
      truncated: sorted.length > max,
      stickers: sorted.slice(0, max).map(toItem)
    };
  }

  const lower = q.toLowerCase();
  const tokens = tokenizeStickerText(q);
  const scored = [];
  for (const e of list) {
    const haystack = [e.label, e.desc, e.localNote, e.usage, e.avoid, e.id, e.resId, e.md5,
      ...(e.tags || []), ...(e.moods || [])].join(' ').toLowerCase();
    // 整串命中（"无语"直接出现在备注里）优先，其次按分词相关度
    const exact = haystack.includes(lower) ? 100 : 0;
    const rel = scoreStickerRelevance(e, tokens);
    const score = exact + rel;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.e.useCount || 0) - (a.e.useCount || 0));
  return {
    total: list.length,
    matched: scored.length,
    truncated: scored.length > max,
    query: q,
    stickers: scored.slice(0, max).map((x) => toItem(x.e))
  };
}

/**
 * 提示词里的【可用表情包】摘要。
 *
 * 改进点（相对于"按使用次数取前 N 个"）：
 *   1. 有备注/标签的表情优先 —— 模型能看懂它是什么意思，才敢用；
 *   2. 有 contextText 时按当前话题相关度挑，给出"这批最可能用得上"的表情；
 *   3. 明确告诉模型"没备注的可以看图确认"，并附上 list_stickers 的检索用法。
 * 不暴露完整 URL，控制上下文体积。
 */
export function buildStickerContext(entries, max = 10, { contextText = '' } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  const top = Math.max(1, Math.min(30, Number(max) || 10));

  const ready = list.filter((e) => e.localNote || e.usage || e.tags?.length);
  const bare = list.filter((e) => !ready.includes(e));

  let picked;
  if (contextText && String(contextText).trim()) {
    const tokens = tokenizeStickerText(contextText);
    picked = [...list]
      .map((e) => ({ e, score: scoreStickerRelevance(e, tokens) + (e.localNote ? 1 : 0) }))
      .sort((a, b) => b.score - a.score
        || (b.e.useCount || 0) - (a.e.useCount || 0))
      .slice(0, top)
      .map((x) => x.e);
  } else {
    picked = [...ready].sort((a, b) => (b.useCount || 0) - (a.useCount || 0)).slice(0, top);
    if (picked.length < top) picked.push(...bare.slice(0, top - picked.length));
  }

  const lines = picked.map((e) => {
    const label = stickerLabel(e);
    const note = e.localNote && e.localNote !== label ? `：${e.localNote}` : '';
    const extra = [...(e.tags || []), ...(e.moods || [])].slice(0, 4).join('/');
    const use = e.usage ? ` 场景：${e.usage}` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '';
    const noNote = !e.localNote && !e.usage ? '（无备注，用前建议先看图）' : '';
    return `- ${label}${note}${extra ? ` [${extra}]` : ''}${use}${used}${noNote}`;
  });

  const readyCount = ready.length;
  const head = `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个（其中 ${readyCount} 个有备注），`
    + `下面是${contextText ? '和当前话题较相关的' : '常用/有备注的'} ${picked.length} 个：`;
  const tail = '要用别的：list_stickers 传 query（按含义/情绪/场景搜，如"无语""安慰""嘲笑"），'
    + '不确定某个表情什么梗就先 get_sticker_image 看图再决定。';
  return `${head}\n${lines.join('\n')}\n${tail}`;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint(level = 1) {
  // 活跃度引导放在系统提示的策略段里（而不是"本次输入"的【表情包用法】）——
  // 同一主题两处引导会左右脑互搏（历史调整）：策略讲时机、档位讲频率，
  // 合并成一处由档位直接改写频率行。
  // ⚠️ 索引严格对应 0~3 档，与 ui 的 STICKER_LEVELS 一致。
  const freqByLevel = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '频率：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
    '频率：你是表情包爱好者——能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。'
  ][Math.min(3, Math.max(0, Number(level) || 0))];
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    `- ${freqByLevel}`,
    '- 选择：**先用 list_stickers 按含义/情绪去搜**（如"无语""安慰""大笑"），挑备注/标签对得上语境的；',
    '  没有备注、不确定什么梗的表情，先 get_sticker_image 看图再决定，绝对不要瞎发。',
    '- 备注习惯：看到一个自己会用、但还没有备注的表情（列表里标着"无备注"），用 sticker_note 记一句',
    '  "这表情在表达什么 + 适合什么场景"（例如 note="狗头保命，反讽/开玩笑时用"、moods=["戏谑"]）。',
    '  备注是给未来的你看的，比 QQ 自带的糊描述有用得多 —— 攒够备注，你挑表情才准。',
    '- 发送：用 send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 send_message 作为单独气泡发出，再单独发表情。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  // 注意"空值语义"：patch 里没传（undefined）当然保留旧值；但**空串/空数组**也要视为
  // "本次没提供"，保留旧值。原因是 collect_sticker 二次调用（补充备注）时，工具层会把
  // 未填的 tags/moods 默认成 []、label 默认成 ''——若按"空值 = 清空"处理，第二次
  // 只补一句 note 就会把上一次写好的标签/情绪/简称全部冲掉（真实 bug，已回归）。
  // 确实想清空某个字段时，用 patch.clear = ['tags','label',...] 显式声明（控制台走这条）。
  const clear = new Set(Array.isArray(patch.clear) ? patch.clear.map(String) : []);
  // 字符串字段：传了非空串才覆盖；显式 clear 才清空。
  const str = (key, v, prev) => {
    if (clear.has(key)) return '';
    return v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : prev;
  };
  // 数组字段：传了非空数组才覆盖；显式 clear 才清空。
  const arr = (key, v, prev, cap) => {
    if (clear.has(key)) return [];
    return Array.isArray(v) && v.length > 0
      ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, cap)
      : prev;
  };
  const next = normalizeStickerEntry({
    ...target,
    // label：人类可读简称（列表/目录展示用）
    label: str('label', patch.label, target.label).slice(0, 24),
    // note/localNote：这个表情的意思/在说什么 —— 选表情的主要依据
    localNote: str('note', patch.note, target.localNote),
    // desc 也允许显式覆盖（QQ 自带的描述常常很糊，管理员想改就改）
    desc: str('desc', patch.desc, target.desc),
    tags: arr('tags', patch.tags, target.tags, 20),
    moods: arr('moods', patch.moods ?? patch.emotions, target.moods, 12),
    usage: str('usage', patch.usage, target.usage),
    avoid: str('avoid', patch.avoid, target.avoid).slice(0, 160),
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

/**
 * 按语境/关键词给表情排序，供"挑一个最合适的发"使用。
 * @returns {Array} 按相关度排序的表情条目（无 query 时按备注完整度+使用次数）
 */
export function searchStickers(entries, query = '', limit = 10) {
  return formatStickerList(entries, query, limit).stickers;
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

/** 表情库概况（控制台展示：有多少备注好了、哪些还是空白）。 */
export function stickerStats(entries) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  let noted = 0;
  let tagged = 0;
  let used = 0;
  let totalUse = 0;
  for (const e of list) {
    if (e.localNote || e.usage) noted += 1;
    if (e.tags?.length || e.moods?.length) tagged += 1;
    if (e.useCount > 0) used += 1;
    totalUse += e.useCount || 0;
  }
  return { total: list.length, noted, tagged, used, totalUse, blank: list.length - noted };
}

/** QQ 同步来的 desc 常常是空/糊的；导出给控制台"待备注"清单用。 */
export function listUnnoted(entries, limit = 200) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  return list
    .filter((e) => !e.localNote && !e.usage)
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
    .map((e) => ({ id: e.id, label: stickerLabel(e), desc: e.desc, useCount: e.useCount || 0 }));
}
