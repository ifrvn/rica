import type { z } from '@hono/zod-openapi'
import type { simulationRunQuery } from '../contracts/observability.js'

export const runFilterKeys = ['state', 'identityId', 'accountId', 'from', 'through'] as const

export const runStateLabels = {
  QUEUED: '已排队', CONTEXT_READY: '准备草稿', DRAFTED: '草稿已生成', WAITING_APPROVAL: '待审批', READY: '待执行',
  EXECUTING: '执行中', RECONCILING: '待对账', SIMULATED: '模拟完成',
  REJECTED: '已拒绝', BLOCKED: '已拦截', CANCELED: '已取消', EXPIRED: '已过期', SKIPPED: '已旁听',
} satisfies Record<NonNullable<z.infer<typeof simulationRunQuery>['state']>, string>
