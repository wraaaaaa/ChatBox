// 群管理员指令：管理员在群里发「禁言 / 解除」，机器人就地静默或恢复。
//
// 为什么需要它（用户原始需求）：
//   用户希望"像人一样"地被喊停：管理员在群里说一句「禁言」，机器人就闭嘴；
//   说「解除」就恢复正常。区别于群禁言（mutedGroups，控制台开关、整群硬禁），
//   这套是**群内指令式**的，而且禁言期间**被 @ 时仍要回一句固定话术**——
//   不能装死（群友会以为号被踢了）。
//
// 与 mutedGroups 的关系：
//   · 管理员指令禁言 → 写入同一个 mutedGroups（复用"绝不触发运行"的硬闸门），
//     但额外打上 `by: 'admin'` 与 `admin: true` 标记，并带上 manageUntil / 固定话术。
//   · 控制台禁言 → by: 'console'，不带 admin 标记（不触发固定话术）。
//   这样"省 token 的闸门"只有一处，语义差异靠标记区分。
//
// 存储：config.admin = { enabled, admins: { [群号]: 管理员QQ号 }, muteReply: 固定话术 }
//       config.mutedGroups[群号] = { at, until, reason, by, admin }
import { getConfig, updateConfig } from './config.js';

/** 归一化群号 / QQ 号：只接受数字。 */
function normId(id) {
  const s = String(id ?? '').trim();
  return /^\d{1,15}$/.test(s) ? s : '';
}

/** 默认固定话术（管理员没自定义时用）。 */
export const DEFAULT_MUTE_REPLY = '（已禁言，暂时不说话啦，等管理员喊解除～）';

/** 指令词表：宽容一点，允许带标点/语气词，但仍要求"整句就是在下指令"。 */
const MUTE_WORDS = ['禁言', '闭嘴', '别说话', '安静', '静默'];
const UNMUTE_WORDS = ['解除', '解除禁言', '解禁', '解除静默', '可以说话了', '恢复'];

/**
 * 从一句话里识别是不是"禁言 / 解除"指令。
 *
 * 判定原则：**严格**。因为误判会导致机器人莫名其妙闭嘴（或更糟：把一句正常
 * 闲聊当成解除指令）。所以要求：
 *   1) 去掉 @占位符、CQ 码、空白、标点后，整句**等于**某个指令词；
 *      或整句 = 指令词 + 最多 2 个字的语气词（"禁言吧""解除一下"）。
 *   2) 不接受"长篇里夹着禁言"（那多半是在讨论禁言，不是在命令）。
 *
 * @returns {{cmd:'mute'|'unmute'}|null}
 */
export function parseAdminCommand(text) {
  let s = String(text ?? '');
  // 去掉 CQ 码（@机器人 / 图片等）与 [@xxx] 占位符
  s = s.replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/\[@[^\]]*\]/g, ' ')
    .replace(/\[图片\]|\[表情\]|\[语音\]|\[视频\]|\[文件\]|\[卡片消息\]/g, ' ');
  // 去所有空白与常见标点/语气标点
  s = s.replace(/[\s，。！？!?~～、,.：:；;"'“”‘’()（）]/g, '');
  if (!s) return null;

  const tail = /^(?:吧|啊|呀|哈|呗|哦|了|一下|下|啦|嘛){0,2}$/;   // 允许的尾巴（最多两段）
  const match = (words) => words.some((w) => s === w || (s.startsWith(w) && tail.test(s.slice(w.length))));

  // ⚠️ 顺序要紧：「解除禁言」既以"解除"开头，也不以"禁言"开头（"解除"在前），
  //    所以先判解除，不会误判成禁言。
  if (match(UNMUTE_WORDS)) return { cmd: 'unmute' };
  if (match(MUTE_WORDS)) return { cmd: 'mute' };
  return null;
}

/** 该群设定的管理员 QQ（没设返回空串）。 */
export function adminOf(groupId) {
  const gid = normId(groupId);
  if (!gid) return '';
  const admins = getConfig().admin?.admins || {};
  return normId(admins[gid]) || '';
}

/** 管理员功能是否启用（默认启用）。 */
export function adminEnabled() {
  return getConfig().admin?.enabled !== false;
}

/** 某人是不是该群的管理员（未配置管理员时一律不是）。 */
export function isAdmin(groupId, userId) {
  if (!adminEnabled()) return false;
  const gid = normId(groupId);
  const uid = normId(userId);
  if (!gid || !uid) return false;
  const admins = getConfig().admin?.admins || {};
  if (normId(admins[gid]) === uid) return true;
  // 全局管理员（admins['*']）对所有群生效
  return normId(admins['*']) === uid;
}

/** 禁言期间被 @ 时回复的固定话术。 */
export function muteReplyText() {
  const t = String(getConfig().admin?.muteReply ?? '').trim();
  return t || DEFAULT_MUTE_REPLY;
}

/** 设置/清除某群管理员（userId 为空 = 清除）。groupId 传 '*' = 全局管理员。 */
export function setAdmin(groupId, userId) {
  const rawGid = String(groupId ?? '').trim();
  // '*' 是"全局管理员"约定的键，不是群号；其余必须归一化成数字群号。
  const gid = rawGid === '*' ? '*' : normId(rawGid);
  if (!gid) return { ok: false, error: '群号必须是数字（或 * 表示全局）' };
  const uid = String(userId ?? '').trim();
  const all = { ...(getConfig().admin?.admins || {}) };
  if (!uid) delete all[gid];
  else {
    if (!normId(uid)) return { ok: false, error: 'QQ 号必须是数字' };
    all[gid] = uid;
  }
  // deepMerge 只增不删 → 映射型字段必须整体替换（见 config.js 的 __replace__ 约定）
  updateConfig({ admin: { admins: { __replace__: all } } });
  return { ok: true, groupId: gid, admin: all[gid] || '' };
}

/** 列出所有群管理员。 */
export function listAdmins() {
  const admins = getConfig().admin?.admins || {};
  return Object.entries(admins)
    .map(([groupId, userId]) => ({ groupId, userId: String(userId) }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
}
