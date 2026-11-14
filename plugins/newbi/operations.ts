import { identifyNewbiAccount } from './reader.js'
import { openSavedNewbiExecutor, openSavedNewbiReader, readSavedNewbiThread, scopedNewbiDatabase } from './database.js'
import { pollNewbiEvents } from '../../packages/persistence/newbi-events.js'
import { executeNewbiReply } from '../../packages/persistence/newbi-execution.js'
import { newbiExecutorKey } from '../../packages/contracts/newbi-executor-identity.js'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import type { createDeploymentPluginStore } from '../../packages/runtime/deployment-plugins.js'
import type { NewbiManagementOptions } from './management.js'

export function createNewbiOperations(db: PrismaClient, deploymentPlugins: ReturnType<typeof createDeploymentPluginStore>): NewbiManagementOptions {
  const newbiReaderDb = scopedNewbiDatabase(db, 'reader')
  const newbiExecutorDb = scopedNewbiDatabase(db, 'executor')
  return {
    readConnectorThread: (target) => readSavedNewbiThread(newbiReaderDb, deploymentPlugins, target),
    sendConnector: async (id, retry) => {
      const host = await openSavedNewbiExecutor(newbiExecutorDb, deploymentPlugins, id, AbortSignal.timeout(7000))
      if (!host) return { status: 'UNAVAILABLE' }
      try {
        return await executeNewbiReply(newbiExecutorDb, host.plugin.implementation, newbiExecutorKey(host.plugin), id, retry)
      } finally {
        await host.stop()
      }
    },
    pollConnector: async (accountId) => {
      const stop = AbortSignal.timeout(7000)
      const host = await openSavedNewbiReader(newbiReaderDb, deploymentPlugins, accountId, stop)
      if (!host) return
      try {
        return await pollNewbiEvents(newbiReaderDb, host.plugin.implementation, accountId, stop)
      } finally {
        await host.stop()
      }
    },
    identifyConnector: async (credential, endpoint) => {
      const current = await deploymentPlugins.openNewbi(credential, endpoint)
      return current && identifyNewbiAccount(current.connection, current.beforeRequest)
    },
  }
}
