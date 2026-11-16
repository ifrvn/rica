export const hostedModelCatalog = [
  { id: 'openai', name: 'OpenAI', requiresBaseUrl: false },
  { id: 'anthropic', name: 'Anthropic Claude', requiresBaseUrl: false },
  { id: 'gemini', name: 'Google Gemini', requiresBaseUrl: false },
  { id: 'openai-compatible', name: 'OpenAI 兼容服务', requiresBaseUrl: true },
] as const

export type HostedModel = (typeof hostedModelCatalog)[number]
