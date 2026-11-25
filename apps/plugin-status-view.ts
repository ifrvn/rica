import { modelSettingsContracts } from '@ricajs/plugin-hosted-models/shared'
import { z } from '@hono/zod-openapi'
import { pluginStatusView } from '@ricajs/contracts/plugin-status'
import { deploymentPluginsView } from './deployment-plugin-contracts.js'
import { newbiConnectionsView, newbiPendingDeliveries } from '@ricajs/plugin-newbi/shared'

export const consolePluginStatusView = pluginStatusView.extend({
  deployment: deploymentPluginsView.optional(),
  modelProfiles: modelSettingsContracts.modelProfileChoice.array().optional(),
  modelChecks: modelSettingsContracts.modelCheckStatus.array().optional(),
  defaultModelProfileId: modelSettingsContracts.modelActivationInput.shape.id.optional(),
  newbiRegistrationAvailable: z.boolean().optional(),
  newbiConnections: newbiConnectionsView.optional(),
  newbiPendingDeliveries: newbiPendingDeliveries.optional(),
})
