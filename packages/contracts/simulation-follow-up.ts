import { z } from '@hono/zod-openapi'
import { planningTask } from './plans.js'

export const simulationFollowUp = z.strictObject({
  kind: z.enum(['PLAN', 'COMMITMENT']),
  title: z.string().trim().min(1).max(72).regex(/^[^\p{Cc}]+$/u),
  task: planningTask,
  dueAt: z.iso.datetime(),
})
