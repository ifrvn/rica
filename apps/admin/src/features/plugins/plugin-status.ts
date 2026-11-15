import { newbiConsole } from '@rica/plugin-newbi/console/labels'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { z } from '@hono/zod-openapi'
import type { consolePluginStatusView } from '../../../../plugin-status-view.js'
import type { DeploymentPluginId } from '../../../../deployment-plugin-contracts.js'
import { characterPath, useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'

export type PluginStatus = z.infer<typeof consolePluginStatusView>
export const pluginNames: Record<DeploymentPluginId, string> = {
  [newbiConsole.id]: newbiConsole.name, openai: 'OpenAI', anthropic: 'Anthropic Claude', gemini: 'Google Gemini',
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
