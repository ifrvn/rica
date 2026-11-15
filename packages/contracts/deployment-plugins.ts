import { z } from '@hono/zod-openapi'

export const pluginStage = z.enum(['NOT_INSTALLED', 'INSTALLED', 'ENABLED'])
export type PluginStage = z.infer<typeof pluginStage>
