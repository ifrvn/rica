import { startOutboxWorker, WorkerDependencyUnavailable } from './outbox.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { startConfiguredModel, startSimulationPlatforms } from '../runtime-plugins.js'
import { createModelSettingsStore, modelSettingsDirectory } from '../../packages/runtime/model-settings-store.js'
import { observationError, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'

async function main() {
  const config = loadConfig()
  const settings = createModelSettingsStore(modelSettingsDirectory(config.databaseUrl))
  const selected = await startConfiguredModel(settings, 'worker').catch(async (error: unknown) => {
    await reportPluginResult(config.redisUrl, 'worker', observationError(error, 'START_FAILED'))
    throw error
  })
  const platforms = await startSimulationPlatforms(process.env, 'worker').catch(async (error: unknown) => {
    await selected.stop()
    await reportPluginResult(config.redisUrl, 'worker', observationError(error, 'START_FAILED'))
    throw error
  })
  let observation: ReturnType<typeof startPluginHeartbeat> | undefined
  let settingsFailed = false
  async function getModel() {
    const previous = selected.metadata
    try {
      const model = await selected.read()
      if (settingsFailed || previous !== selected.metadata) observation?.ready([...platforms.plugins, selected.metadata])
      settingsFailed = false
      return model
    } catch (error) {
      settingsFailed = true
      observation?.failed(observationError(error, 'INVALID_CONFIG'))
      throw error
    }
  }

  let worker: Awaited<ReturnType<typeof startOutboxWorker>>
  try {
    worker = await startOutboxWorker(config.databaseUrl, config.redisUrl, getModel, platforms.resolveAdapter)
  } catch (error) {
    await Promise.all([selected.stop(), platforms.stop()])
    await reportPluginResult(config.redisUrl, 'worker',
      error instanceof WorkerDependencyUnavailable ? 'DEPENDENCY_UNAVAILABLE' : 'START_FAILED')
    if (!(error instanceof WorkerDependencyUnavailable)) throw error
    console.error(JSON.stringify({
      service: 'worker', event: 'not_ready', modelId: selected.metadata.id, dependencies: error.dependencies,
    }))
    process.exitCode = 1
    return
  }

  observation = startPluginHeartbeat(config.redisUrl, 'worker', [...platforms.plugins, selected.metadata])
  async function shutdown() {
    observation?.stop()
    try {
      await worker.close()
    } catch {
      process.exitCode = 1
    } finally {
      await Promise.all([selected.stop(), platforms.stop()])
    }
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.info(JSON.stringify({ service: 'worker', event: 'ready', modelId: selected.metadata.id, modelVersion: selected.metadata.version }))
}

await main().catch(() => {
  console.error(JSON.stringify({ service: 'worker', event: 'startup_failed', configuration: 'Check worker dependencies and model settings' }))
  process.exitCode = 1
})
