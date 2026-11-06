import { startOutboxWorker } from './outbox.js'
import { loadConfig } from '../../packages/runtime/config.js'

const config = loadConfig()
const worker = startOutboxWorker(config.databaseUrl, config.redisUrl)
console.info(JSON.stringify({ service: 'worker', event: 'started' }))

async function shutdown() {
  try {
    await worker.close()
  } catch {
    process.exitCode = 1
  }
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
