import { setTimeout as sleep } from 'node:timers/promises'
import { NewbiRequestError, type NewbiClient } from '../runtime/newbi-client.js'
import type { PrismaClient } from './generated/client.js'

type Claim = { ticket: string; cursor: string | null; agentId: string; bindingVersion: number; authEpoch: number }
type Deferred = { nextAt: string }
type Committed = Deferred & { saved: number; historyLost: boolean }
type PollResult =
  | { status: 'STOPPED' }
  | ({ status: 'WAITING'; reason?: 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE' } & Deferred)
  | ({ status: 'READ' } & Committed)

export async function pollNewbiEvents(db: PrismaClient, client: NewbiClient, accountId: string, stop?: AbortSignal): Promise<PollResult> {
  if (stop?.aborted) return { status: 'STOPPED' }
  const [claimed] = await db.$queryRaw<{ claim: Claim | Deferred | null }[]>`
    SELECT public.rica_claim_newbi_event_page(${accountId}::uuid,${client.endpoint}) AS claim
  `
  const claim = claimed.claim
  if (!claim) return { status: 'STOPPED' }
  if ('nextAt' in claim) return { status: 'WAITING', nextAt: new Date(claim.nextAt).toISOString() }

  async function finish(ticket: Claim, page: Awaited<ReturnType<NewbiClient['readEvents']>> | null, delay: number) {
    const [row] = await db.$queryRaw<{ committed: Committed | null }[]>`
      SELECT public.rica_finish_newbi_event_page(${accountId}::uuid,${ticket.ticket}::uuid,
        ${ticket.bindingVersion}::int,${ticket.authEpoch}::int,${page ? JSON.stringify(page) : null}::jsonb,${delay}::int) AS committed
    `
    return row.committed && { ...row.committed, nextAt: new Date(row.committed.nextAt).toISOString() }
  }

  let page: Awaited<ReturnType<NewbiClient['readEvents']>>
  let interval: number
  try {
    stop?.throwIfAborted()
    const identity = await client.verify(false)
    if (identity.id !== claim.agentId) {
      await finish(claim, null, 0)
      return { status: 'STOPPED' }
    }
    interval = identity.pollIntervalSeconds
    stop?.throwIfAborted()
    page = await client.readEvents(claim.cursor)
    stop?.throwIfAborted()
  } catch (error) {
    if (stop?.aborted) {
      await finish(claim, null, 0)
      return { status: 'STOPPED' }
    }
    if (error instanceof NewbiRequestError && (error.reason === 'RATE_LIMITED' || error.reason === 'SERVICE_UNAVAILABLE')) {
      const result = await finish(claim, null, error.retrySeconds)
      return result ? { status: 'WAITING', reason: error.reason, nextAt: result.nextAt } : { status: 'STOPPED' }
    }
    await finish(claim, null, error instanceof NewbiRequestError ? 0 : 30)
    throw error
  }

  const result = await finish(claim, page, page.hasMore ? 1 : interval)
  return result ? { status: 'READ', ...result } : { status: 'STOPPED' }
}

export async function runNewbiEventPoller(
  db: PrismaClient, client: NewbiClient, accountId: string, report: (result: PollResult) => void, stop?: AbortSignal,
) {
  for (let check = 0; check < (stop ? 100 : 1) && !stop?.aborted; check++) {
    const result = await pollNewbiEvents(db, client, accountId, stop)
    report(result)
    if (!stop || result.status === 'STOPPED') return
    const delay = Math.min(2_147_483_647, Math.max(1, Date.parse(result.nextAt) - Date.now()))
    try { await sleep(delay, undefined, { signal: stop }) }
    catch (error) { if (!stop.aborted) throw error }
  }
}
