import type { PluginWorker, PluginWorkerContext } from '@ricajs/plugin-host/sdk'
import { createDatabase } from '@ricajs/persistence/client'
import { connectNewbiSettings } from './deployment/settings.js'
import { startNewbiBackground } from './management/background.js'
import { createNewbiOperations } from './management/operations.js'
import { createNewbiDatabase, type NewbiPrismaClient } from './persistence/client.js'
import { checkNewbiReader } from './persistence/database.js'

export function createNewbiWorker({ databaseUrl, signal, services }: PluginWorkerContext): PluginWorker {
  const { readDeployment, discussion } = services ?? {}
  const controller = new AbortController()
  const shutdown = AbortSignal.any([signal, controller.signal])
  let runtime: ReturnType<typeof createDatabase> | undefined
  let management: ReturnType<typeof createDatabase> | undefined
  let newbi: NewbiPrismaClient | undefined
  let stop: (() => Promise<void>) | undefined
  let stopping: Promise<void> | undefined

  return {
    async start() {
      shutdown.throwIfAborted()
      if (!databaseUrl || !readDeployment || !discussion) throw new Error('Newbi Worker requires database and host services')
      const settings = connectNewbiSettings(readDeployment)
      const readEndpoint = async () => await discussion.isEnabled() ? settings.readBackground() : undefined
      runtime = createDatabase(databaseUrl)
      management = createDatabase(databaseUrl, 'rica_admin_api')
      newbi = createNewbiDatabase(databaseUrl)
      await Promise.all([
        newbi.discussionAssessment.findFirst({ select: { id: true } }),
        checkNewbiReader(runtime),
      ])
      shutdown.throwIfAborted()
      const operations = createNewbiOperations(runtime, {
        async openNewbi(credential, endpoint) {
          const current = await readEndpoint()
          if (!current || (endpoint && current !== endpoint)) return
          const opened = await settings.openNewbi(credential, current)
          return opened && { ...opened, async beforeRequest() {
            shutdown.throwIfAborted()
            await opened.beforeRequest()
            if (await readEndpoint() !== current) throw new Error('Newbi background configuration changed')
          } }
        },
      }, shutdown)
      stop = startNewbiBackground({ host: management, newbi }, readEndpoint, {
        ...operations,
        assessDiscussion: (input, profile, identity, capture) => discussion.assess(input, profile, identity, capture),
      }, () => console.error(JSON.stringify({ service: 'worker', event: 'newbi_background_failed' })), shutdown)
    },
    stop() {
      controller.abort()
      return stopping ??= (async () => {
        try { await stop?.() }
        finally { await Promise.all([runtime?.$disconnect(), management?.$disconnect(), newbi?.$disconnect()]) }
      })()
    },
  }
}
