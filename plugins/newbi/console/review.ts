import type { NewbiDeploymentView } from '../management.js'
import type { z } from '@hono/zod-openapi'
import type { newbiCharacterWorkspaceView } from '../contracts.js'
import { newbiConsole } from './labels.js'
import Review from './ConnectorReview.vue'

export const newbiReview = {
  id: newbiConsole.id, title: newbiConsole.reviewTitle, component: Review,
  installed: (workspace: z.infer<typeof newbiCharacterWorkspaceView>) => workspace.newbiInstalled,
  deployed: (deployment: NewbiDeploymentView) => deployment.plugins.newbi !== 'NOT_INSTALLED',
}
