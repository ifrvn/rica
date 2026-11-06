import { serve } from '@hono/node-server'
import { Redis } from 'ioredis'
import { createDatabase } from '../../packages/persistence/client.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { createApp } from './app.js'

const config = loadConfig()
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

const app = createApp({
  postgres: () => db.$queryRaw`SELECT 1`,
  redis: () => redis.ping(),
})
const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' })
console.info(JSON.stringify({ service: 'api', event: 'started', port: config.port }))

function shutdown() {
  server.close(() => {
    redis.disconnect()
    void db.$disconnect()
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
