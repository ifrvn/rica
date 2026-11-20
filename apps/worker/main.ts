import { startOutboxWorker, WorkerDependencyUnavailable } from './outbox.js'
import { checkPackageRetention, sweepRuntimeRetention } from './runtime-retention.js'
import { loadConfig } from '@ricajs/runtime/config'
import { startConfiguredModel, startObservedModelPlugin, startSimulationPlatforms } from '../runtime-plugins.js'
import { createDatabase } from '@ricajs/persistence/client'
import { hostedUsageRecorder } from '@ricajs/plugin-hosted-models/persistence/usage'
import { createModelSettingsStore, enabledModelSettings } from '@ricajs/plugin-hosted-models'
import { hostedModelsPluginId, modelSettingsContracts } from '@ricajs/plugin-hosted-models/shared'
import { modelSettingsDirectory } from '@ricajs/runtime/settings-directory'
import { createDeploymentPluginStore } from '../deployment-plugins.js'
import { observationError, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'
import { createAutoReviewer } from '../auto-review.js'
import { createDiscussionAssessor } from '../discussion-assessment.js'
import { ricaPlugin as newbi } from '@ricajs/plugin-newbi/rica'
import newbiPackage from '@ricajs/plugin-newbi/package.json' with { type: 'json' }
import { workerDiscussionServices } from './discussion-services.js'
import { loadPackageWorkerDeployment } from '../package-plugins.js'
import { PluginHostError } from '@ricajs/plugin-host'

async function main() {
  const config = loadConfig()
  const packageDeployment = await loadPackageWorkerDeployment(process.env.RICA_PLUGIN_MANIFEST).catch(async (error: unknown) => {
    await reportPluginResult(config.redisUrl, 'worker', 'START_FAILED')
    throw error
  })
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
  const platforms = await plugins.readSimulationPlatforms()
    .then(selection => startSimulationPlatforms(process.env, 'worker', selection)).catch(async (error: unknown) => {
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
    await checkPackageRetention(usageDb, packageDeployment.retention)
    const review = createAutoReviewer(async (check) => check((await getModel()).implementation))
    worker = await startOutboxWorker(config.databaseUrl, config.redisUrl, getModel, platforms.resolveAdapter,
      (db) => sweepRuntimeRetention(db, packageDeployment.retention), review)
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

  const assessDiscussion = createDiscussionAssessor(async (assess, profile) => assess((await getModel(profile)).implementation))
  const stopping = new AbortController()
  const packageStartup = packageDeployment.start(stopping.signal, (diagnostic) => {
    console.info(JSON.stringify({ service: 'worker', event: 'plugin_status', ...diagnostic }))
    if (diagnostic.code === 'STOP_FAILED') process.exitCode = 1
  }, {
    builtIn: { id: newbi.id, package: newbiPackage.name, version: newbiPackage.version, factory: newbi.worker,
      databaseUrl: config.databaseUrl, workerServices: newbi.workerServices },
    services: (id, requested) => ({
      readDeployment: id === newbi.id ? () => plugins.readConfiguration(id) : undefined,
      discussion: requested?.discussion ? workerDiscussionServices(usageDb, id,
        () => plugins.isEnabled(hostedModelsPluginId), assessDiscussion, stopping.signal) : undefined,
    }),
  })
  let closing: Promise<void> | undefined
  function shutdown() {
    stopping.abort()
    return closing ??= (async () => {
      observation?.stop()
      const stopped = await Promise.allSettled([packageStartup.then(host => host.stop(), () => {}), worker.close()])
      const released = await Promise.allSettled([selected.stop(), platforms.stop(), usageDb.$disconnect()])
      if ([...stopped, ...released].some(({ status }) => status === 'rejected')) process.exitCode = 1
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
    })()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  try {
    await packageStartup
  } catch (error) {
    const cancelled = stopping.signal.aborted
    await shutdown()
    if (cancelled) return
    if (error instanceof PluginHostError) {
      console.error(JSON.stringify({ service: 'worker', event: 'plugin_status', ...error.diagnostic }))
    }
    await reportPluginResult(config.redisUrl, 'worker', 'START_FAILED')
    throw error
  }
  if (stopping.signal.aborted) return
  observation = startPluginHeartbeat(config.redisUrl, 'worker', [...platforms.plugins, selected.metadata], platforms.source)
  console.info(JSON.stringify({ service: 'worker', event: 'ready', modelId: selected.metadata.id, modelVersion: selected.metadata.version }))
}

await main().catch(() => {
  console.error(JSON.stringify({ service: 'worker', event: 'startup_failed', configuration: 'Check worker dependencies and model settings' }))
  process.exitCode = 1
})
