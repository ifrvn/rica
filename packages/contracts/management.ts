import { z } from '@hono/zod-openapi'

export const resourceId = z.uuid().transform((value) => value.toLowerCase())
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
const text = z.string().trim().min(1).max(240).regex(/^[^\p{Cc}]+$/u)
const shortText = text.max(120)
export const reasonInput = z.strictObject({ reason: text })
export const coreProfile = z.strictObject({
  name: shortText.optional(),
  aiDisclosure: text,
  fictionalBackground: text.optional(),
  values: z.array(shortText).max(16).optional(),
  privacyRules: z.array(text).max(16).optional(),
})
const timezone = z.string().min(1).max(80).refine((timeZone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return !/^[+-]/.test(timeZone)
  } catch {
    return false
  }
})
const stateDeltas = z.array(z.number().min(-0.15).max(0.15)).length(7)
const stateRule = z.strictObject({
  motivationHalfLifeHours: z.number().min(1).max(168),
  affectHalfLifeHours: z.number().min(1).max(168),
  deltas: z.strictObject({ POST: stateDeltas, MENTION: stateDeltas, REPLY: stateDeltas }),
})
const energyLevel = z.enum(['LOW', 'NORMAL', 'HIGH'])
export const dailyEnergyInput = reasonInput.extend({ utcDay: z.iso.date(), energy: energyLevel })
export const dailyEnergyView = z.object({
  id: resourceId, utcDay: z.iso.date(), energy: energyLevel,
  approvedAt: z.iso.datetime({ offset: true }),
})

export const identityProfile = z.strictObject({
  displayName: shortText.optional(),
  timezone: timezone.optional(),
  stateRule: stateRule.optional(),
  writingStyle: z.enum(['neutral', 'formal', 'casual', 'concise']).optional(),
})
export const characterInput = z.strictObject({
  slug,
  timezone,
  coreProfile,
})
export const coreInput = reasonInput.extend({ coreProfile })
export const identityInput = z.strictObject({ slug, roleProfile: identityProfile })
export const identityUpdate = reasonInput.extend({ roleProfile: identityProfile })
export const accountInput = z.strictObject({
  identityId: resourceId,
  platform: z.enum(['mock-a', 'mock-b']),
  instanceKey: shortText,
  remoteAccountId: text,
})
export const controlInput = reasonInput.extend({
  scope: z.enum(['CHARACTER', 'IDENTITY', 'ACCOUNT']),
  scopeId: resourceId,
  operation: z.enum(['PAUSE', 'RESUME', 'REVOKE_ACCOUNT']),
})
export const membershipInput = reasonInput.extend({
  subject: z.string().min(1).max(512).regex(/^[^\p{Cc}]+$/u),
  role: z.enum(['ADMIN', 'OPERATOR', 'REVIEWER', 'AUDITOR']),
  action: z.enum(['GRANT', 'REVOKE']),
})
const goalStatus = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'DONE', 'CANCELED', 'EXPIRED'])
export const manualGoalInput = reasonInput.extend({
  title: text, status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'DONE', 'CANCELED']),
  priority: z.number().int().min(0).max(100), budget: z.number().int().min(1).max(100),
  dueAt: z.iso.datetime(), nextStep: text.optional(),
})
export const manualGoalView = z.object({
  id: resourceId, identityId: resourceId, version: z.number().int(), origin: z.literal('ADMIN'),
  title: z.string(), status: goalStatus, priority: z.number().int(), budget: z.number().int(),
  dueAt: z.iso.datetime({ offset: true }), nextStep: z.string().nullable(), createdAt: z.iso.datetime({ offset: true }),
})

export const contactBoundaryInput = reasonInput.extend({ blocked: z.boolean() })
export const contactBoundaryView = z.object({
  id: resourceId, accountId: resourceId, version: z.number().int(), blocked: z.boolean(),
  changedAt: z.iso.datetime({ offset: true }).nullable(), reason: z.string().nullable(),
})

export const memoryCorrectionInput = reasonInput.extend({
  content: z.string().trim().min(1).max(1500).refine((content) => !content.includes('\0')),
})
export const memoryProvenanceView = z.object({
  id: resourceId, revision: z.number().int(), status: z.enum(['ACTIVE', 'REVOKED']),
  parentMemoryId: resourceId.nullable(),
  sources: z.array(z.object({
    id: resourceId, kind: z.string(), classification: z.enum(['PUBLIC','PERSONAL','CONFIDENTIAL','RESTRICTED']),
    revokedAt: z.iso.datetime({ offset: true }).nullable(),
  })),
  corrections: z.array(z.object({
    revision: z.number().int(), actorId: z.string(), reason: z.string(), createdAt: z.iso.datetime({ offset: true }),
  })),
})

export const memoryGrantInput = reasonInput.extend({
  memoryId: resourceId,
  recipientIdentityId: resourceId,
  recipientAccountId: resourceId.optional(),
  recipientConversationId: resourceId.optional(),
  recipientContactId: resourceId.optional(),
  purpose: z.enum(['INTERNAL_CONTEXT', 'DECISION_SUPPORT', 'PUBLIC_REFERENCE', 'PRIVATE_REPLY']),
  audience: resourceId.optional(),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime(),
})
export const listQuery = z.object({
  limit: z.string().regex(/^(?:[1-9][0-9]?|100)$/).optional(),
  cursor: resourceId.optional(),
})
export const idempotencyHeader = z.object({
  'idempotency-key': z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
})
export const versionHeader = z.object({ 'if-match': z.string() })
export const errorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.uuid() }),
})
export const commandResponse = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  version: z.number().int().optional(),
  status: z.string().optional(),
  authEpoch: z.number().int().optional(),
})
export const characterView = z.object({
  id: z.uuid(), slug: z.string(), timezone: z.string(), status: z.string(),
  version: z.number().int().nullable(), profile: coreProfile.nullable(),
})
export const identityView = z.object({
  id: z.uuid(), slug: z.string(), status: z.string(),
  version: z.number().int().nullable(), profile: identityProfile.nullable(),
})
export const accountView = z.object({
  id: z.uuid(), identityId: z.uuid(), platform: z.string(), instanceKey: z.string(),
  status: z.string(), version: z.number().int(),
})
export const memoryView = z.object({
  id: z.uuid(), identityId: z.uuid().nullable(), accountId: z.uuid().nullable(),
  conversationId: z.uuid().nullable(), scope: z.string(), visibility: z.string(),
  status: z.string(), expiresAt: z.iso.datetime().nullable(),
})
export const grantView = z.object({
  id: z.uuid(), memoryId: z.uuid(), recipientIdentityId: z.uuid(),
  recipientAccountId: z.uuid().nullable(), purpose: z.string(), audience: z.string().nullable(),
  validFrom: z.iso.datetime(), validUntil: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(),
})
export const auditView = z.object({
  id: z.uuid(), operation: z.string(), actorId: z.string(), targetId: z.uuid(),
  requestId: z.uuid(), digest: z.string(), createdAt: z.iso.datetime(),
})

export function pageView<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() })
}
