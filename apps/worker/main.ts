import { startOutboxWorker, WorkerDependencyUnavailable } from './outbox.js'
import { sweepRuntimeRetention } from './runtime-retention.js'
import { loadConfig } from '../../packages/runtime/config.js'
import { startConfiguredModel, startObservedModelPlugin, startSimulationPlatforms } from '../runtime-plugins.js'
import { createDatabase } from '../../packages/persistence/client.js'
import { hostedUsageRecorder } from '../../plugins/hosted-models/rica/persistence/usage.js'
import { createModelSettingsStore, enabledModelSettings } from '@rica/plugin-hosted-models'
import { hostedModelsPluginId, modelSettingsContracts } from '@rica/plugin-hosted-models/shared'
import { modelSettingsDirectory } from '../../packages/runtime/settings-directory.js'
import { createDeploymentPluginStore } from '../deployment-plugins.js'
import { observationError, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'
import { createAutoReviewer } from '../auto-review.js'

async function main() {
  const config = loadConfig()
  const directory = modelSettingsDirectory(config.databaseUrl)
  const settings = createModelSettingsStore(directory, modelSettingsContracts)
  const plugins = createDeploymentPluginStore(directory)
  const activeSettings = enabledModelSettings(settings, () => plugins.isEnabled(hostedModelsPluginId))
  const usageDb = createDatabase(config.databaseUrl)
  const recordUsage = hostedUsageRecorder(usageDb)
  const selected = await startConfiguredModel(activeSettings, 'worker',
    (configuration, service) => startObservedModelPlugin(configuration, recordUsage, service)).catch(async (error: unknown) => {
    await usageDb.$disconnect()
    await reportPluginResult(config.redisUrl, 'worker', observationError(error, 'START_FAILED'))
    throw error
  })
  const platforms = await startSimulationPlatforms(process.env, 'worker').catch(async (error: unknown) => {
    await Promise.all([selected.stop(), usageDb.$disconnect()])
    await reportPluginResult(config.redisUrl, 'worker', observationError(error, 'START_FAILED'))
    throw error
  })
  let observation: ReturnType<typeof startPluginHeartbeat> | undefined
  let settingsFailed = false
  async function getModel(profile?: string) {
    const previous = selected.metadata
    try {
      const model = await selected.read(profile)
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
    const review = createAutoReviewer(async (check) => check((await getModel()).implementation))
    worker = await startOutboxWorker(config.databaseUrl, config.redisUrl, getModel, platforms.resolveAdapter, sweepRuntimeRetention, review)
  } catch (error) {
    await Promise.all([selected.stop(), platforms.stop(), usageDb.$disconnect()])
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
      await Promise.all([selected.stop(), platforms.stop(), usageDb.$disconnect()])
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
