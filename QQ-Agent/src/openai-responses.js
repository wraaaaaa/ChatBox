// GPT-6 官方工具调用通过 Responses API；其他兼容端点继续使用原有协议。
export function usesOpenAIResponses(api) {
  try { return new URL(api.baseUrl).hostname === 'api.openai.com' && /^gpt-6(?:[.-]|$)/i.test(api.model); } catch { return false; }
}

export function responsesInput(messages) {
  const input = [];
  for (const msg of messages || []) {
    if (msg.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: String(msg.content ?? '') });
      continue;
    }
    // store:false 下每轮重放上轮的推理、函数调用和文本，保留推理加密内容。
    if (msg.role === 'assistant' && msg.raw?.object === 'response' && Array.isArray(msg.raw.output)) {
      input.push(...msg.raw.output);
      continue;
    }
    const content = Array.isArray(msg.content) ? msg.content.map((part) => {
      if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url, ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}) };
      return { type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: String(part.text ?? '') };
    }) : String(msg.content ?? '');
    if (typeof content !== 'string' || content) input.push({ role: msg.role, content });
    for (const call of msg.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return input;
}

export async function chatResponses({ api, messages, tools = null, toolChoice = 'auto', thinking = null, signal = null }) {
  const mode = thinking || api.thinking || 'low';
  const requiresThinking = ['gpt-6-astra', 'gpt-6.1-sol'].includes(api.model);
  const body = { model: api.model, input: responsesInput(messages), stream: false, store: false, include: ['reasoning.encrypted_content'] };
  if (mode !== 'auto') body.reasoning = { effort: mode === 'off' && !requiresThinking ? 'none' : 'low' };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', ...t.function, strict: false }));
    body.tool_choice = typeof toolChoice === 'object' ? { type: 'function', name: toolChoice.function?.name } : toolChoice;
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(api.timeoutMs) || 180000);
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    const res = await fetch(`${String(api.baseUrl).replace(/\/+$/, '')}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(api.apiKey ? { authorization: `Bearer ${api.apiKey}` } : {}) }, body: JSON.stringify(body), signal: controller.signal
    });
    if (!res.ok) throw new Error(`模型 API HTTP ${res.status}：${(await res.text()).slice(0, 500)}`);
    const data = await res.json();
    if (data.error || !Array.isArray(data.output) || data.status === 'failed' || data.status === 'incomplete') throw new Error(`模型 API 响应未完成：${data.error?.message || data.incomplete_details?.reason || data.status || '缺少 output'}`);
    const texts = data.output.filter((item) => item.type === 'message').flatMap((item) => item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text || '');
    const calls = data.output.filter((item) => item.type === 'function_call').map((item) => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }));
    const usage = data.usage ? { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens, total_tokens: data.usage.total_tokens, prompt_tokens_details: data.usage.input_tokens_details } : null;
    return { message: { role: 'assistant', content: texts.join('\n') || null, ...(calls.length ? { tool_calls: calls } : {}) }, finishReason: calls.length ? 'tool_calls' : 'stop', usage, model: data.model || api.model, raw: data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? '模型请求已取消' : `模型请求超时（${timeoutMs}ms）`);
    if (/模型 API/.test(error.message)) throw error;
    throw new Error(`模型请求失败：${error?.cause?.message ?? error.message}`);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
