// 用量统计和新会话共用的模型渠道标识。历史会话沿用当时记录的 vendor。
export const UNKNOWN_VENDOR = '未知渠道';

export function vendorOfConfig(cfg) {
  const api = cfg?.api || {};
  const base = String(api.baseUrl || '').trim();
  const providers = Array.isArray(cfg?.providers) ? cfg.providers : [];
  const norm = (url) => String(url || '').replace(/\/+$/, '');
  const match = (api.provider && providers.find((p) => p?.id === api.provider))
    || (base && providers.find((p) => p?.baseURL && norm(p.baseURL) === norm(base)));
  if (match?.displayName) return String(match.displayName);
  if (base) {
    try { return new URL(base).host; } catch { /* 无法从地址推断渠道 */ }
  }
  return null;
}

export function modelLabel(vendor, model) {
  return `${String(vendor || '').trim() || UNKNOWN_VENDOR}：${String(model || '').trim() || '(未知模型)'}`;
}

export function splitModelLabel(label) {
  const value = String(label || '');
  const index = value.indexOf('：');
  return index > 0
    ? { vendor: value.slice(0, index), model: value.slice(index + 1) }
    : { vendor: '', model: value };
}
