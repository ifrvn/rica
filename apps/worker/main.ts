import { startOutboxWorker } from './outbox.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { resolveModelProvider } from '../../packages/runtime/model-provider.js'

const config = loadConfig()
const model = resolveModelProvider(process.env.RICA_MODEL_PROVIDER ?? 'simulated')
const worker = startOutboxWorker(config.databaseUrl, config.redisUrl, model)
console.info(JSON.stringify({ service: 'worker', event: 'started', modelId: model.id, modelVersion: model.version }))

async function shutdown() {
  try {
    await worker.close()
  } catch {
    process.exitCode = 1
  }
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
