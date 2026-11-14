import { serve } from '@hono/node-server'
import { Redis } from 'ioredis'
import { createDatabase } from '../../packages/persistence/client.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { loadManagementConfig } from './admin-auth.js'
import { createAdminAuth } from './admin-auth-routes.js'
import { createManagementApp } from './management.js'
import { createApp } from './app.js'
import { identifyNewbiAccount } from '../worker/newbi-read-plugin.js'
import { startSimulationPlatforms } from '../runtime-plugins.js'
import { createModelSettingsStore, modelSettingsDirectory } from '../../packages/runtime/model-settings-store.js'
import { createDeploymentPluginStore } from '../../packages/runtime/deployment-plugins.js'
import { observationError, readPluginStatus, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'
import { readPluginRelease } from '../plugin-releases.js'
import { openSavedNewbiExecutor, openSavedNewbiReader, scopedNewbiDatabase } from '../worker/newbi-database.js'
import { pollNewbiEvents } from '../../packages/persistence/newbi-events.js'
import { executeNewbiReply } from '../../packages/persistence/newbi-execution.js'
import { newbiExecutorKey } from '../../packages/contracts/newbi-executor-identity.js'

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
const newbiReaderDb = scopedNewbiDatabase(db, 'reader')
const newbiExecutorDb = scopedNewbiDatabase(db, 'executor')
const management = managementConfig && managementDb && auth && platforms ? createManagementApp({
  db: managementDb, authenticate: auth.authenticate, origin: managementConfig.origin, cookie: managementConfig.cookie,
  resolveAdapter: platforms.resolveAdapter,
  pluginStatus: () => readPluginStatus(redis),
  pluginRelease: (services) => readPluginRelease(process.env.RICA_PLUGIN_RELEASE_MANIFEST, services),
  modelSettings: createModelSettingsStore(settingsDirectory),
  deploymentPlugins,
  sendConnector: async (id, retry) => {
    const host = await openSavedNewbiExecutor(newbiExecutorDb, deploymentPlugins, id, AbortSignal.timeout(7000))
    if (!host) return { status: 'UNAVAILABLE' }
    try {
      return await executeNewbiReply(newbiExecutorDb, host.plugin.implementation, newbiExecutorKey(host.plugin), id, retry)
    } finally {
      await host.stop()
    }
  },
  pollConnector: async (accountId) => {
    const stop = AbortSignal.timeout(7000)
    const host = await openSavedNewbiReader(newbiReaderDb, deploymentPlugins, accountId, stop)
    if (!host) return
    try {
      return await pollNewbiEvents(newbiReaderDb, host.plugin.implementation, accountId, stop)
    } finally {
      await host.stop()
    }
  },
  identifyConnector: async (credential, endpoint) => {
    const current = await deploymentPlugins.openNewbi(credential, endpoint)
    return current && identifyNewbiAccount(current.connection, current.beforeRequest)
  },
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
