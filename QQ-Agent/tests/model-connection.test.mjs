// 隔离配置与模拟模型响应，禁止使用真实 QQ 登录/密钥或联网请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after, beforeEach } from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-model-test-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig } = await import('../src/config.js');
const { connectModel, testModelChat } = await import('../src/providers.js');
const { chatCompletion } = await import('../src/llm.js');
const originalFetch = globalThis.fetch;
beforeEach(() => { setRuntimeConfig(structuredClone(DEFAULT_CONFIG)); globalThis.fetch = () => { throw new Error('测试禁止联网'); }; });
after(() => { globalThis.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); });

test('预设接入保存真实 API ID，保持高级参数、登录配置与其他提供商密钥', () => {
  const cfg = getConfig();
  cfg.api.temperature = 0.4;
  cfg.providers = [{ id: 'old', baseURL: 'https://example.test/v1', apiKey: 'old-fixture', models: ['a'] }];
  const bridge = structuredClone(cfg.snowluma);
  const r = connectModel({ vendor: 'deepseek', model: 'deepseek-flash', apiKey: 'deepseek-fixture' });
  assert.equal(getConfig().api.model, 'deepseek-flash');
  assert.equal(getConfig().api.provider, r.provider.id);
  assert.equal(getConfig().api.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(getConfig().api.temperature, 0.4);
  assert.deepEqual(getConfig().snowluma, bridge);
  assert.equal(getConfig().dshProviderKeys.old, 'old-fixture');
  assert.equal(getConfig().modelVision[`${r.provider.id}|||deepseek-flash`].verdict, 'vision');
});

test('同厂商复用已保存密钥，跨厂商无密钥被拒且不改变当前连接', () => {
  const first = connectModel({ vendor: 'deepseek', model: 'deepseek-flash', apiKey: 'fixture' });
  const next = connectModel({ vendor: 'deepseek', model: 'deepseek-v4-pro', apiKey: '' });
  assert.equal(next.provider.id, first.provider.id);
  assert.deepEqual(next.provider.models, ['deepseek-flash', 'deepseek-v4-pro']);
  const before = structuredClone(getConfig());
  assert.throws(() => connectModel({ vendor: 'gpt', model: 'gpt-6.1-sol', apiKey: '' }), /API Key/);
  assert.deepEqual(getConfig(), before);
  assert.equal(next.provider.modelNames['deepseek-v4-pro'], 'DeepSeek V4 Pro');
});

test('旧单模型接入同地址可复用密钥，非法模型与地址不会写配置', () => {
  getConfig().api = { ...getConfig().api, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'legacy-fixture' };
  assert.equal(connectModel({ vendor: 'deepseek', model: 'deepseek-flash' }).provider.apiKey, 'legacy-fixture');
  const before = structuredClone(getConfig());
  for (const selection of [{ vendor: 'gpt', model: 'fake', apiKey: 'fixture' }, { baseUrl: 'file:///etc', model: 'a', apiKey: 'fixture' }]) {
    assert.throws(() => connectModel(selection));
    assert.deepEqual(getConfig(), before);
  }
});

test('其他可添加多个模型并使用首项，之后选取已有模型不新增提供商', () => {
  const r = connectModel({ baseUrl: 'https://example.test/v1', apiKey: 'fixture', models: [{ id: 'a', name: '模型 A' }, { id: 'b', name: '模型 B' }] });
  assert.equal(getConfig().api.model, 'a');
  connectModel({ providerId: r.provider.id, model: 'b' });
  assert.equal(getConfig().api.model, 'b');
  assert.equal(getConfig().providers[0].modelNames.b, '模型 B');
  assert.equal(getConfig().providers.length, 1);
});

test('GPT-6.1工具调用、图片、工具结果和加密推理可跨轮重放，用量正确', async () => {
  connectModel({ vendor: 'gpt', model: 'gpt-6.1-sol', apiKey: 'gpt-fixture' });
  const requests = [];
  const output = [{ type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'fixture-encrypted' }, { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'send_message', arguments: '{"text":"你好"}' }];
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    return Response.json({ object: 'response', status: 'completed', model: 'gpt-6.1-sol', output: requests.length === 1 ? output : [{ type: 'message', content: [{ type: 'output_text', text: '已完成' }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3 } } });
  };
  const messages = [{ role: 'system', content: '机器人' }, { role: 'user', content: [{ type: 'text', text: '看看' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }];
  const result = await chatCompletion({ messages, tools: [{ type: 'function', function: { name: 'send_message', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }], thinking: 'off' });
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].headers.authorization, 'Bearer gpt-fixture');
  assert.equal(requests[0].body.reasoning.effort, 'low');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.tools[0].strict, false);
  assert.equal(requests[0].body.input[1].content[1].type, 'input_image');
  assert.equal(result.message.tool_calls[0].id, 'call1');
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 3);
  const final = await chatCompletion({ messages: [...messages, { ...result.message, raw: result.raw }, { role: 'tool', tool_call_id: 'call1', content: '{"ok":true}' }] });
  assert.deepEqual(requests[1].body.input.slice(2, 4), output);
  assert.equal(requests[1].body.input[4].type, 'function_call_output');
  assert.equal(final.message.content, '已完成');
});

test('GLM-5.3关闭思考档位自动收敛，第三方 GPT 兼容地址继续用 Chat Completions', async () => {
  const requests = [];
  globalThis.fetch = async (url, opts) => { requests.push({ url, body: JSON.parse(opts.body) }); return Response.json({ choices: [{ message: { content: 'ok' } }] }); };
  connectModel({ vendor: 'glm', model: 'glm-5.3', apiKey: 'fixture' });
  await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], thinking: 'off' });
  assert.equal(requests[0].body.thinking.type, 'enabled');
  assert.equal(requests[0].body.reasoning_effort, 'low');
  assert.equal(requests[0].body.enable_thinking, undefined);
  await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], overrides: { baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'gpt-6-sol' } });
  assert.equal(requests[1].url, 'https://example.test/v1/chat/completions');
});

test('GPT连接测试使用Responses，拒绝不完整响应和HTTP错误', async () => {
  globalThis.fetch = async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }] });
  assert.equal((await testModelChat({ baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture', model: 'gpt-6-astra' })).ok, true);
  globalThis.fetch = async () => Response.json({ status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } });
  assert.equal((await testModelChat({ baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture', model: 'gpt-6.1-sol' })).ok, false);
  globalThis.fetch = async () => new Response('invalid key', { status: 401 });
  assert.equal((await testModelChat({ baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture', model: 'gpt-6-sol' })).ok, false);
});
