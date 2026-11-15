import type { z } from '@hono/zod-openapi'
import type { newbiConnectionsView } from '../contracts.js'

type Tone = 'default' | 'success' | 'warning' | 'error'
export type HealthNode = { id: string; label: string; description: string; state: string; tone: Tone; at?: string; diagnostic?: string }

export function newbiHealth(status: { deployment?: { plugins: { newbi: string }; newbi: { endpoint: string | null } }; newbiConnections?: z.infer<typeof newbiConnectionsView> } | undefined,
  processNode: (id: 'connector-reader' | 'connector-executor', label: string, description: string) => HealthNode,
  external: (id: string, label: string, description: string, configured: boolean) => HealthNode) {
  const deployment = status?.deployment
  if (deployment?.plugins.newbi !== 'ENABLED') return { readers: [], executors: [], dependencies: [] }
  const reader = processNode('connector-reader', '读取 Newbi 消息', '独立读取平台事件到账号收件箱。账号接入及读取记录可在平台账号池查看。')
  const executor = processNode('connector-executor', '发送 Newbi 回复', '单次发送命令的最近报告。每条回复都须取得对应的发送许可。')
  const configured = !!deployment?.newbi.endpoint
  const read = external('newbi-read', 'Newbi 读取 API', '按当前角色已启用的账号汇总。可在平台账号池查看每个账号的读取结果。', configured)
  const write = external('newbi-write', 'Newbi 发送 API', '依据当前角色的发送结果。可在审批页查看对应的 Newbi 回执。', configured)
  const observed = status?.newbiConnections
  if (observed) {
    read.state = observed.readFailures ? observed.readFailures + ' 个账号读取失败'
      : observed.lastReadAt ? '有成功读取记录' : observed.activeAccounts ? '待首次读取' : '等待启用账号'
    read.tone = observed.readFailures ? 'warning' : observed.lastReadAt ? 'success' : 'default'
    read.at = observed.lastReadAt ?? undefined
    write.state = observed.hasUnknown ? '有发送结果待核对' : observed.hasReceipt ? '有确认回执' : '待首次确认回执'
    write.tone = observed.hasUnknown ? 'warning' : observed.hasReceipt ? 'success' : 'default'
  }
  return { readers: [reader], executors: [executor], dependencies: [read, write] }
}

export const isNewbiReadNode = (id: string) => id === 'connector-reader' || id === 'newbi-read'
