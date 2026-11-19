import { setTimeout as sleep } from 'node:timers/promises'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import { backgroundDiscussions, claimBackgroundAssessment, runNewbiAssessment, type BackgroundDiscussion } from '../persistence/assessments.js'
import type { NewbiManagementOptions } from './routes.js'

type Operations = Pick<Required<NewbiManagementOptions>, 'pollConnector' | 'readConnectorThread' | 'assessDiscussion'>

export async function assessNewbiBackground(db: PrismaClient, readEndpoint: () => Promise<string | undefined>, operations: Operations,
  onError: () => void, stop?: AbortSignal) {
  const endpoint = await readEndpoint()
  if (!endpoint || stop?.aborted) return

  const [due] = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id
    FROM public.platform_accounts a
    JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
    JOIN public.characters c ON c.id = a.character_id
    JOIN public.newbi_credentials k ON k.endpoint = a.instance_key AND k.agent_id::text = a.remote_account_id
    LEFT JOIN public.newbi_event_checkpoints p ON p.account_id = a.id
    WHERE a.platform = 'newbi' AND a.instance_key = ${endpoint}
      AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
      AND (p.next_poll_at IS NULL OR p.next_poll_at <= statement_timestamp())
      AND (p.read_error IS NULL OR p.read_error NOT IN ('AGENT_MISMATCH', 'CREDENTIAL_INVALID', 'ACCESS_DENIED', 'COMMUNITY_CLOSED'))
    ORDER BY p.next_poll_at NULLS FIRST, a.id
    LIMIT 1
  `
  if (due && !stop?.aborted && await readEndpoint() === endpoint) {
    await operations.pollConnector(due.id).catch(onError)
  }

  const candidates = await db.$queryRaw<BackgroundDiscussion[]>(backgroundDiscussions(endpoint))
  for (const candidate of candidates) {
    if (stop?.aborted || await readEndpoint() !== endpoint) return
    const id = await claimBackgroundAssessment(db, endpoint, candidate)
    if (!id) continue
    await runNewbiAssessment(db, { characterId: candidate.characterId, background: true }, id,
      operations.readConnectorThread, operations.assessDiscussion, async (boundEndpoint) => {
        if (stop?.aborted || await readEndpoint() !== boundEndpoint) throw new Error('Background assessment was stopped')
      })
    return
  }
}

export function startNewbiBackground(db: PrismaClient, readEndpoint: () => Promise<string | undefined>, operations: Operations, onError: () => void) {
  const stop = new AbortController()
  const running = (async () => {
    while (!stop.signal.aborted) {
      await assessNewbiBackground(db, readEndpoint, operations, onError, stop.signal).catch(onError)
      await sleep(15_000, undefined, { signal: stop.signal }).catch(() => {})
    }
  })()
  return async () => {
    stop.abort()
    await running
  }
}
