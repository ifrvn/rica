import { modelSettingsContracts } from '@rica/plugin-hosted-models/shared'
import { z } from '@hono/zod-openapi'
import { pluginStatusView } from '../packages/contracts/plugin-status.js'
import { deploymentPluginsView } from './deployment-plugin-contracts.js'
import { newbiConnectionsView, newbiPendingDeliveries } from '@rica/plugin-newbi/shared'

export const consolePluginStatusView = pluginStatusView.extend({
  deployment: deploymentPluginsView.optional(),
  modelCheck: modelSettingsContracts.modelCheckStatus.optional(),
  newbiRegistrationAvailable: z.boolean(),
  newbiConnections: newbiConnectionsView.optional(),
  newbiPendingDeliveries: newbiPendingDeliveries.optional(),
})
