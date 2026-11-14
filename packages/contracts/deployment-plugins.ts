import { z } from '@hono/zod-openapi'
import { newbiEndpoint } from './newbi-pilot.js'

export const deploymentPluginIds = ['newbi', 'openai', 'anthropic', 'gemini', 'openai-compatible'] as const
export const deploymentPluginId = z.enum(deploymentPluginIds)
export type DeploymentPluginId = z.infer<typeof deploymentPluginId>
export const pluginStage = z.enum(['NOT_INSTALLED', 'INSTALLED', 'ENABLED'])
export const deploymentPluginChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['INSTALL', 'ENABLE', 'DISABLE']), id: deploymentPluginId }),
  z.strictObject({ action: z.literal('CONFIGURE_NEWBI'), endpoint: newbiEndpoint }),
])
export const deploymentPluginsView = z.object({
  version: z.number().int().nonnegative(),
  plugins: z.record(deploymentPluginId, pluginStage),
  newbi: z.object({ endpoint: z.string().nullable() }),
  configuredModel: z.string().nullable(),
})
export type DeploymentPluginsView = z.infer<typeof deploymentPluginsView>
