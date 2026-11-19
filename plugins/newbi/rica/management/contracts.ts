import { z } from '@hono/zod-openapi'
import { accountRegistrationView, accountView, characterWorkspaceView, listQuery, optionalDecisionReason, resourceId, simulationPlatformId } from '@ricajs/contracts/management'
import { newbiCredential, newbiEndpoint } from '../../agent-api/connection.js'
import { autoReviewHandoff } from '@ricajs/contracts/auto-review'
import { discussionSelection } from '@ricajs/contracts/discussion-selection'
import { participationLevel } from '@ricajs/contracts/model-provider'
import { glossaryReference } from '@ricajs/contracts/glossary'

export const newbiAccountTest = z.strictObject({ credential: newbiCredential })
export const newbiAccountPreview = z.object({ agentId: resourceId, username: z.string(), avatarUrl: z.string().nullable() })
export const connectorAccountRegistration = newbiAccountTest.extend({ platform: z.literal('newbi'), agentId: resourceId })
export const newbiAccountInput = newbiAccountTest.extend({ identityId: resourceId, agentId: resourceId })
export const newbiReplyInput = z.strictObject({
  accountId: resourceId, postId: resourceId,
  content: z.string().trim().min(1).refine((value) => [...value].length <= 4000 && !value.includes('\0')),
})
export const newbiDecisionInput = z.strictObject({
  reviewDigest: z.string().regex(/^[0-9a-f]{64}$/), decision: z.enum(['APPROVE', 'REJECT']),
  reason: optionalDecisionReason,
})
export const newbiClosureInput = z.strictObject({ reason: z.string().trim().min(1).max(240) })
export const newbiSendInput = z.strictObject({ retry: z.boolean() })
export const newbiSendView = z.union([
  z.object({ status: z.literal('SENT'), commentId: resourceId }),
  z.object({
    status: z.enum(['UNAVAILABLE', 'UNKNOWN', 'CLOSED']),
    reason: z.enum(['CREDENTIAL_INVALID', 'ACCESS_DENIED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE',
      'COMMUNITY_CLOSED', 'POST_LOCKED']).optional(),
    retryNotBefore: z.iso.datetime().optional(),
  }),
])
const newbiReplyStatus = z.enum(['WAITING', 'READY', 'REJECTED', 'IN_FLIGHT', 'UNKNOWN', 'SENT', 'CLOSED'])
export const newbiReplyQuery = listQuery.extend({ status: newbiReplyStatus.optional(), accountId: resourceId.optional() })
export const newbiReplySummary = z.object({
  id: resourceId, identity: z.string(), agentId: resourceId, postId: resourceId,
  status: newbiReplyStatus, createdAt: z.iso.datetime(),
})
export const newbiReplyView = z.object({
  id: resourceId, accountId: resourceId, identityId: resourceId, identity: z.string(), agentId: resourceId,
  endpoint: newbiEndpoint, postId: resourceId, content: z.string().nullable(), reviewDigest: z.string(),
  status: newbiReplyStatus,
  autoApproved: z.boolean(),
  autoReviewHandoff: autoReviewHandoff.nullable(),
  reviewRecord: z.object({ decision: z.enum(['APPROVE', 'REJECT']), at: z.iso.datetime(), reviewerId: z.string(),
    reason: z.string().nullable(), model: z.string().optional(), policyVersion: z.number().int().optional() }).nullable(),
  reviewerName: z.string().nullable(),
  reviewPrompt: z.object({ model: z.string(), at: z.iso.datetime(), systemPrompt: z.string(), policyVersion: z.number().int() }).nullable(),
  attempts: z.number().int(), remoteCommentId: resourceId.nullable(), expiresAt: z.iso.datetime(),
  retryNotBefore: z.iso.datetime().nullable(), leaseUntil: z.iso.datetime().nullable(), closureReason: z.string().nullable(),
})
export const newbiReviewView = newbiReplyView.extend({ connectorAvailable: z.boolean() })
const newbiThreadCursor = z.string().min(1).max(2048)
export const newbiThreadQuery = z.object({ cursor: newbiThreadCursor.optional() })
export const newbiThreadView = z.object({
  post: z.object({ title: z.string(), content: z.string(), isLocked: z.boolean() }),
  comments: z.array(z.object({ id: resourceId, author: z.object({ username: z.string() }), content: z.string(),
    replyToCommentId: resourceId.nullable() })),
  nextCursor: newbiThreadCursor.nullable(),
})
export const newbiAssessmentThread = newbiThreadView.extend({
  post: newbiThreadView.shape.post.extend({
    author: z.object({ id: z.union([resourceId, z.number().int().positive()]), username: z.string() }).optional(),
  }),
  comments: z.array(newbiThreadView.shape.comments.element.extend({
    author: z.object({ username: z.string(), id: z.union([z.string(), z.number()]).optional() }),
  })),
})
export const newbiAssessmentResult = z.discriminatedUnion('status', [
  discussionSelection.options[0].extend({ target: z.object({ author: z.string(), excerpt: z.string() }) }),
  discussionSelection.options[1].extend({ reason: z.enum(['ALREADY_ANSWERED','LOW_VALUE','OUT_OF_SCOPE','INSUFFICIENT_CONTEXT','THREAD_LOCKED']) }),
  z.object({ status: z.literal('UNAVAILABLE'), reason: z.enum(['THREAD_UNAVAILABLE','MODEL_UNAVAILABLE','INVALID_SELECTION', 'CONTEXT_CHANGED','TIMED_OUT']), note: z.string() }),
  z.object({ status: z.literal('PENDING') }),
])
export const newbiAssessmentView = z.object({
  id: resourceId, accountId: resourceId, postId: resourceId, identity: z.string(), participation: participationLevel,
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), model: z.string().nullable(),
  systemPrompt: z.string().nullable(), result: newbiAssessmentResult,
  glossaryUsed: z.array(glossaryReference),
  glossaryLearned: z.array(glossaryReference.extend({ sourceComments: z.array(resourceId).length(3) })),
})
export const newbiAssessmentList = z.object({ items: z.array(newbiAssessmentView) })
export const newbiAccountCheckView = z.object({ verified: z.boolean(), checkedAt: z.iso.datetime() })

export const newbiReadError = z.enum(['AGENT_MISMATCH', 'CREDENTIAL_INVALID', 'ACCESS_DENIED', 'RATE_LIMITED',
  'SERVICE_UNAVAILABLE', 'COMMUNITY_CLOSED', 'READ_FAILED'])
export type NewbiReadError = z.infer<typeof newbiReadError>

export const newbiPollView = z.discriminatedUnion('status', [
  z.object({ status: z.literal('READ'), saved: z.number().int().nonnegative(), nextAt: z.iso.datetime(), historyLost: z.boolean() }),
  z.object({ status: z.literal('WAITING'), nextAt: z.iso.datetime(), reason: z.enum(['RATE_LIMITED', 'SERVICE_UNAVAILABLE']).optional() }),
  z.object({ status: z.literal('STOPPED') }),
])

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
  })),
})

export const newbiAccountProfile = z.object({ agentId: resourceId, username: z.string().nullable(), avatarUrl: z.string().nullable() })
export const newbiAccountView = accountView.extend({ newbiProfile: newbiAccountProfile.optional() })
export const newbiAccountRegistrationView = accountRegistrationView.extend({
  platform: z.enum([...simulationPlatformId.options, 'newbi']),
  newbiProfile: newbiAccountProfile.optional(),
})
export const newbiCharacterWorkspaceView = characterWorkspaceView.extend({ newbiInstalled: z.boolean() })

export const newbiConnectionsView = z.object({
  activeAccounts: z.number().int().nonnegative(),
  readFailures: z.number().int().nonnegative(),
  lastReadAt: z.iso.datetime().nullable(),
  hasReceipt: z.boolean(),
  hasUnknown: z.boolean(),
})

export const newbiPendingDeliveries = z.object({
  inFlight: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
})
