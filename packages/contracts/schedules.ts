import { z } from '@hono/zod-openapi'
import { characterInput, resourceId } from './management.js'

const scheduleRule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('DAILY'), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
  z.strictObject({ kind: z.literal('REMINDER'), dueAt: z.iso.datetime() }),
])

export const scheduleUpdate = z.strictObject({
  zone: characterInput.shape.timezone, enabled: z.boolean(), rule: scheduleRule,
})

export const scheduleInput = scheduleUpdate.extend({
  scheduleKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  accountId: resourceId, conversationId: resourceId, contactId: resourceId.optional(),
})

export const scheduleView = scheduleUpdate.extend({
  id: resourceId, scheduleKey: z.string(), accountId: resourceId,
  conversationId: resourceId, contactId: resourceId.nullable(),
  version: z.number().int(), nextAt: z.iso.datetime().nullable(),
})
