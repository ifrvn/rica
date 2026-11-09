import { z } from '@hono/zod-openapi'
import { listQuery, resourceId } from './management.js'

export const newbiReaderIdentity = { id: 'newbi-local-reader', version: '1.0.0', contractVersion: 1 } as const

export const newbiEndpoint = z.string().max(160).transform((value, ctx) => {
  if (URL.canParse(value)) {
    const url = new URL(value)
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/agent-api/v1') {
      return url.href
    }
  }
  ctx.addIssue({ code: 'custom', message: 'Expected a loopback Newbi Agent API endpoint' })
  return z.NEVER
})
export const newbiAccountInput = z.strictObject({ identityId: resourceId, agentId: resourceId, endpoint: newbiEndpoint })
export const newbiReplyInput = z.strictObject({
  accountId: resourceId, postId: resourceId,
  content: z.string().trim().min(1).refine((value) => [...value].length <= 4000 && !value.includes('\0')),
})
export const newbiDecisionInput = z.strictObject({
  reviewDigest: z.string().regex(/^[0-9a-f]{64}$/), decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().min(1).max(240),
})
export const newbiClosureInput = z.strictObject({ reason: z.string().trim().min(1).max(240) })
const newbiReplyStatus = z.enum(['WAITING', 'READY', 'REJECTED', 'IN_FLIGHT', 'UNKNOWN', 'SENT', 'CLOSED'])
export const newbiReplyQuery = listQuery.extend({ status: newbiReplyStatus.optional(), accountId: resourceId.optional() })
export const newbiReplySummary = z.object({
  id: resourceId, identity: z.string(), agentId: resourceId, postId: resourceId,
  status: newbiReplyStatus, createdAt: z.iso.datetime(),
})
export const newbiReplyView = z.object({
  id: resourceId, accountId: resourceId, identityId: resourceId, agentId: resourceId,
  endpoint: newbiEndpoint, postId: resourceId, content: z.string().nullable(), reviewDigest: z.string(),
  status: newbiReplyStatus,
  attempts: z.number().int(), remoteCommentId: resourceId.nullable(), expiresAt: z.iso.datetime(),
  retryNotBefore: z.iso.datetime().nullable(), closureReason: z.string().nullable(),
})
export type NewbiReplyView = z.infer<typeof newbiReplyView>

export const newbiReadError = z.enum(['AGENT_MISMATCH', 'CREDENTIAL_INVALID', 'ACCESS_DENIED', 'RATE_LIMITED',
  'SERVICE_UNAVAILABLE', 'COMMUNITY_CLOSED', 'READ_FAILED'])
export type NewbiReadError = z.infer<typeof newbiReadError>

export const newbiInboxView = z.object({
  agentId: resourceId,
  lastSucceededAt: z.iso.datetime().nullable(),
  readError: newbiReadError.nullable(),
  nextPollAt: z.iso.datetime().nullable(),
  historyLostCount: z.number().int().nonnegative(),
  lastHistoryLostAt: z.iso.datetime().nullable(),
  items: z.array(z.object({
    seq: z.string(),
    type: z.enum(['POST_REPLIED', 'COMMENT_REPLIED', 'AGENT_MENTIONED']),
    postId: resourceId,
    commentId: resourceId.nullable(),
    occurredAt: z.iso.datetime(),
  })).nullable(),
})
