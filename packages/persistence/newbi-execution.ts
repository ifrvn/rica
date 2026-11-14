import type { RawQueryClient } from './client.js'
import { PlatformReplyError, type PlatformReplyExecutor } from '../contracts/platform-reply-executor.js'

type Target = {
  agentId: string; endpoint: string; postId: string; status: string; attempts: number
  retryNotBefore: string | null; leaseUntil: string | null
}
type Claim = { id: string; postId: string; content: string; attempt: number }
type Outcome =
  | { status: 'UNAVAILABLE' | 'UNKNOWN' | 'CLOSED'; reason?: PlatformReplyError['reason']; retryNotBefore?: string }
  | { status: 'SENT'; commentId: string }

export async function executeNewbiReply(db: RawQueryClient, client: PlatformReplyExecutor, executorKey: string, id: string, retry = false): Promise<Outcome> {
  const [row] = await db.$queryRaw<{ target: Target | null }[]>`
    SELECT public.rica_newbi_execution_target(${id}::uuid, ${executorKey}) AS target
  `
  const target = row.target
  if (!target || target.endpoint !== client.endpoint || target.attempts >= 3 || (target.status !== 'READY' && !retry)
    || (target.leaseUntil && Date.parse(target.leaseUntil) > Date.now())) {
    return { status: 'UNAVAILABLE' }
  }
  if (target.retryNotBefore && Date.parse(target.retryNotBefore) > Date.now()) {
    return { status: 'UNAVAILABLE', retryNotBefore: new Date(target.retryNotBefore).toISOString() }
  }

  let agentId: string
  try {
    agentId = (await client.verify()).id
    if (agentId !== target.agentId) return { status: 'UNAVAILABLE' }
    const post = await client.readTarget(target.postId)
    if (post.isLocked) throw new PlatformReplyError('POST_LOCKED')
  } catch (error) {
    if (!(error instanceof PlatformReplyError)) throw error
    const locked = error.reason === 'POST_LOCKED'
    let closed = false
    if (error.retrySeconds || locked) {
      const [result] = await db.$queryRaw<{ changed: boolean }[]>`
        SELECT public.rica_newbi_reply_preflight(${id}::uuid,${executorKey},${error.retrySeconds}::int,${locked}) AS changed
      `
      closed = locked && result.changed
    }
    return {
      status: closed ? 'CLOSED' : 'UNAVAILABLE', reason: error.reason,
      ...(error.retrySeconds ? { retryNotBefore: new Date(Date.now() + error.retrySeconds * 1000).toISOString() } : {}),
    }
  }

  const [claim] = await db.$queryRaw<{ payload: Claim | null }[]>`
    SELECT public.rica_claim_newbi_reply(${id}::uuid, ${retry}, ${agentId}::uuid, ${client.endpoint}, ${executorKey}) AS payload
  `
  if (!claim.payload) return { status: 'UNAVAILABLE' }

  const { id: idempotencyKey, postId, content, attempt } = claim.payload
  let commentId: string | null = null
  let failure: PlatformReplyError | undefined
  try {
    commentId = await client.sendReply(postId, idempotencyKey, content)
  } catch (error) {
    // A lost response can hide a successful write. Keep the same key for any explicit retry.
    if (error instanceof PlatformReplyError) failure = error
  }
  const locked = failure?.reason === 'POST_LOCKED'
  const seconds = failure?.retrySeconds ?? 0
  const [result] = await db.$queryRaw<{ recorded: boolean }[]>`
    SELECT public.rica_finish_newbi_reply(${id}::uuid, ${attempt}::int, ${commentId}::uuid, ${seconds}::int, ${locked}) AS recorded
  `
  if (result.recorded && commentId) return { status: 'SENT', commentId }
  return {
    status: result.recorded && locked && attempt === 1 ? 'CLOSED' : 'UNKNOWN',
    ...(failure ? { reason: failure.reason } : {}),
    ...(seconds ? { retryNotBefore: new Date(Date.now() + seconds * 1000).toISOString() } : {}),
  }
}
