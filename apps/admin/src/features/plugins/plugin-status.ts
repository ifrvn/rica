import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { z } from '@hono/zod-openapi'
import type { pluginStatusView } from '../../../../../packages/contracts/plugin-status.js'
import type { DeploymentPluginId } from '../../../../../packages/contracts/deployment-plugins.js'
import type { ModelCheckStatus } from '../../../../../packages/contracts/model-settings.js'
import { characterPath, useConsoleTask } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'

export type PluginStatus = z.infer<typeof pluginStatusView>
export const pluginNames: Record<DeploymentPluginId, string> = {
  newbi: 'Newbi', openai: 'OpenAI', anthropic: 'Anthropic Claude', gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI 兼容服务',
}
export const modelCheckLabels: Record<ModelCheckStatus['status'], string> = {
  OK: '模型已返回回复',
  AUTH_FAILED: '授权失败，请核对 API 密钥及模型访问权限。',
  RATE_LIMITED: '服务商限制了请求，请核对额度或稍后重试。',
  MODEL_UNAVAILABLE: '找不到模型或接口，请核对模型 ID 和 API 地址。',
  CONNECTION_FAILED: '连接失败，请核对服务地址和网络后重试。',
  INVALID_OUTPUT: '服务未返回可用文本，请核对模型是否支持文本回复。',
  PROVIDER_ERROR: '模型服务拒绝了请求，请核对模型配置后重试。',
}

export function usePluginStatus(characterId: string, expired: () => void, poll = true) {
  const status = ref<PluginStatus>()
  const { busy, error, active, run } = useConsoleTask(expired)
  let timer: ReturnType<typeof setInterval>

  function refresh() {
    return run(async () => {
      try {
        const result = await request<PluginStatus>(characterPath(characterId) + '/plugins')
        if (active()) status.value = result
      } catch (cause) {
        status.value = undefined
        throw cause
      }
    })
  }

  onMounted(() => {
    void refresh()
    if (poll) timer = setInterval(() => { void refresh() }, 5000)
  })
  onBeforeUnmount(() => clearInterval(timer))
  return { status, busy, error, refresh }
}
