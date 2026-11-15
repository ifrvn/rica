export const hostedModelNames = {
  openai: 'OpenAI', anthropic: 'Anthropic Claude', gemini: 'Google Gemini', 'openai-compatible': 'OpenAI 兼容服务',
} as const

export const hostedModelIds = Object.keys(hostedModelNames) as (keyof typeof hostedModelNames)[]

export const hostedModelDeployments = hostedModelIds.map((id) => ({
  id,
  ownsComponent: (service: string, component: { kind: string; id: string }) =>
    service === 'worker' && component.kind === 'model' && component.id === id,
}))
