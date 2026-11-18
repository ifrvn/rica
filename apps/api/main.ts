import { serve } from '@hono/node-server'
import { Redis } from 'ioredis'
import { createDatabase } from '../../packages/persistence/client.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { localIssuer, loadManagementConfig } from './admin-auth.js'
import { createAdminAuth } from './admin-auth-routes.js'
import { createManagementApp } from './management.js'
import { createApp } from './app.js'
import { createHostedModelManagement, createModelSettingsStore, enabledModelSettings } from '@rica/plugin-hosted-models'
import { hostedModelsPluginId, modelSettingsContracts } from '@rica/plugin-hosted-models/shared'
import { denyPermission } from '../../packages/persistence/management.js'
import { connectNewbiSettings, createNewbiManagement, createNewbiOperations } from '@rica/plugin-newbi'
import { startModelPlugin, startSimulationPlatforms } from '../runtime-plugins.js'
import { modelSettingsDirectory } from '../../packages/runtime/settings-directory.js'
import { createDeploymentPluginStore } from '../deployment-plugins.js'
import { observationError, readPluginStatus, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'
import { readPluginRelease } from '../plugin-releases.js'
import { createAutoReviewer } from '../auto-review.js'

const config = loadConfig()
const managementConfig = loadManagementConfig()
const platforms = managementConfig ? await startSimulationPlatforms(process.env, 'api').catch(async (error: unknown) => {
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
const settingsDirectory = modelSettingsDirectory(config.databaseUrl)
const deploymentPlugins = createDeploymentPluginStore(settingsDirectory)
const newbi = connectNewbiSettings(deploymentPlugins.readConfiguration)
const modelSettings = createModelSettingsStore(settingsDirectory, modelSettingsContracts)
const activeModel = async () => (await modelSettings.read()).configuration.provider
const reviewSettings = enabledModelSettings(modelSettings, () => deploymentPlugins.isEnabled(hostedModelsPluginId))
const reviewReply = createAutoReviewer(async (check) => {
  const { configuration } = await reviewSettings.read()
  if (configuration.provider === 'simulated') return null
  const selected = await startModelPlugin(configuration)
  try { return await check(selected.model.implementation) }
  finally { await selected.stop() }
})
const management = managementConfig && managementDb && auth && platforms ? createManagementApp({
  db: managementDb, authenticate: auth.authenticate, origin: managementConfig.origin, cookie: managementConfig.cookie,
  resolveAdapter: platforms.resolveAdapter,
  pluginStatus: () => readPluginStatus(redis),
  pluginRelease: (services) => readPluginRelease(process.env.RICA_PLUGIN_RELEASE_MANIFEST, services),
  activeModel,
  modelProfileExists: async (id) => Object.hasOwn((await modelSettings.readSettings()).profiles, id),
  deploymentPlugins,
  plugins: [
    createNewbiManagement(managementDb, newbi, {
      ...createNewbiOperations(db, newbi),
      reviewReply,
      reportConnectorOperation: (service, succeeded) =>
        reportPluginResult(config.redisUrl, service, succeeded ? undefined : 'OPERATION_FAILED'),
    }),
    createHostedModelManagement({ modelSettings, startModelPlugin,
      authorize(actor) { if (actor.issuer !== localIssuer || !actor.canCreate) denyPermission() },
      isEnabled: () => deploymentPlugins.isEnabled(hostedModelsPluginId),
    }),
  ],
}) : undefined

const app = createApp({
  postgres: () => Promise.all([
    db.$queryRaw`SELECT 1`,
    managementDb && managementDb.$queryRaw`SELECT 1 FROM public.management_memberships,public.admin_users LIMIT 0`,
  ]),
  redis: () => redis.ping(),
}, management, auth?.app)
const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' })
const observation = platforms && startPluginHeartbeat(config.redisUrl, 'api', platforms.plugins)
console.info(JSON.stringify({ service: 'api', event: 'started', port: config.port }))

function shutdown() {
  observation?.stop()
  server.close(() => {
    redis.disconnect()
    void Promise.all([platforms?.stop(), db.$disconnect(), managementDb?.$disconnect()]).catch(() => {
      process.exitCode = 1
    })
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
