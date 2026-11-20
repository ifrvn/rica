import { startOutboxWorker, WorkerDependencyUnavailable } from './outbox.js'
import { sweepRuntimeRetention } from './runtime-retention.js'
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
import { connectNewbiSettings, createNewbiOperations, startNewbiBackground } from '@ricajs/plugin-newbi'
import { startPackageWorkers } from '../package-plugins.js'
import { PluginHostError } from '@ricajs/plugin-host'

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

  const newbi = connectNewbiSettings(plugins.readConfiguration)
  const backgroundEndpoint = async () => await plugins.isEnabled(hostedModelsPluginId) ? newbi.readBackground() : undefined
  const backgroundDb = createDatabase(config.databaseUrl, 'rica_admin_api')
  const { pollConnector, readConnectorThread } = createNewbiOperations(usageDb, {
    async openNewbi(credential, endpoint) {
      const current = await backgroundEndpoint()
      if (!current || (endpoint && current !== endpoint)) return
      const opened = await newbi.openNewbi(credential, current)
      return opened && { ...opened, async beforeRequest() {
        await opened.beforeRequest()
        if (await backgroundEndpoint() !== current) throw new Error('Newbi background configuration changed')
      } }
    },
  })
  const assessDiscussion = createDiscussionAssessor(async (assess, profile) => assess((await getModel(profile)).implementation))
  const stopBackground = startNewbiBackground(backgroundDb, backgroundEndpoint, { pollConnector, readConnectorThread, assessDiscussion },
    () => console.error(JSON.stringify({ service: 'worker', event: 'newbi_background_failed' })))
  const stopping = new AbortController()
  const packageStartup = startPackageWorkers(process.env.RICA_PLUGIN_MANIFEST, stopping.signal, (diagnostic) => {
    console.info(JSON.stringify({ service: 'worker', event: 'plugin_status', ...diagnostic }))
    if (diagnostic.code === 'STOP_FAILED') process.exitCode = 1
  })
  let closing: Promise<void> | undefined
  function shutdown() {
    stopping.abort()
    return closing ??= (async () => {
      observation?.stop()
      const stopped = await Promise.allSettled([packageStartup.then(host => host.stop(), () => {}), worker.close(), stopBackground()])
      const released = await Promise.allSettled([selected.stop(), platforms.stop(), usageDb.$disconnect(), backgroundDb.$disconnect()])
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
