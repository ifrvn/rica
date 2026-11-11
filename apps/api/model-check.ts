import { startModelPlugin } from '../runtime-plugins.js'
import type { ModelCheckResult, ModelSettingsInput } from '../../packages/contracts/model-settings.js'
import { HostedModelError } from '../../packages/runtime/hosted-models.js'

function failureStatus(cause: unknown): ModelCheckResult['status'] {
  if (!(cause instanceof HostedModelError)) return 'PROVIDER_ERROR'
  if (cause.code === 'INVALID_OUTPUT') return 'INVALID_OUTPUT'
  if (cause.code === 'REQUEST_FAILED') return 'CONNECTION_FAILED'
  if (cause.status === 401 || cause.status === 403) return 'AUTH_FAILED'
  if (cause.status === 404) return 'MODEL_UNAVAILABLE'
  if (cause.status === 429) return 'RATE_LIMITED'
  return 'PROVIDER_ERROR'
}

export async function checkModel(configuration: ModelSettingsInput & { provider: ModelCheckResult['provider'] }): Promise<ModelCheckResult> {
  const { provider, apiKey } = configuration
  let reply: string | null = null
  let status: ModelCheckResult['status'] = 'OK'
  try {
    const plugin = await startModelPlugin(configuration)
    try {
      const now = new Date().toISOString()
      const date = now.slice(0, 10)
      const result = await plugin.model.implementation.write({
        text: '请用一句简短的中文问候语回复，用于测试模型连接。', evidence: [], style: 'concise',
        time: { now, occurredAt: now, localDate: date, eventLocalDate: date, timezone: 'UTC', localHour: Number(now.slice(11, 13)) },
      }, AbortSignal.timeout(15_000))
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || !result.text.trim()) {
        throw new HostedModelError('INVALID_OUTPUT')
      }
      reply = (apiKey ? result.text.replaceAll(apiKey, '[已隐藏]') : result.text).slice(0, 500)
    } finally {
      await plugin.stop()
    }
  } catch (cause) {
    status = failureStatus(cause)
    reply = null
  }
  return { provider, status, reply, checkedAt: new Date().toISOString() }
}
