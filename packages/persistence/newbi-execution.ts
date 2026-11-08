import type { PrismaClient } from './generated/client.js'
import type { NewbiClient } from '../runtime/newbi-client.js'

type Target = { agentId: string; endpoint: string; postId: string; status: string; attempts: number }
type Claim = { id: string; postId: string; content: string; attempt: number }
type Outcome = { status: 'UNAVAILABLE' | 'UNKNOWN' } | { status: 'SENT'; commentId: string }

export async function executeNewbiReply(db: PrismaClient, client: NewbiClient, id: string, retry = false): Promise<Outcome> {
  const [row] = await db.$queryRaw<{ target: Target | null }[]>`
    SELECT public.rica_newbi_execution_target(${id}::uuid) AS target
  `
  const target = row.target
  if (!target || target.endpoint !== client.endpoint || target.attempts >= 3 || (target.status !== 'READY' && !retry)) {
    return { status: 'UNAVAILABLE' }
  }
  const identity = await client.verify(true)
  if (identity.id !== target.agentId) return { status: 'UNAVAILABLE' }
  const { post } = await client.readThread(target.postId)
  if (post.isLocked) return { status: 'UNAVAILABLE' }
  const [claim] = await db.$queryRaw<{ payload: Claim | null }[]>`
    SELECT public.rica_claim_newbi_reply(${id}::uuid, ${retry}, ${identity.id}::uuid, ${client.endpoint}) AS payload
  `
  if (!claim.payload) return { status: 'UNAVAILABLE' }

  const { id: idempotencyKey, postId, content, attempt } = claim.payload
  let commentId: string | null = null
  try {
    commentId = await client.comment(postId, idempotencyKey, content)
  } catch {
    // A response can be lost after the remote write commits. The next explicit attempt reuses the same ID.
  }
  const [result] = await db.$queryRaw<{ recorded: boolean }[]>`
    SELECT public.rica_finish_newbi_reply(${id}::uuid, ${attempt}::int, ${commentId}::uuid) AS recorded
  `
  if (!result.recorded || !commentId) return { status: 'UNKNOWN' }
  return { status: 'SENT', commentId }
}
