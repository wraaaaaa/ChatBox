// OpenAI 兼容 Chat Completions 客户端（非流式）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { getConfig, updateConfig } from './config.js';
import { usesOpenAIResponses, chatResponses } from './openai-responses.js';
import {
  shouldApplyCache, applyPromptCache,
  hasCacheControl, cloneBodyWithoutCache
} from './prompt-cache.js';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** POST /chat/completions（抽出成函数，供"去掉思考参数重试"复用）。 */
function doFetch(api, body, signal) {
  return fetch(joinUrl(api.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(api.apiKey) },
    body: JSON.stringify(body),
    signal
  });
}

function hasThinkingParams(body) {
  return Boolean(body.thinking || body.reasoning_effort || body.reasoning || body.enable_thinking !== undefined);
}

/** 消息里是否存在非文本内容（图片等）。没有的话，"只接受 text" 这类 400 与图片无关，不该走图片兜底。 */
function hasNonTextParts(messages) {
  for (const m of messages || []) {
    if (Array.isArray(m?.content) && m.content.some((p) => p && p.type && p.type !== 'text')) return true;
  }
  return false;
}

/**
 * 摘掉消息里的图片内容，把 content 降级成纯文本（发给不支持图片的模型时必须）。
 * 摘的时候补一句说明，避免模型顺着"请直接看图"的上下文编造自己看到了什么。
 */
function stripImageParts(messages) {
  return (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    if (!m.content.some((p) => p && p.type && p.type !== 'text')) return m;
    const text = m.content.filter((p) => p?.type === 'text').map((p) => String(p.text ?? '')).join('\n').trim();
    const notice = '（注意：当前模型不支持图片输入，附带的图片已被省略。不要声称自己看到了图片内容；要发图就用工具按编号发。）';
    return { ...m, content: text ? `${text}\n${notice}` : notice };
  });
}

/**
 * 解析当前 api 配置里真正该用的 API Key。
 *
 * 优先级：**当前选中的目录提供商的 Key > 顶层 api.apiKey**。
 *
 * 注意顺序很重要：api.apiKey 是手动模式遗留字段，一旦用户在 UI 里选了某个
 * 目录提供商，就该用它对应的 Key。否则会出现「选了 openrouter，却拿着 a6api 的
 * Key 去请求 openrouter.ai」的情况 —— 表现为全部会话 401 Missing Authentication。
 *
 * 兼容历史数据：providers[].apiKey 也可能存有明文（老配置），也认。
 */
export function resolveApiKey(cfg) {
  const pid = String(cfg?.api?.provider ?? '').trim();
  if (pid) {
    const fromDsh = String(cfg?.dshProviderKeys?.[pid] ?? '').trim();
    if (fromDsh && fromDsh !== '******') return fromDsh;
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    const legacy = String(p?.apiKey ?? '').trim();
    if (legacy && legacy !== '******') return legacy;
  }
  const direct = String(cfg?.api?.apiKey ?? '').trim();
  return direct === '******' ? '' : direct;
}

/** 返回一个 key 已解析好的 api 配置（不影响配置本体）。 */
function effectiveApi() {
  const cfg = getConfig();
  return { ...cfg.api, apiKey: resolveApiKey(cfg) };
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试（多半是暂时性的，再试一次可能就好）：
 *   - 网络层失败 / 超时 / 连接被重置
 *   - HTTP 5xx（服务端出问题）
 *   - HTTP 429（限流，等一会儿再来）
 *   - 响应解析失败（偶发的空响应/截断）
 *
 * 不重试（重试也不会变好，只会浪费额度）：
 *   - HTTP 4xx：401 密钥错、400 请求体错、403 无权限、404 模型不存在
 *   - 主动中止（abort）
 */
export function isRetryableError(error) {
  const msg = String(error?.message ?? error ?? '');

  // 主动中止（用户/系统取消）：重试没有意义
  if (/aborted|中止|已取消|cancel/i.test(msg)) return false;

  // 明确的客户端错误：重试也不会变好，只会白烧额度
  if (/HTTP\s*(401|400|403|404|405|409|413|422)/i.test(msg)) return false;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key/i.test(msg)) return false;

  // 明确的暂时性故障
  if (/HTTP\s*5\d\d/i.test(msg)) return true;                        // 5xx
  if (/429|rate.?limit|限流|too many requests|quota/i.test(msg)) return true;
  if (/超时|timeout|timed out/i.test(msg)) return true;

  // 网络层：错误码太多列不全（bad port、EHOSTUNREACH、证书、DNS…），
  // 凡是带 "模型请求失败" 前缀的都是 fetch 抛的，统一视为可重试
  if (/模型请求失败/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network/i.test(msg)) return true;

  // 响应解析失败（偶发空响应/截断）
  if (/无法解析的 JSON|Unexpected end|unexpected token|JSON/i.test(msg)) return true;

  // 兜底：模型 API 类错误默认不重试（避免未知错误疯狂重试）
  return false;
}

/**
 * 带重试的单次对话请求。
 *
 * 只在**可重试**的错误上重试（网络抖动、5xx、429），
 * 4xx（密钥错、参数错）直接抛出 —— 重试不会让它变好。
 * 退避策略：1s → 2s（指数退避，避免雪崩）。
 *
 * 注意：这里重试的是**同一轮**请求，messages 不变，所以是幂等的，
 * 不会造成重复发言。会话级的整体重试在 orchestrator 里做。
 *
 * @param {object} args 同 chatCompletion
 * @param {number} [retries=2] 最多额外重试几次（默认 2，即总共最多 3 次尝试）
 */
export async function chatCompletionWithRetry(args, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatCompletion(args);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableError(error)) throw error;
      const wait = 1000 * Math.pow(2, attempt);   // 1s, 2s
      console.warn(`[llm] 请求失败（第 ${attempt + 1} 次尝试），${wait}ms 后重试：${error?.message ?? error}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/**
 * 按配置给请求体装上"思考模式"参数。
 *
 * ── 为什么需要它（用户原始需求：省 token）──
 * 推理型模型（deepseek-v4 / qwen-thinking / glm-z 之类）默认会先吐一大段
 * reasoning_content，这些 token 按输出价计费，在"群里闲聊回一句话"的场景
 * 里完全是浪费 —— 判一句"要不要接话"根本用不上长思考。
 * 所以这里把思考强度做成可配置的三档：
 *
 *   'off'  关闭思考   —— 最省。适合纯闲聊、只判要不要回。
 *   'low'  低强度思考 —— 折中：省 token，但复杂问题还能想一下。
 *   'auto' 跟随模型默认 —— 不干预，保持模型/网关原本行为。
 *
 * 兼容性：不同厂商参数名不一样，所以**同时**发几种常见写法，模型/网关认识的
 * 那个生效、不认识的多余字段一般被忽略（未见因此报 400 的案例）；
 * 但为稳妥，遇到 400 且疑似思考参数导致时，chatCompletion 会自动去掉重试一次
 * （见 ensureThinkingParamsFallback）。
 */
export function applyThinkingParams(body, cfg) {
  const api = cfg?.api || {};
  // GLM-5.2/5.3 始终思考，原 off 档位收敛到 low，不能发送 disabled。
  if (/^glm-5\.[23](?:-|$)/i.test(body.model || api.model || '')) {
    body.thinking = { type: 'enabled', clear_thinking: false };
    if (api.thinking !== 'auto') body.reasoning_effort = 'low';
    return body;
  }
  const mode = String(api.thinking ?? 'low').toLowerCase();
  const target = (api.thinkingProvider || '').trim();  // 可选：指定用哪套参数名
  const disable = mode === 'off';
  const isVendor = (n) => !target || target === n;

  if (mode === 'auto') {
    // 不干预：只有用户显式填了 reasoningEffort 才发
    const eff = String(api.reasoningEffort || '').trim();
    if (eff) body.reasoning_effort = eff;
    return body;
  }

  // ① OpenAI 新式（gpt-5 / o 系列）+ 部分中转站
  if (isVendor('openai')) {
    body.reasoning_effort = disable ? 'none' : 'low';
    if (disable) body.reasoning = { effort: 'none' };
  }
  // ② DeepSeek / 智谱 / Qwen 系：thinking.type
  if (isVendor('deepseek') || isVendor('thinking-type') || isVendor('')) {
    body.thinking = disable ? { type: 'disabled' } : { type: 'enabled', effort: 'low' };
    // 一些网关读的是 enable_thinking（布尔，DashScope/百炼风格）
    body.enable_thinking = !disable;
  }
  // ③ Anthropic 兼容网关
  if (isVendor('anthropic')) {
    body.thinking = disable ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 512 };
  }
  // ④ 明确表示"不支持任何思考参数"的模型：加个开关让它彻底别发
  if (api.thinkingUnsupported === true) {
    delete body.thinking;
    delete body.reasoning_effort;
    delete body.reasoning;
    delete body.enable_thinking;
  }
  return body;
}

/**
 * 把 temperature 收敛到目标模型能接受的区间，避免端点直接判 400。
 *
 * 背景：控制台的温度输入允许 0~2（DeepSeek / OpenAI 系的习惯区间），
 * 但部分模型只接受 [0,1] —— 典型是智谱 GLM 系列（glm-4.6 / glm-4.5 等），
 * 传 1.1 会返回 HTTP 400：{"error":{"code":"1210","message":"temperature参数非法：限制数值范围[0,1]"}}。
 * 与其让用户每次换模型都手动改温度，不如按模型名 / 端点自动收敛：
 * 超上限的夹到上限，低于下限的夹到下限，其余原样透传。
 *
 * @returns {number|null} 收敛后的值；无法解析时返回 null（调用方会跳过该字段）
 */
export function clampTemperature(temp, model, baseUrl) {
  // null / undefined / 空串 = "不指定"，保持不发该字段（不能当成 0 发出去）
  if (temp === null || temp === undefined || temp === '') return null;
  const n = Number(temp);
  if (!Number.isFinite(n)) return null;
  const name = String(model || '').toLowerCase();
  const url = String(baseUrl || '').toLowerCase();
  // 智谱 GLM 系：模型名 glm-*/chatglm-*，或端点为 open.bigmodel.cn / zhipuai.cn
  const isZhipu = /\bglm[-_ ]|chatglm|glm4|glm-?\d/.test(name)
    || /bigmodel\.cn|zhipuai\.cn|zhipu/.test(url);
  if (isZhipu) return Math.min(1, Math.max(0, n));
  return n;
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 * overrides: { baseUrl, apiKey, model, timeoutMs } 可选，用于记忆整理专用模型等场景。
 * opts.thinking: 显式指定思考档位（'off'|'low'|'auto'），覆盖配置；记忆整理等后台调用可传 'off' 省 token。
 */
export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null, overrides = null, thinking = null }) {
  const api = overrides || effectiveApi();
  if (usesOpenAIResponses(api)) return chatResponses({ api, messages, tools, toolChoice, thinking, signal });
  const cfg = getConfig();
  const body = {
    model: api.model,
    messages,
    stream: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  const temp = temperature === null ? (api.temperature ?? 0.8) : temperature;
  // 按模型/端点收敛到合法区间（GLM 系上限 1，见 clampTemperature 注释）
  const safeTemp = clampTemperature(temp, api.model, api.baseUrl);
  if (safeTemp !== null && Number.isFinite(safeTemp)) body.temperature = safeTemp;

  // 思考模式：按配置（或调用方显式指定）决定要不要让模型"先想一大段"。
  // 省 token 的核心开关之一 —— 闲聊场景默认 low/off，不把输出预算浪费在 reasoning 上。
  applyThinkingParams(body, {
    api: { ...cfg.api, ...api, ...(thinking ? { thinking } : {}) }
  });

  // Prompt 缓存：系统提示 + 工具定义是大段稳定文本，主动打 cache_control 标记
  // 能让支持的端点（OpenAI / DeepSeek / Qwen / Anthropic 兼容层等）识别稳定段，
  // 命中后按缓存价计费。'auto' = 已知厂商才打；'on' = 强制打；'off' = 不打。
  // 失败兜底：见 400 重试分支（去掉 cache_control 再试）。
  if (shouldApplyCache(api)) applyPromptCache(body);

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(api.timeoutMs) || 180000);
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  }

  let res;
  try {
    res = await doFetch(api, body, controller.signal);
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new Error(`模型请求超时（${timeoutMs}ms）`);
    throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
  }

  // ── 400 兼容兜底 ──
  // 响应体只能读一次，这里统一把错误文本取出来，供下面各个兜底分支复用。
  let text400 = '';
  if (!res.ok && res.status === 400) text400 = await res.text().catch(() => '');

  // ① temperature 区间兜底：控制台允许填 0~2，但部分端点（典型：智谱 GLM 系）
  // 只接受 [0,1]，超出直接 400（code 1210「temperature参数非法」）。
  // 万一模型名/端点没被 clampTemperature 认出来，这里兜住：收敛到 1 再试一次。
  if (!res.ok && res.status === 400 && Number(body.temperature) > 1 && /temperature|温度|1210/i.test(text400)) {
    console.warn('[llm] 端点拒绝当前 temperature，收敛到 1 后重试一次（该模型 temperature 上限为 1）');
    try {
      res = await doFetch(api, { ...body, temperature: 1 }, controller.signal);
    } catch (error) {
      clearTimeout(timer);
      throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
    }
  }

  // ② 图片内容兜底（必须排在思考参数之前）
  // 把图塞给"只吃文本"的模型，端点会直接 400。典型报错（智谱 GLM 系实测）：
  //   code 1210「messages.content.type 参数非法，取值范围 ['text']」
  // 这不能只报错：搜图流程会把候选图以 image_url 补发，模型一旦不支持，整次运行直接崩
  // （2026-09-14 实测：本机 glm-4.6 连续 125 次会话全挂在这）。
  // 做法：摘掉非文本 part 重试一次，并把结论写回 config.modelVision —— 下次运行起这个模型
  // 不再被判为支持图片，工具表自动收起看图工具、搜图只给文字列表（visionUsable 是唯一判据）。
  // 顺序说明：本分支必须排在思考参数兜底之前，否则会被后者的 else 分支直接 throw 掉。
  if (!res.ok && res.status === 400 && hasNonTextParts(body.messages)
    && /content[.\s_-]?type|image_url|image|图片|多模态|modal|vision/i.test(text400)) {
    console.warn('[llm] 端点拒绝图片内容（该模型不支持看图），摘掉图片后重试一次，并记为 no-vision');
    try {
      const providerId = String(api.provider ?? '');
      if (providerId && api.model) {
        const key = `${providerId}|||${api.model}`;
        updateConfig({
          modelVision: {
            [key]: {
              providerId,
              model: String(api.model),
              verdict: 'no-vision',
              note: `端点拒绝图片内容（HTTP 400：${text400.slice(0, 120)}），自动记为不支持图片输入`,
              httpStatus: 400,
              latencyMs: null,
              source: 'auto-400',
              checkedAt: Date.now()
            }
          }
        });
      }
    } catch (error) {
      // 写配置失败不影响这次请求：降级重试本身仍然有效
      console.warn(`[llm] 记录 no-vision 结论失败（不影响本次请求）：${error?.message ?? error}`);
    }
    try {
      res = await doFetch(api, { ...body, messages: stripImageParts(body.messages) }, controller.signal);
    } catch (error) {
      clearTimeout(timer);
      throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
    }
  }

  // ③ 思考参数兼容兜底
  // 少数端点对未知字段很严格（报 400 unknown field）。此时把思考参数全部摘掉
  // 再试一次 —— 宁可丢掉"省 token"，也不能因为一个可选参数导致整个群不工作。
  if (!res.ok && res.status === 400 && hasThinkingParams(body)) {
    if (/thinking|reasoning|enable_thinking|unknown|unsupported|invalid.*param/i.test(text400)) {
      console.warn('[llm] 端点拒绝思考参数，去掉后重试一次（该模型不支持省 token 的思考开关）');
      const fallback = { ...body };
      delete fallback.thinking;
      delete fallback.reasoning_effort;
      delete fallback.reasoning;
      delete fallback.enable_thinking;
      try {
        res = await doFetch(api, fallback, controller.signal);
      } catch (error) {
        clearTimeout(timer);
        throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
      }
    } else {
      clearTimeout(timer);
      throw new Error(`模型 API HTTP 400：${text400.slice(0, 500)}`);
    }
  }
  // ④ Prompt cache 标记兜底
  // 与思考参数同一套兼容思路：少数严格端点不认 cache_control。
  // 400 且 text 提到 cache 时，去掉重试；只重试一次（避免死循环）。
  if (!res.ok && res.status === 400 && hasCacheControl(body)) {
    if (/cache_control|cache[-_]?control|unknown.*cache|invalid.*cache/i.test(text400)) {
      console.warn('[llm] 端点拒绝 cache_control 标记，去掉后重试一次（该端点不认 prompt 缓存）');
      const fallback = cloneBodyWithoutCache(body);
      try {
        res = await doFetch(api, fallback, controller.signal);
      } catch (error) {
        clearTimeout(timer);
        throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
      }
    }
  }
  clearTimeout(timer);

  if (!res.ok) {
    // 400 的错误体在上面已经被读过（响应体只能读一次），这里优先复用它
    const text = (res.status === 400 && text400) ? text400 : await res.text().catch(() => '');
    throw new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}`);
  }
  const data = await res.json().catch(() => { throw new Error('模型 API 返回了无法解析的 JSON'); });
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
  return {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? api.model,
    raw: data
  };
}

/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = effectiveApi();
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/**
 * 累加 usage。
 * 同时累计 cachedTokens（命中前缀缓存的 prompt 部分）—— 中转站会在
 * usage.prompt_tokens_details.cached_tokens 里返回它，用量页的缓存命中率统计依赖这个数。
 */
export function addUsage(target, usage) {
  if (!usage) return target;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += Number(usage.total_tokens) || (prompt + completion);
  // 各家返回路径不同，逐个兼容
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
    ?? 0;
  target.cachedTokens = (Number(target.cachedTokens) || 0) + (Number(cached) || 0);
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
}

/** 缓存命中率（0~1）。没有 prompt 数据时返回 0。 */
export function cacheHitRate(usage) {
  const p = Number(usage?.promptTokens) || 0;
  if (!p) return 0;
  return Math.min(1, Math.max(0, (Number(usage?.cachedTokens) || 0) / p));
}
