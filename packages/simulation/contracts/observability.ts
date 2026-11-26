import { z } from '@hono/zod-openapi'

import { listQuery, resourceId } from '@ricajs/contracts/management'
import { maxSimulatedTextLength } from './platforms.js'
import { autoReviewHandoff } from '@ricajs/contracts/auto-review'
import { participationLevel, replyDecision } from '@ricajs/contracts/model-provider'
import { glossaryMeaning, glossaryReference, glossaryTone } from '@ricajs/contracts/glossary'
import { chatReplyStop } from './review.js'

const timestamp = z.iso.datetime({ offset: true })
const consoleMessage = {
  accountId: resourceId,
  message: z.string().trim().min(1).max(maxSimulatedTextLength).refine((value) => !value.includes('\0')),
}
export const consoleSimulationInput = z.union([z.strictObject(consoleMessage), z.strictObject({
  ...consoleMessage, chatId: resourceId, speaker: z.string().trim().min(1).max(40).regex(/^[^\p{Cc}]+$/u),
})])
export const simulationChatsQuery = listQuery
export const simulationChatSummary = z.object({ id: resourceId, createdAt: timestamp })
export const simulationTermUpdate = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('CORRECT'), meaning: glossaryMeaning, tone: glossaryTone }),
  z.strictObject({ operation: z.literal('DISABLE') }),
])
export const simulationChatView = z.object({
  id: resourceId, speakers: z.array(z.string()),
  glossary: z.array(glossaryReference.extend({ status: z.enum(['LEARNED', 'CORRECTED', 'DISABLED', 'UNAVAILABLE']),
    meaning: glossaryMeaning.nullable(), sourceRuns: z.array(resourceId) })),
  turns: z.array(z.object({
    id: resourceId, accountId: resourceId, identityId: resourceId,
    state: z.string(), speaker: z.string(), message: z.string().nullable(), sentAt: timestamp,
    replies: z.array(z.string()).nullable(), repliedAt: timestamp.nullable(),
  })),
})
export const simulationWritingContext = z.object({
  speaker: z.string(), history: z.array(z.object({ speaker: z.string(), message: z.string() })),
})
export const simulationRunQuery = listQuery.extend({
  state: z.enum(['QUEUED', 'CONTEXT_READY', 'DRAFTED', 'CANCELED', 'SKIPPED', 'WAITING_APPROVAL', 'READY', 'REJECTED',
    'EXPIRED', 'EXECUTING', 'RECONCILING', 'SIMULATED', 'BLOCKED']).optional(),
  identityId: resourceId.optional(),
  accountId: resourceId.optional(),
  from: z.iso.date().optional(),
  through: z.iso.date().optional(),
}).refine(({ from, through }) => (!from || from >= '0001-01-01') && (!through || through >= '0001-01-01')
  && (!from || !through || from <= through), 'Choose a valid inclusive UTC date range')

export const simulationRunSummary = z.object({
  id: resourceId, state: z.string(), identityId: resourceId, accountId: resourceId,
  platform: z.string(), createdAt: timestamp,
})
const evidence = z.discriminatedUnion('available', [
  z.object({ rank: z.number().int(), available: z.literal(true), memoryId: z.uuid(), revision: z.number().int() }),
  z.object({ rank: z.number().int(), available: z.literal(false) }),
])

export const runReplayView = z.object({
  id: z.uuid(), state: z.string(), stateVersion: z.number().int(), stateReason: z.string().nullable(),
  mode: z.literal('SIMULATION'), identityId: z.uuid(), accountId: z.uuid(),
  coreVersion: z.number().int(), identityVersion: z.number().int(),
  bindingVersion: z.number().int(), authEpoch: z.number().int(),
  occurredAt: timestamp, createdAt: timestamp, contextTimezone: z.string().nullable(),
  chatId: resourceId.nullable(),
  chatStop: chatReplyStop.nullable(),
  autoReviewPending: z.boolean(),
  manualReviewAllowed: z.boolean(),
  autoApproved: z.boolean(),
  autoReviewHandoff: autoReviewHandoff.nullable(),
  executionWait: z.object({
    reason: z.enum(['QUIET_HOURS', 'DAILY_LIMIT', 'CONTACT_COOLDOWN', 'ACCOUNT_BUSY', 'ACCOUNT_RECONCILING', 'PROPOSAL_EXPIRED']),
    nextAt: timestamp.nullable(),
  }).nullable(),
  inbound: z.object({ kind: z.enum(['POST', 'REPLY', 'MENTION']), receivedAt: timestamp }),
  draft: z.object({ createdAt: timestamp, modelId: z.string().nullable(), modelVersion: z.string().nullable() }).nullable(),
  systemPrompts: z.object({ core: z.string().nullable(), identity: z.string().nullable() }).nullable(),
  participationDecision: z.object({ participation: participationLevel,
    action: z.enum(['NO_OP', 'REPLY']), reason: z.union([replyDecision.options[0].shape.reason, replyDecision.options[1].shape.reason]) }).nullable(),
  modelCalls: z.array(z.object({ id: resourceId, stage: z.enum(['DECISION', 'WRITING', 'REVIEW']),
    model: z.string(), at: timestamp, systemPrompt: z.string().nullable(), output: z.string().nullable() })),
  glossary: z.array(glossaryReference).max(4),
  transcript: z.object({ message: z.string(), draft: z.string().nullable(), reviewReason: z.string() }).nullable(),
  goalRefs: z.array(z.object({ id: z.uuid(), version: z.number().int() })),
  referencesExpiredAt: timestamp.nullable(),
  beliefRefs: z.array(z.object({ id: z.uuid(), version: z.number().int() })).max(8),
  snapshots: z.array(z.object({
    id: z.uuid(), purpose: z.enum(['INTERNAL_CONTEXT', 'DECISION_SUPPORT', 'PUBLIC_REFERENCE', 'PRIVATE_REPLY']),
    rankingVersion: z.number().int(), createdAt: timestamp, evidence: z.array(evidence),
  })),
  proposal: z.object({
    id: z.uuid(), policyVersion: z.number().int(), adapterId: z.string(), adapterVersion: z.string(),
    adapterContractVersion: z.number().int().positive(),
    modelId: z.string().nullable(), modelVersion: z.string().nullable(),
    createdAt: timestamp, reviewedAt: timestamp.nullable(), permittedAt: timestamp.nullable(),
    reviewDecision: z.enum(['APPROVE', 'REJECT']).nullable(),
    attemptStatus: z.enum(['PERMITTED', 'UNKNOWN', 'CONFIRMED', 'NOT_SENT']).nullable(), receiptAt: timestamp.nullable(),
  }).nullable(),
  schedule: z.object({
    scheduleId: z.uuid(), scheduleVersion: z.number().int(), scheduledAt: timestamp, commitmentId: z.uuid().nullable(),
  }).nullable(),
})

export const dailyMetricsQuery = z.object({ from: z.iso.date(), through: z.iso.date() }).refine(({ from, through }) => {
  const span = Date.parse(through) - Date.parse(from)
  return from >= '0001-01-01' && span >= 0 && span <= 30 * 86_400_000
}, 'Choose an inclusive range of up to 31 UTC days')

const count = z.number().int().nonnegative()
export const simulationDailyRow = z.object({
  utcDay: z.iso.date(), proposals: count, approvals: count, rejections: count, duplicateFlags: count,
  draftLatencyMs: count.nullable(), receipts: count, peakAccountReceipts: count, flaggedReceipts: count,
  receiptsWithoutApproval: count, reservedUnits: count, modelCalls: count, budgetDenials: count,
})
export const simulationDailyMetricsView = z.object({
  days: z.array(simulationDailyRow).max(31),
  alerts: z.array(z.enum(['FLAGGED_RECEIPTS', 'UNAPPROVED_RECEIPTS', 'MODEL_BUDGET_EXHAUSTED',
    'RECEIPT_VOLUME_DRIFT', 'REVIEW_RATE_DRIFT'])),
})

export const outboxQuarantineQuery = z.object({ after: z.uuid().optional() })
export const quarantinedOutboxEvent = z.object({
  id: z.uuid(), runId: z.uuid(), type: z.enum(['RunQueued.v1', 'SimulatedDraftQueued.v1']),
  generation: z.number().int().nonnegative(), attempts: z.literal(4), quarantinedAt: timestamp,
})
export const outboxQuarantineView = z.object({
  items: z.array(quarantinedOutboxEvent), nextCursor: z.uuid().nullable(),
})

const backlog = z.object({ count: z.number().int().nonnegative(), oldestAt: timestamp.nullable() })

export const simulationBacklogView = z.object({
  observedAt: timestamp,
  outbox: backlog.extend({ enqueued: count, quarantined: count }),
  approvals: backlog,
  reconciliation: backlog,
  schedules: backlog,
})
