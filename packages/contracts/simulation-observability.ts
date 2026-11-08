import { z } from '@hono/zod-openapi'

const timestamp = z.iso.datetime({ offset: true })
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
