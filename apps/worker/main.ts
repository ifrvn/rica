import { startOutboxWorker, WorkerDependencyUnavailable } from './outbox.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { startCognitionPlugins } from '../runtime-plugins.js'

async function main() {
  const config = loadConfig()
  const plugins = await startCognitionPlugins(process.env, 'worker')
  const { model, platformVersion } = plugins
  let worker: Awaited<ReturnType<typeof startOutboxWorker>>
  try {
    worker = await startOutboxWorker(config.databaseUrl, config.redisUrl, model, platformVersion)
  } catch (error) {
    await plugins.stop()
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
    } finally {
      await plugins.stop()
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
