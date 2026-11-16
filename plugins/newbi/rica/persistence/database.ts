import type { RawQueryClient } from '../../../../packages/persistence/client.js'
import type { Prisma, PrismaClient } from '../../../../packages/persistence/generated/client.js'
import { startNewbiReader, type NewbiConnection } from '../runtime/reader.js'
import { startNewbiExecutor } from '../runtime/executor.js'

export type NewbiConnectionStore = {
  openNewbi(credential: string, endpoint?: string): Promise<{
    connection: NewbiConnection; beforeRequest: () => Promise<void>
  } | undefined>
}

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

export async function openSavedNewbiReader(db: RawQueryClient, store: NewbiConnectionStore,
  accountId: string, signal?: AbortSignal) {
  const [saved] = await db.$queryRaw<NewbiConnection[]>`SELECT * FROM public.rica_newbi_poll_connection(${accountId}::uuid)`
  const current = saved && await store.openNewbi(saved.credential, saved.endpoint)
  if (current) return startNewbiReader(current.connection, signal, current.beforeRequest)
}

export async function readSavedNewbiThread(db: RawQueryClient, store: NewbiConnectionStore,
  target: { accountId: string; agentId: string; endpoint: string; postId: string }) {
  const host = await openSavedNewbiReader(db, store, target.accountId, AbortSignal.timeout(7000))
  if (!host) return
  try {
    const reader = host.plugin.implementation
    if (reader.endpoint !== target.endpoint || (await reader.verify()).id !== target.agentId) return
    return await reader.readThread(target.postId)
  } finally {
    await host.stop()
  }
}

export async function openSavedNewbiExecutor(db: RawQueryClient, store: NewbiConnectionStore,
  replyId: string, signal?: AbortSignal) {
  const [saved] = await db.$queryRaw<NewbiConnection[]>`SELECT * FROM public.rica_newbi_send_connection(${replyId}::uuid)`
  const current = saved && await store.openNewbi(saved.credential, saved.endpoint)
  if (current) return startNewbiExecutor(current.connection, current.beforeRequest, signal)
}
