import { z } from '@hono/zod-openapi'
import { planningTask } from './plans.js'

const fields = {
  kind: z.enum(['PLAN', 'COMMITMENT']),
  title: z.string().trim().min(1).max(72).regex(/^[^\p{Cc}]+$/u),
  task: planningTask,
  dueAt: z.iso.datetime().optional(),
  dailyAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
}
const timing = ({ kind, dueAt, dailyAt }: {
  kind: 'PLAN' | 'COMMITMENT'; dueAt?: string; dailyAt?: string
}) => dailyAt ? kind === 'PLAN' && !dueAt : !!dueAt
const platform = z.enum(['mock-a', 'mock-b', 'newbi'])
const participantTask = z.strictObject({ platform, task: planningTask })

export const modelFollowUp = z.strictObject({
  ...fields,
  additionalTasks: z.array(participantTask).max(2).optional(),
  collaboratorPlatforms: z.array(platform).max(2).optional(),
}).refine(timing).refine(({ kind, additionalTasks, collaboratorPlatforms }) =>
  kind === 'PLAN' ? !collaboratorPlatforms?.length : !additionalTasks?.length)

export const simulationFollowUp = z.strictObject({
  ...fields,
  participants: z.array(z.strictObject({
    platform,
    task: planningTask.optional(),
    identityId: z.uuid(),
    accountId: z.uuid(),
    identity: z.string(),
    account: z.string(),
  })).max(2).optional(),
  zone: z.string().optional(),
}).refine(timing).refine(({ dailyAt, zone }) => !dailyAt || !!zone)
