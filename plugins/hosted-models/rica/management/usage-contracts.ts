import { z } from '@hono/zod-openapi'

export const maxUsageDays = 90
export const usageQuery = z.object({ from: z.iso.date(), through: z.iso.date() }).refine(({ from, through }) => {
  const days = (Date.parse(through) - Date.parse(from)) / 86_400_000
  return days >= 0 && days < maxUsageDays
})
const count = z.number().int().nonnegative()
export const usageView = z.object({
  rows: z.array(z.object({
    day: z.iso.date(), provider: z.string(), model: z.string(),
    characterId: z.string(), character: z.string(), identityId: z.string(), identity: z.string(), platform: z.string(),
    purpose: z.enum(['DRAFT', 'REVIEW', 'CHECK']),
    outcome: z.enum(['OK', 'HTTP_ERROR', 'RATE_LIMITED', 'TIMED_OUT', 'CONNECTION_FAILED', 'INVALID_OUTPUT']),
    requests: count, tokenReports: count, sentBytes: count, receivedBytes: count, elapsedMs: count,
    inputTokens: count, outputTokens: count, totalTokens: count,
  })),
})
export type UsageQuery = z.infer<typeof usageQuery>
export type UsageRow = z.infer<typeof usageView>['rows'][number]
