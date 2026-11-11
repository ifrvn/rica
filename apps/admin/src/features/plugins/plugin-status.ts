import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { z } from '@hono/zod-openapi'
import type { pluginStatusView } from '../../../../../packages/contracts/plugin-status.js'
import type { DeploymentPluginId } from '../../../../../packages/contracts/deployment-plugins.js'
import { characterPath, useConsoleTask } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'

export type PluginStatus = z.infer<typeof pluginStatusView>
export const pluginNames: Record<DeploymentPluginId, string> = {
  newbi: 'Newbi', openai: 'OpenAI', anthropic: 'Anthropic Claude', gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI 兼容服务',
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
