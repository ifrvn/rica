import { z } from '@hono/zod-openapi'
import { listQuery, optionalDecisionReason, reasonInput, simulationPlatformId } from '@ricajs/contracts/management'
import { simulationFollowUp } from './follow-up.js'
import { autoReviewHandoff } from '@ricajs/contracts/auto-review'

export const reviewTarget = z.object({
  platform: simulationPlatformId,
  instance: z.string(),
  accountId: z.uuid(),
  account: z.string(),
  identityId: z.uuid(),
  identity: z.string(),
  conversationId: z.uuid(),
  conversation: z.string(),
  audience: z.enum(['PUBLIC', 'PRIVATE']),
  contactId: z.uuid().nullable(),
  contact: z.string().nullable(),
  message: z.string(),
})
const inboundReviewMessage = z.object({
  id: z.uuid(), kind: z.enum(['POST', 'REPLY', 'MENTION']),
  occurredAt: z.iso.datetime({ offset: true }), sender: z.string().nullable(), content: z.string(),
})
export const simulationReviewContext = z.object({
  trigger: inboundReviewMessage.extend({ content: z.string().nullable() }),
  previous: z.array(inboundReviewMessage),
})
export const actionReviewQuery = listQuery.extend({
  status: z.enum(['WAITING', 'HISTORY', 'APPROVE', 'REJECT']).optional(),
})
export const chatReplyStop = z.enum(['CHAT_REPEAT', 'CHAT_MOVED_ON'])
export type ChatReplyStop = z.infer<typeof chatReplyStop>
export const chatReplyStopLabels = {
  CHAT_REPEAT: '同一群员近期发过相同消息，已有回复或待处理提案。',
  CHAT_MOVED_ON: '这条接话已错过时机。',
} satisfies Record<ChatReplyStop, string>
export const actionView = z.object({
  id: z.uuid(), runId: z.uuid(), mode: z.literal('SIMULATION'), kind: z.literal('REPLY'),
  state: z.enum(['WAITING_APPROVAL', 'READY', 'REJECTED', 'CANCELED', 'EXPIRED', 'EXECUTING', 'RECONCILING', 'SIMULATED', 'BLOCKED']),
  version: z.number().int(), target: reviewTarget,
  expiresAt: z.iso.datetime(), reviewDigest: z.string(),
  riskCodes: z.array(z.string()), content: z.string().nullable(),
  chatStop: chatReplyStop.nullable(),
  messageContext: simulationReviewContext.nullable(),
  autoApproved: z.boolean(),
  autoReviewPending: z.boolean(),
  review: z.object({ decision: z.enum(['APPROVE', 'REJECT']), at: z.iso.datetime(), reason: z.string().nullable(),
    reviewer: z.string().nullable() }).nullable(),
  autoReviewHandoff: autoReviewHandoff.nullable(),
  followUp: simulationFollowUp.nullable(),
})
export const actionDecision = reasonInput.extend({
  reason: optionalDecisionReason,
  decision: z.enum(['APPROVE', 'REJECT']),
  reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
})

const reconciliationOutcome = z.enum(['CONFIRMED', 'DEFINITELY_NOT_SENT'])
const reconciliationEvidence = z.string().regex(/^[0-9a-f]{64}$/)
export const reconciliationView = z.object({
  version: z.number().int(), state: actionView.shape.state,
  outcome: reconciliationOutcome.nullable(), evidenceRef: reconciliationEvidence.nullable(),
})
export const reconciliationInput = reasonInput.extend({
  outcome: reconciliationOutcome, evidenceRef: reconciliationEvidence,
})

export type ReconciliationView = z.infer<typeof reconciliationView>
export type ActionView = z.infer<typeof actionView>
