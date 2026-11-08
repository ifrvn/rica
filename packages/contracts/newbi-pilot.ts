import { z } from '@hono/zod-openapi'
import { resourceId } from './management.js'

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
export const newbiReplyView = z.object({
  id: resourceId, accountId: resourceId, identityId: resourceId, agentId: resourceId,
  endpoint: newbiEndpoint, postId: resourceId, content: z.string().nullable(), reviewDigest: z.string(),
  status: z.enum(['WAITING', 'READY', 'REJECTED', 'IN_FLIGHT', 'UNKNOWN', 'SENT', 'CLOSED']),
  attempts: z.number().int(), remoteCommentId: resourceId.nullable(), expiresAt: z.iso.datetime(),
  retryNotBefore: z.iso.datetime().nullable(), closureReason: z.string().nullable(),
})
export type NewbiReplyView = z.infer<typeof newbiReplyView>
