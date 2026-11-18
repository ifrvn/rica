import { z } from '@hono/zod-openapi'
import { newbiConfiguration, newbiDeployment } from '@ricajs/plugin-newbi/shared'
import { hostedModelsPluginId } from '@ricajs/plugin-hosted-models/shared'
import { pluginStage } from '@ricajs/contracts/deployment-plugins'

const hostedModelsDeployment = {
  id: hostedModelsPluginId,
  ownsComponent: (service: string, component: { kind: string; id: string }) =>
    service === 'worker' && component.kind === 'model' && component.id === hostedModelsPluginId,
} as const
export const deploymentPlugins = [newbiDeployment, hostedModelsDeployment] as const
export const deploymentPluginIds = deploymentPlugins.map(({ id }) => id)
export const deploymentPluginId = z.enum(deploymentPluginIds)
export type DeploymentPluginId = z.infer<typeof deploymentPluginId>
export const deploymentConfigurations = [newbiConfiguration] as const
export const deploymentPluginChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['INSTALL', 'ENABLE', 'DISABLE', 'UNINSTALL']), id: deploymentPluginId }),
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
