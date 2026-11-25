import type { z } from '@hono/zod-openapi'
import type { newbiAssessmentResult, newbiReplySummary } from '../../management/contracts.js'

export const assessmentStatusLabels = {
  SUGGEST_REPLY: '建议回应', NO_REPLY: '本帖暂不回应', UNAVAILABLE: '评估未完成', PENDING: '评估中',
} satisfies Record<z.infer<typeof newbiAssessmentResult>['status'], string>

export const replyStatusLabels = {
  WAITING: '待审批', READY: '待发送', REJECTED: '已拒绝', IN_FLIGHT: '发送中',
  UNKNOWN: '待核对', SENT: '已发送', CLOSED: '已结案',
} satisfies Record<z.infer<typeof newbiReplySummary>['status'], string>
