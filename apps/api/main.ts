import { logger } from '@ricajs/runtime/logging'
import { serve } from '@hono/node-server'
import { Redis } from 'ioredis'
import { createDatabase } from '@ricajs/persistence/client'
import { loadConfig } from '@ricajs/runtime/config'
import { localIssuer, loadManagementConfig } from './admin-auth.js'
import { createAdminAuth } from './admin-auth-routes.js'
import { createManagementApp } from './management.js'
import { createApp } from './app.js'
import { createHostedModelManagement, createModelSettingsStore, enabledModelSettings } from '@ricajs/plugin-hosted-models'
import { hostedModelCatalog, hostedModelsPluginId, modelSettingsContracts } from '@ricajs/plugin-hosted-models/shared'
import { denyPermission } from '@ricajs/persistence/management'
import { ricaManagement as newbiManagement } from '@ricajs/plugin-newbi/rica'
import newbiPackage from '@ricajs/plugin-newbi/package.json' with { type: 'json' }
import { startObservedModelPlugin, startSimulationPlatforms } from '../runtime-plugins.js'
import { hostedUsageRecorder, readHostedUsage } from '@ricajs/plugin-hosted-models/persistence/usage'
import { modelSettingsDirectory } from '@ricajs/runtime/settings-directory'
import { createDeploymentPluginStore } from '../deployment-plugins.js'
import { observationError, readPluginStatus, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'
import { readPluginRelease } from '../plugin-releases.js'
import { createAutoReviewer } from '../auto-review.js'
import { createDiscussionAssessor } from '../discussion-assessment.js'
import type { ModelProvider } from '@ricajs/contracts/model-provider'
import { loadPackageManagement } from '../package-plugins.js'
import { packageManagementPlugins, startManagedApi } from './package-management.js'
import { createRemotePluginEvents } from './remote-plugin-events.js'
import { createRemotePluginTasks } from './remote-plugin-tasks.js'
import { loadRemotePluginServices } from './remote-plugin-services.js'

const config = loadConfig()
const remoteManifest = process.env.RICA_REMOTE_PLUGIN_MANIFEST
const remoteServices = remoteManifest ? await loadRemotePluginServices(remoteManifest) : undefined
const managementConfig = loadManagementConfig()
const packageManagement = await loadPackageManagement(managementConfig ? process.env.RICA_PLUGIN_MANIFEST : undefined, {
  [newbiManagement.id]: newbiPackage.name,
})
const settingsDirectory = modelSettingsDirectory(config.databaseUrl)
const deploymentPlugins = createDeploymentPluginStore(settingsDirectory)
const platforms = managementConfig ? await deploymentPlugins.readSimulationPlatforms()
  .then(selection => startSimulationPlatforms(process.env, 'api', selection)).catch(async (error: unknown) => {
  await reportPluginResult(config.redisUrl, 'api', observationError(error, 'START_FAILED'))
  throw error
}) : undefined
const managementDb = managementConfig ? createDatabase(config.databaseUrl, 'rica_admin_api') : null
const db = createDatabase(config.databaseUrl)
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  commandTimeout: 2000,
  connectTimeout: 1500,
  maxRetriesPerRequest: 0,
})
redis.on('error', () => {})
void redis.connect().catch(() => {})

const auth = managementConfig && managementDb ? createAdminAuth(managementDb, redis, managementConfig) : undefined
const modelSettings = createModelSettingsStore(settingsDirectory, modelSettingsContracts)
const recordUsage = hostedUsageRecorder(db)
const activeModel = async () => (await modelSettings.read()).configuration.provider
const reviewSettings = enabledModelSettings(modelSettings, () => deploymentPlugins.isEnabled(hostedModelsPluginId))
async function withHostedModel<T>(check: (model: ModelProvider) => Promise<T>, profile?: string) {
  const { configuration } = await reviewSettings.read(profile)
  if (configuration.provider === 'simulated') return null
  const selected = await startObservedModelPlugin(configuration, recordUsage)
  try { return await check(selected.model.implementation) }
  finally { await selected.stop() }
}
const reviewReply = createAutoReviewer(withHostedModel)
const newbiApi = managementDb ? await startManagedApi(managementDb, packageManagement, newbiManagement, {
  databaseUrl: config.databaseUrl,
  readDeployment: () => deploymentPlugins.readConfiguration(newbiManagement.id),
  reviewReply,
  assessDiscussion: createDiscussionAssessor(withHostedModel),
  reportConnectorOperation: (service, succeeded) =>
    reportPluginResult(config.redisUrl, service, succeeded ? undefined : 'OPERATION_FAILED'),
}).catch(async (error: unknown) => {
  redis.disconnect()
  await Promise.allSettled([packageManagement.stop(), platforms?.stop(), db.$disconnect(), managementDb.$disconnect()])
  await reportPluginResult(config.redisUrl, 'api', 'START_FAILED')
  throw error
}) : undefined
const management = managementConfig && managementDb && auth && platforms && newbiApi ? createManagementApp({
  db: managementDb, authenticate: auth.authenticate, origin: managementConfig.origin, cookie: managementConfig.cookie,
  resolveAdapter: platforms.resolveAdapter,
  pluginStatus: () => readPluginStatus(redis),
  pluginRelease: (services) => readPluginRelease(process.env.RICA_PLUGIN_RELEASE_MANIFEST, services),
  activeModel,
  async reviewModel() {
    const { name, configuration } = await reviewSettings.read()
    if (configuration.provider === 'simulated' || !configuration.model) return null
    const provider = hostedModelCatalog.find(({ id }) => id === configuration.provider)?.name ?? configuration.provider
    return { name, provider, model: configuration.model }
  },
  modelProfileExists: async (id) => Object.hasOwn((await modelSettings.readSettings()).profiles, id),
  deploymentPlugins,
  activityViews: packageManagement.activityViews,
  consolePlugins: packageManagement.consolePlugins,
  remoteServices,
  plugins: [
    newbiApi.plugin,
    createHostedModelManagement({ modelSettings,
      startModelPlugin: (configuration) => startObservedModelPlugin(configuration, recordUsage, undefined, 'CHECK'),
      readUsage: (query) => readHostedUsage(managementDb, query),
      authorize(actor) { if (actor.issuer !== localIssuer || !actor.canCreate) denyPermission() },
      isEnabled: () => deploymentPlugins.isEnabled(hostedModelsPluginId),
    }),
    ...packageManagementPlugins(managementDb, packageManagement),
  ],
}) : undefined

const app = createApp({
  postgres: () => Promise.all([
    db.$queryRaw`SELECT 1`,
    managementDb && managementDb.$queryRaw`SELECT 1 FROM public.management_memberships,public.admin_users LIMIT 0`,
  ]),
  redis: () => redis.ping(),
}, management, auth?.app, remoteServices && createRemotePluginEvents(db, remoteServices),
remoteServices && createRemotePluginTasks(db, remoteServices))
const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' })
const observation = platforms && startPluginHeartbeat(config.redisUrl, 'api', platforms.plugins, platforms.source)
logger.info({ service: 'api', event: 'started', port: config.port })

function shutdown() {
  observation?.stop()
  server.close(() => {
    redis.disconnect()
    void Promise.all([newbiApi?.stop(), packageManagement.stop(), platforms?.stop(), db.$disconnect(), managementDb?.$disconnect()]).catch(() => {
      process.exitCode = 1
    })
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
