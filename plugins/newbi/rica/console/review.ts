import type { NewbiDeploymentView } from '../deployment/settings.js'
import type { z } from '@hono/zod-openapi'
import type { newbiCharacterWorkspaceView, newbiReplySummary } from '../management/contracts.js'
import { characterPath, queryPath, type Page } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import { newbiConsole } from './labels.js'
import Review from './ConnectorReview.vue'
import AssessmentHistory from './AssessmentHistory.vue'
import { assessmentStatusLabels, replyStatusLabels } from './activity-labels.js'

const queues = [
  { status: 'WAITING', label: '待审批' },
  { status: 'READY', label: '待发送' },
  { status: 'UNKNOWN', label: '待核对' },
]

export const newbiReview = {
  id: newbiConsole.id, title: newbiConsole.reviewTitle, component: Review,
  activity: { title: newbiConsole.name, assessment: AssessmentHistory,
    states: { ASSESSMENT: assessmentStatusLabels, PROPOSAL: replyStatusLabels } },
  ownsAudit: (operation: string) => operation.startsWith('newbi.reply.'),
  installed: (workspace: z.infer<typeof newbiCharacterWorkspaceView>) => workspace.newbiInstalled,
  deployed: (deployment: NewbiDeploymentView) => deployment.plugins.newbi !== 'NOT_INSTALLED',
  workbench(characterId: string, canManage: boolean) {
    const path = characterPath(characterId) + '/newbi/replies'
    return Promise.all((canManage ? queues : queues.slice(0, 1)).map(async (queue) => {
      const { items } = await request<Page<z.infer<typeof newbiReplySummary>>>(queryPath(path, { status: queue.status, limit: '2' }))
      return { ...queue, items: items.map(({ id, identity, createdAt }) => ({ id, title: identity, createdAt })) }
    }))
  },
}
