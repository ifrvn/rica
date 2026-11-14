import type { RawQueryClient } from '../../packages/persistence/client.js'
import type { Prisma, PrismaClient } from '../../packages/persistence/generated/client.js'
import type { createDeploymentPluginStore } from '../../packages/runtime/deployment-plugins.js'
import { startNewbiReader, type NewbiConnection } from './newbi-read-plugin.js'
import { startNewbiExecutor } from './newbi-execution-plugin.js'

export function scopedNewbiDatabase(db: PrismaClient, role: 'reader' | 'executor'): RawQueryClient {
  return {
    $queryRaw<T>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) {
      return db.$transaction(async (tx) => {
        if (role === 'reader') await tx.$executeRaw`SET LOCAL ROLE rica_newbi_poller`
        else await tx.$executeRaw`SET LOCAL ROLE rica_newbi_executor`
        return tx.$queryRaw<T>(query, ...values)
      })
    },
  }
}

export async function openSavedNewbiReader(db: RawQueryClient, store: ReturnType<typeof createDeploymentPluginStore>,
  accountId: string, signal?: AbortSignal) {
  const [saved] = await db.$queryRaw<NewbiConnection[]>`SELECT * FROM public.rica_newbi_poll_connection(${accountId}::uuid)`
  const current = saved && await store.openNewbi(saved.credential, saved.endpoint)
  if (current) return startNewbiReader(current.connection, signal, current.beforeRequest)
}

export async function openSavedNewbiExecutor(db: RawQueryClient, store: ReturnType<typeof createDeploymentPluginStore>,
  replyId: string, signal?: AbortSignal) {
  const [saved] = await db.$queryRaw<NewbiConnection[]>`SELECT * FROM public.rica_newbi_send_connection(${replyId}::uuid)`
  const current = saved && await store.openNewbi(saved.credential, saved.endpoint)
  if (current) return startNewbiExecutor(current.connection, current.beforeRequest, signal)
}
