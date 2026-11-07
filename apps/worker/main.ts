import { startOutboxWorker, WorkerDependencyUnavailable } from './outbox.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { resolveModelProvider } from '../../packages/runtime/model-provider.js'

async function main() {
  const config = loadConfig()
  const model = resolveModelProvider(process.env.RICA_MODEL_PROVIDER ?? 'simulated')
  let worker: Awaited<ReturnType<typeof startOutboxWorker>>
  try {
    worker = await startOutboxWorker(config.databaseUrl, config.redisUrl, model)
  } catch (error) {
    if (!(error instanceof WorkerDependencyUnavailable)) throw error
    console.error(JSON.stringify({
      service: 'worker', event: 'not_ready', modelId: model.id, dependencies: error.dependencies,
    }))
    process.exitCode = 1
    return
  }

  async function shutdown() {
    try {
      await worker.close()
    } catch {
      process.exitCode = 1
    }
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.info(JSON.stringify({ service: 'worker', event: 'ready', modelId: model.id, modelVersion: model.version }))
}

await main().catch(() => {
  console.error(JSON.stringify({ service: 'worker', event: 'startup_failed', configuration: 'Check worker environment and model configuration' }))
  process.exitCode = 1
})
