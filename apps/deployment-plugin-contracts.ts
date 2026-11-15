import { z } from '@hono/zod-openapi'
import { newbiDeploymentChange } from '@rica/plugin-newbi/contracts'
import { pluginStage } from '../packages/contracts/deployment-plugins.js'

export const deploymentPluginIds = ['newbi', 'openai', 'anthropic', 'gemini', 'openai-compatible'] as const
export const deploymentPluginId = z.enum(deploymentPluginIds)
export type DeploymentPluginId = z.infer<typeof deploymentPluginId>
export const deploymentPluginChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['INSTALL', 'ENABLE', 'DISABLE']), id: deploymentPluginId }),
  newbiDeploymentChange,
])
export const deploymentPluginsView = z.object({
  version: z.number().int().nonnegative(),
  plugins: z.record(deploymentPluginId, pluginStage),
  newbi: z.object({ endpoint: z.string().nullable() }),
  configuredModel: z.string().nullable(),
})
export type DeploymentPluginsView = z.infer<typeof deploymentPluginsView>
