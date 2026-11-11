import { serve } from '@hono/node-server'
import { Redis } from 'ioredis'
import { createDatabase } from '../../packages/persistence/client.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { loadManagementConfig } from './admin-auth.js'
import { createAdminAuth } from './admin-auth-routes.js'
import { createManagementApp } from './management.js'
import { createApp } from './app.js'
import { canVerifyNewbiBinding, verifyNewbiBinding } from '../worker/newbi-read-plugin.js'
import { startSimulationPlatforms } from '../runtime-plugins.js'
import { createModelSettingsStore, modelSettingsDirectory } from '../../packages/runtime/model-settings-store.js'
import { observationError, readPluginStatus, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'

const config = loadConfig()
const managementConfig = loadManagementConfig()
const platforms = managementConfig ? await startSimulationPlatforms(process.env, 'api').catch(async (error: unknown) => {
  await reportPluginResult(config.redisUrl, 'api', observationError(error, 'START_FAILED'))
  throw error
}) : undefined
const managementDb = managementConfig ? createDatabase(managementConfig.databaseUrl) : null
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
const management = managementConfig && managementDb && auth && platforms ? createManagementApp({
  db: managementDb, authenticate: auth.authenticate, origin: managementConfig.origin, cookie: managementConfig.cookie,
  resolveAdapter: platforms.resolveAdapter,
  pluginStatus: () => readPluginStatus(redis, canVerifyNewbiBinding()),
  modelSettings: createModelSettingsStore(modelSettingsDirectory(config.databaseUrl)),
  verifyConnector: verifyNewbiBinding,
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
