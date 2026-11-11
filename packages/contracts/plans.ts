import { z } from '@hono/zod-openapi'
import { resourceId } from './management.js'
import { scheduleUpdate } from './schedules.js'

export const planningTask = z.string().trim().min(1).max(300).refine((value) => !value.includes('\0'))
const participantInput = z.strictObject({ identityId: resourceId, accountId: resourceId, task: planningTask })
export const planInput = scheduleUpdate.extend({
  title: z.string().trim().min(1).max(72).regex(/^[^\p{Cc}]+$/u),
  participants: z.array(participantInput).min(1).max(20).refine((items) =>
    new Set(items.map(({ identityId }) => identityId)).size === items.length, 'Select each identity once'),
})
export const planStateInput = z.strictObject({ enabled: z.boolean() })
export const planView = planInput.extend({
  id: resourceId,
  version: z.number().int().positive(),
  source: z.enum(['MANUAL', 'AI']),
  humanEdited: z.boolean(),
  participants: z.array(participantInput.extend({
    platform: z.string(), accountStatus: z.string(), nextAt: z.iso.datetime().nullable(),
    lastRunId: resourceId.nullable(),
  })),
})
