import { z } from '@hono/zod-openapi'
import { listQuery, reasonInput, resourceId } from './management.js'

export const commitmentInput = reasonInput.extend({
  actionId: resourceId,
  title: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u),
  dueAt: z.iso.datetime(),
})

export const commitmentUpdate = z.discriminatedUnion('operation', [
  reasonInput.extend({ operation: z.literal('DEFER'), dueAt: z.iso.datetime() }),
  reasonInput.extend({ operation: z.enum(['FULFILL', 'CANCEL', 'EXPIRE']) }),
])

export const commitmentQuery = listQuery.extend({
  accountId: resourceId.optional(), contactId: resourceId.optional(),
})

export const commitmentView = z.object({
  id: resourceId, actionId: resourceId, scheduleId: resourceId,
  accountId: resourceId, conversationId: resourceId, contactId: resourceId.nullable(),
  title: z.string(), state: z.enum(['OPEN', 'DEFERRED', 'FULFILLED', 'CANCELED', 'EXPIRED']),
  version: z.number().int(), dueAt: z.iso.datetime(), nextAt: z.iso.datetime().nullable(),
})
