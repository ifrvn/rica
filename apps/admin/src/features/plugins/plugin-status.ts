import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { z } from '@hono/zod-openapi'
import type { consolePluginStatusView } from '../../../../plugin-status-view.js'
import { characterPath, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'

export type PluginStatus = z.infer<typeof consolePluginStatusView>
export { pluginNames } from '../../app/plugin-integrations.js'
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
