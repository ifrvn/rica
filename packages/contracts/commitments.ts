import { z } from '@hono/zod-openapi'
import { listQuery, reasonInput, resourceId } from './management.js'
import { planningTask } from './plans.js'

const collaborator = z.strictObject({ identityId: resourceId, accountId: resourceId })
const commitmentDetails = reasonInput.extend({
  title: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u),
  task: planningTask,
  dueAt: z.iso.datetime(),
  collaborators: z.array(collaborator).max(20).refine((items) =>
    new Set(items.map(({ identityId }) => identityId)).size === items.length, 'Select each collaborator once'),
})

export const commitmentInput = commitmentDetails.extend({ actionId: resourceId })
export const commitmentUpdate = z.discriminatedUnion('operation', [
  commitmentDetails.extend({ operation: z.literal('EDIT') }),
  reasonInput.extend({ operation: z.literal('DEFER'), dueAt: z.iso.datetime() }),
  reasonInput.extend({ operation: z.enum(['FULFILL', 'CANCEL', 'EXPIRE']) }),
])

export const commitmentQuery = listQuery.extend({
  accountId: resourceId.optional(), contactId: resourceId.optional(),
})

export const commitmentView = z.object({
  id: resourceId, actionId: resourceId, scheduleId: resourceId,
  accountId: resourceId, identityId: resourceId, conversationId: resourceId, contactId: resourceId.nullable(),
  contactLabel: z.string().nullable(),
  title: z.string(), task: z.string().nullable(), state: z.enum(['OPEN', 'DEFERRED', 'FULFILLED', 'CANCELED', 'EXPIRED']),
  source: z.enum(['MANUAL', 'AI']),
  collaborators: z.array(collaborator.extend({ platform: z.string(), accountStatus: z.string() })),
  version: z.number().int(), dueAt: z.iso.datetime(), nextAt: z.iso.datetime().nullable(),
})

export const commitmentReceiptQuery = listQuery.extend({ runId: resourceId.optional() })
export const commitmentReceiptView = z.object({
  id: resourceId, runId: resourceId, identityId: resourceId, accountId: resourceId, platform: z.string(),
  contactId: resourceId.nullable(), contactLabel: z.string().nullable(), receiptAt: z.iso.datetime(),
})
