import { z } from '@hono/zod-openapi'
import { deploymentPluginId, deploymentPluginsView } from './deployment-plugins.js'
import { modelCheckStatus } from './model-settings.js'

export const pluginServices = ['api', 'worker', 'simulation-executor', 'connector-reader', 'connector-executor'] as const
export type PluginService = typeof pluginServices[number]

const pluginIdentity = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  contractVersion: z.number().int().positive(),
  kind: z.enum(['platform', 'model', 'platform-reader', 'platform-reply-executor']),
})
export type PluginMetadata = z.infer<typeof pluginIdentity>

const releaseVersion = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u)
const releaseUrl = z.url({ protocol: /^https$/ }).max(2048).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash
})
const releaseComponent = pluginIdentity.extend({ version: releaseVersion })
export const pluginReleaseManifest = z.strictObject({
  schemaVersion: z.literal(1),
  ricaVersion: releaseVersion,
  releaseUrl,
  components: z.array(releaseComponent).min(1).max(100).refine((entries) =>
    new Set(entries.map(({ kind, id }) => kind + '/' + id)).size === entries.length),
})

const pluginUpgrade = z.object({
  id: deploymentPluginId,
  components: z.array(z.object({
    service: z.enum(pluginServices),
    current: pluginIdentity,
    target: releaseComponent.nullable(),
    problem: z.enum(['MISSING_COMPONENT', 'INCOMPATIBLE_CONTRACT', 'DOWNGRADE']).nullable(),
  })),
})
export const pluginReleaseView = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['UNCONFIGURED', 'UNAVAILABLE']) }),
  z.object({ status: z.literal('AVAILABLE'), ricaVersion: releaseVersion, releaseUrl, upgrades: z.array(pluginUpgrade) }),
])
export type PluginReleaseView = z.infer<typeof pluginReleaseView>

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
  newbiRegistrationAvailable: z.boolean(),
  deployment: deploymentPluginsView.optional(),
  release: pluginReleaseView.optional(),
  modelCheck: modelCheckStatus.optional(),
  newbiConnections: z.object({
    activeAccounts: z.number().int().nonnegative(),
    readFailures: z.number().int().nonnegative(),
    lastReadAt: z.iso.datetime().nullable(),
    hasReceipt: z.boolean(),
    hasUnknown: z.boolean(),
  }).optional(),
  services: z.array(z.object({
    service: z.enum(pluginServices),
    catalog: z.array(pluginIdentity),
    report: pluginReport.nullable(),
  })),
})
