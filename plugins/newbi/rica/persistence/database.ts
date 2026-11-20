import type { RawQueryClient } from '@ricajs/persistence/client'
import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
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

export function checkNewbiReader(db: PrismaClient) {
  return scopedNewbiDatabase(db, 'reader').$queryRaw`
    SELECT (SELECT endpoint FROM rica_plugin_newbi.poll_connection(NULL::uuid)),
      rica_plugin_newbi.claim_event_page(NULL::uuid, NULL::text)
  `
}

export async function openSavedNewbiReader(db: RawQueryClient, store: NewbiConnectionStore,
  accountId: string, signal?: AbortSignal) {
  const [saved] = await db.$queryRaw<NewbiConnection[]>`SELECT * FROM rica_plugin_newbi.poll_connection(${accountId}::uuid)`
  const current = saved && await store.openNewbi(saved.credential, saved.endpoint)
  if (current) return startNewbiReader(current.connection, signal, current.beforeRequest)
}

export async function readSavedNewbiThread(db: RawQueryClient, store: NewbiConnectionStore,
  target: { accountId: string; agentId: string; endpoint: string; postId: string }, preview?: { cursor?: string }, shutdown?: AbortSignal) {
  const timeout = AbortSignal.timeout(7000)
  const host = await openSavedNewbiReader(db, store, target.accountId, shutdown ? AbortSignal.any([shutdown, timeout]) : timeout)
  if (!host) return
  try {
    const reader = host.plugin.implementation
    if (reader.endpoint !== target.endpoint || (await reader.verify()).id !== target.agentId) return
    return await reader.readThread(target.postId, preview)
  } finally {
    await host.stop()
  }
}

export async function openSavedNewbiExecutor(db: RawQueryClient, store: NewbiConnectionStore,
  replyId: string, signal?: AbortSignal) {
  const [saved] = await db.$queryRaw<NewbiConnection[]>`SELECT * FROM rica_plugin_newbi.send_connection(${replyId}::uuid)`
  const current = saved && await store.openNewbi(saved.credential, saved.endpoint)
  if (current) return startNewbiExecutor(current.connection, current.beforeRequest, signal)
}
