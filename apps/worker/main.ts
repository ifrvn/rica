import { startOutboxWorker, WorkerDependencyUnavailable } from './outbox.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { startCognitionPlugins } from '../runtime-plugins.js'
import { observationError, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'

async function main() {
  const config = loadConfig()
  const plugins = await startCognitionPlugins(process.env, 'worker').catch(async (error: unknown) => {
    await reportPluginResult(config.redisUrl, 'worker', observationError(error, 'START_FAILED'))
    throw error
  })
  const { model, resolveAdapter } = plugins
  let worker: Awaited<ReturnType<typeof startOutboxWorker>>
  try {
    worker = await startOutboxWorker(config.databaseUrl, config.redisUrl, model, resolveAdapter)
  } catch (error) {
    await plugins.stop()
    await reportPluginResult(config.redisUrl, 'worker',
      error instanceof WorkerDependencyUnavailable ? 'DEPENDENCY_UNAVAILABLE' : 'START_FAILED')
    if (!(error instanceof WorkerDependencyUnavailable)) throw error
    console.error(JSON.stringify({
      service: 'worker', event: 'not_ready', modelId: model.id, dependencies: error.dependencies,
    }))
    process.exitCode = 1
    return
  }

  const observation = startPluginHeartbeat(config.redisUrl, 'worker', plugins.plugins)
  async function shutdown() {
    observation.stop()
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
