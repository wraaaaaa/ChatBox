// 官方 API 模型标识，核对日期 2026-10-09。显示名与请求 ID 分开维护。
export const MODEL_CATALOG = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', note: '日常聊天 · 支持图片', vision: true },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', note: '复杂任务 · 文本模型', vision: false }
  ] },
  { id: 'glm', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [
    { id: 'glm-5.3', name: 'GLM-5.3', note: '旗舰 · 文本模型', vision: false },
    { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', note: '快速响应 · 支持图片', vision: true },
    { id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX', note: '增强版 · 支持图片', vision: true },
    { id: 'glm-5.2', name: 'GLM-5.2', note: '长上下文 · 文本模型', vision: false }
  ] },
  { id: 'gpt', name: 'GPT', baseUrl: 'https://api.openai.com/v1', models: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', note: '6.1 系列 · 均衡', vision: true },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', note: '6 系列 · 旗舰', vision: true },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol', note: '6 系列 · 通用', vision: true },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', note: '6 系列 · 快速', vision: true }
  ] }
];
