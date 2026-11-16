import { z } from '@hono/zod-openapi'
import { newbiConfiguration, newbiDeployment } from '@rica/plugin-newbi/shared'
import { modelPluginCatalog } from './model-plugin-catalog.js'
import { pluginStage } from '../packages/contracts/deployment-plugins.js'

const modelDeployments = modelPluginCatalog.map(({ id }) => ({
  id,
  ownsComponent: (service: string, component: { kind: string; id: string }) =>
    service === 'worker' && component.kind === 'model' && component.id === id,
}))
export const deploymentPlugins = [newbiDeployment, ...modelDeployments] as const
export const deploymentPluginIds = deploymentPlugins.map(({ id }) => id)
export const deploymentPluginId = z.enum(deploymentPluginIds)
export type DeploymentPluginId = z.infer<typeof deploymentPluginId>
export const deploymentConfigurations = [newbiConfiguration] as const
export const deploymentPluginChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['INSTALL', 'ENABLE', 'DISABLE']), id: deploymentPluginId }),
  ...deploymentConfigurations.map(({ change }) => change),
])
export const deploymentPluginsView = z.object({
  version: z.number().int().nonnegative(),
  plugins: z.record(deploymentPluginId, pluginStage),
  [newbiConfiguration.id]: newbiConfiguration.public,
  configuredModel: z.string().nullable(),
})
export type DeploymentPluginsView = z.infer<typeof deploymentPluginsView>

export const deploymentChangeOwner = (change: z.infer<typeof deploymentPluginChange>) => 'id' in change ? change.id
  : deploymentConfigurations.find(({ change: schema }) => schema.shape.action.value === change.action)?.id
