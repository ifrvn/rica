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
  beliefRefs: z.array(z.object({ id: z.uuid(), version: z.number().int() })).max(8),
  snapshots: z.array(z.object({
    id: z.uuid(), purpose: z.enum(['INTERNAL_CONTEXT', 'DECISION_SUPPORT', 'PUBLIC_REFERENCE', 'PRIVATE_REPLY']),
    rankingVersion: z.number().int(), createdAt: timestamp, evidence: z.array(evidence),
  })),
  proposal: z.object({
    id: z.uuid(), policyVersion: z.number().int(), adapterVersion: z.string(),
    modelId: z.string().nullable(), modelVersion: z.string().nullable(),
    reviewDecision: z.enum(['APPROVE', 'REJECT']).nullable(),
    attemptStatus: z.enum(['PERMITTED', 'UNKNOWN', 'CONFIRMED', 'NOT_SENT']).nullable(), receiptAt: timestamp.nullable(),
  }).nullable(),
  schedule: z.object({
    scheduleId: z.uuid(), scheduleVersion: z.number().int(), scheduledAt: timestamp, commitmentId: z.uuid().nullable(),
  }).nullable(),
})

const backlog = z.object({ count: z.number().int().nonnegative(), oldestAt: timestamp.nullable() })

export const simulationBacklogView = z.object({
  observedAt: timestamp,
  outbox: backlog.extend({ enqueued: z.number().int().nonnegative() }),
  approvals: backlog,
  reconciliation: backlog,
  schedules: backlog,
})
