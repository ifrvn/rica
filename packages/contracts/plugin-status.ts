import { z } from '@hono/zod-openapi'

export const pluginServices = ['api', 'worker', 'simulation-executor', 'connector-reader', 'connector-executor'] as const
export type PluginService = typeof pluginServices[number]

const pluginIdentity = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  contractVersion: z.number().int().positive(),
  kind: z.enum(['platform', 'model', 'platform-reader', 'platform-reply-executor']),
})
export type PluginMetadata = z.infer<typeof pluginIdentity>

export const pluginDiagnostic = z.enum([
  'UNKNOWN_PLUGIN', 'DUPLICATE_SELECTION', 'INVALID_CONFIG', 'MISSING_SERVICE', 'START_FAILED',
  'INCOMPATIBLE_CONTRACT', 'DUPLICATE_PLUGIN', 'INVALID_MANIFEST', 'DEPENDENCY_UNAVAILABLE', 'OPERATION_FAILED',
])
export type PluginDiagnostic = z.infer<typeof pluginDiagnostic>

export const pluginReport = z.strictObject({
  status: z.enum(['READY', 'COMPLETED', 'FAILED']),
  observedAt: z.iso.datetime(),
  plugins: z.array(pluginIdentity).max(20),
  diagnostic: pluginDiagnostic.optional(),
})
export type PluginReport = z.infer<typeof pluginReport>

export const pluginStatusView = z.object({
  services: z.array(z.object({
    service: z.enum(pluginServices),
    catalog: z.array(pluginIdentity),
    report: pluginReport.nullable(),
  })),
})
