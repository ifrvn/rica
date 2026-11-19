import { identifyNewbiAccount } from '../runtime/reader.js'
import { openSavedNewbiExecutor, openSavedNewbiReader, readSavedNewbiThread, scopedNewbiDatabase, type NewbiConnectionStore } from '../persistence/database.js'
import { pollNewbiEvents } from '../persistence/events.js'
import { executeNewbiReply } from '../persistence/execution.js'
import { newbiExecutorKey } from '../runtime/identity.js'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import type { NewbiManagementOptions } from './routes.js'

export function createNewbiOperations(db: PrismaClient, deploymentPlugins: NewbiConnectionStore) {
  const newbiReaderDb = scopedNewbiDatabase(db, 'reader')
  const newbiExecutorDb = scopedNewbiDatabase(db, 'executor')
  const operations: Required<Pick<NewbiManagementOptions, 'identifyConnector' | 'pollConnector' | 'readConnectorThread' | 'sendConnector'>> = {
    readConnectorThread: (target, preview) => readSavedNewbiThread(newbiReaderDb, deploymentPlugins, target, preview),
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
  return operations
}
