import { setTimeout as sleep } from 'node:timers/promises'
import { backgroundDiscussions, claimBackgroundAssessment, runNewbiAssessment, type BackgroundDiscussion } from '../persistence/assessments.js'
import type { NewbiManagementDatabase } from '../persistence/client.js'
import type { NewbiManagementOptions } from './routes.js'

type Operations = Pick<Required<NewbiManagementOptions>, 'pollConnector' | 'readConnectorThread' | 'assessDiscussion'>

export async function assessNewbiBackground(database: NewbiManagementDatabase, readEndpoint: () => Promise<string | undefined>, operations: Operations,
  onError: () => void, stop?: AbortSignal) {
  const { host: db } = database
  const endpoint = await readEndpoint()
  if (!endpoint || stop?.aborted) return

  const [due] = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id
    FROM public.platform_accounts a
    JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
    JOIN public.characters c ON c.id = a.character_id
    JOIN rica_plugin_newbi.account_profiles k ON k.endpoint = a.instance_key AND k.agent_id::text = a.remote_account_id
    LEFT JOIN rica_plugin_newbi.event_checkpoints p ON p.account_id = a.id
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
  if (stop?.aborted) return

  const candidates = await db.$queryRaw<BackgroundDiscussion[]>(backgroundDiscussions(endpoint))
  for (const candidate of candidates) {
    if (stop?.aborted || await readEndpoint() !== endpoint) return
    const id = await claimBackgroundAssessment(db, endpoint, candidate)
    if (!id) continue
    await runNewbiAssessment(database, { characterId: candidate.characterId, background: true }, id,
      operations.readConnectorThread, operations.assessDiscussion, async (boundEndpoint) => {
        if (stop?.aborted || await readEndpoint() !== boundEndpoint) throw new Error('Background assessment was stopped')
      })
    return
  }
}

export function startNewbiBackground(database: NewbiManagementDatabase, readEndpoint: () => Promise<string | undefined>, operations: Operations, onError: () => void,
  shutdown?: AbortSignal) {
  const stop = new AbortController()
  const signal = shutdown ? AbortSignal.any([shutdown, stop.signal]) : stop.signal
  const running = (async () => {
    while (!signal.aborted) {
      await assessNewbiBackground(database, readEndpoint, operations, onError, signal).catch(onError)
      await sleep(15_000, undefined, { signal }).catch(() => {})
    }
  })()
  return async () => {
    stop.abort()
    await running
  }
}
