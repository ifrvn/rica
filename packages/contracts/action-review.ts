import { z } from '@hono/zod-openapi'
import { reasonInput } from './management.js'

export const reviewTarget = z.object({
  platform: z.enum(['mock-a', 'mock-b']),
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
export const actionView = z.object({
  id: z.uuid(), runId: z.uuid(), mode: z.literal('SIMULATION'), kind: z.literal('REPLY'),
  state: z.enum(['WAITING_APPROVAL', 'READY', 'REJECTED', 'CANCELED', 'EXPIRED', 'EXECUTING', 'RECONCILING', 'SIMULATED', 'BLOCKED']),
  version: z.number().int(), target: reviewTarget,
  expiresAt: z.iso.datetime(), reviewDigest: z.string(),
  riskCodes: z.array(z.string()), content: z.string().nullable(),
})
export const actionDecision = reasonInput.extend({
  decision: z.enum(['APPROVE', 'REJECT']),
  reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
})

export type ActionView = z.infer<typeof actionView>
