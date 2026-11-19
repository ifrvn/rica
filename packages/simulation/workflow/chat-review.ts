import type { Prisma } from '@ricajs/persistence/prisma'
import type { ReplyDecision } from '@ricajs/contracts/model-provider'
import type { ChatReplyStop } from '../contracts/review.js'

export async function readChatReplyStop(tx: Prisma.TransactionClient, runId: string, reason?: ReplyDecision['reason']) {
  const [row] = await tx.$queryRaw<{ reason: ChatReplyStop | null }[]>`
    SELECT public.rica_chat_reply_stop(${runId}::uuid, ${reason ?? null}) AS reason
  `
  return row.reason
}
