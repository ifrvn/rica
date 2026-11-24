import { z } from '@hono/zod-openapi'

export const remotePluginId = z.string().max(50).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
export const pluginAccountId = z.uuid().transform(value => value.toLowerCase())
const bindingVersion = z.number().int().min(1).max(2_147_483_647)
const timestamp = z.iso.datetime().regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
const activityPayload = z.strictObject({
  kind: z.enum(['ASSESSMENT', 'PROPOSAL']),
  state: z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/),
})

export const pluginActivityEvent = z.strictObject({
  id: pluginAccountId,
  type: z.literal('activity.recorded.v1'),
  characterId: pluginAccountId,
  bindingVersion,
  occurredAt: timestamp,
  payload: activityPayload,
})
export type PluginActivityEvent = z.infer<typeof pluginActivityEvent>

export const pluginEventOffset = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .refine(value => value.length < 19 || value <= '9223372036854775807')
export const pluginEventQuery = z.strictObject({
  bindingVersion: z.coerce.number().pipe(bindingVersion),
  after: pluginEventOffset.default('0'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const pluginEventPage = z.strictObject({
  items: z.array(pluginActivityEvent.extend({
    offset: pluginEventOffset,
    pluginId: remotePluginId,
  })),
  nextOffset: pluginEventOffset,
})

export const remoteTaskType = remotePluginId
export const remoteTaskInput = z.strictObject({
  accountId: pluginAccountId, bindingVersion, type: remoteTaskType, data: z.json(),
})
export const remoteTaskClaim = z.strictObject({ bindingVersion })
export const remoteTaskReceipt = z.strictObject({
  bindingVersion, lease: pluginAccountId, status: z.enum(['SUCCEEDED', 'FAILED']), result: z.json(),
})
export const remoteTaskLeaseView = z.strictObject({
  task: remoteTaskInput.extend({
    id: pluginAccountId, characterId: pluginAccountId, lease: pluginAccountId, leaseUntil: z.iso.datetime({ offset: true }),
  }).nullable(),
})
export const remoteTaskReceiptView = remoteTaskReceipt.pick({ status: true }).extend({ id: pluginAccountId })
