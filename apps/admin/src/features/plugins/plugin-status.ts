import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { z } from '@hono/zod-openapi'
import type { pluginStatusView } from '../../../../../packages/contracts/plugin-status.js'
import { characterPath, useConsoleTask } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'

export type PluginStatus = z.infer<typeof pluginStatusView>

export function usePluginStatus(characterId: string, expired: () => void) {
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
    timer = setInterval(() => { void refresh() }, 5000)
  })
  onBeforeUnmount(() => clearInterval(timer))
  return { status, busy, error, refresh }
}
