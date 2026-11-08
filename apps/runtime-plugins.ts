import type { PlatformAdapter, ResolveSimulationAdapter } from '../packages/contracts/simulation-platform.js'
import { PluginHostError, startPluginHost, type PluginDefinition } from '../packages/runtime/plugin-registry.js'
import { simulatedModelDefinition } from '../packages/runtime/simulated-model.js'
import { simulatedPlatformDefinitions } from '../packages/runtime/simulated-platforms.js'

async function startHost<T>(kind: string, definitions: readonly PluginDefinition<T>[], ids: readonly string[], service?: string) {
  const report = service ? (diagnostic: PluginHostError['diagnostic']) => {
    console.info(JSON.stringify({ service, event: 'plugin_status', ...diagnostic }))
  } : undefined
  try {
    return await startPluginHost(kind, definitions, ids.map((id) => ({ id })), { report })
  } catch (error) {
    if (error instanceof PluginHostError) report?.(error.diagnostic)
    throw error
  }
}

export async function startSimulationPlatforms(env = process.env, service?: string) {
  const configured = env.RICA_SIMULATED_PLATFORMS?.trim()
  const ids = configured === undefined ? simulatedPlatformDefinitions.map(({ id }) => id)
    : configured === '' ? [] : configured.split(',').map((id) => id.trim())
  const host = await startHost<PlatformAdapter>('platform', simulatedPlatformDefinitions, ids, service)
  const resolveAdapter: ResolveSimulationAdapter = (id) => {
    const plugin = host.find(id)
    return plugin && { adapterId: plugin.id, adapterVersion: plugin.version, adapterContractVersion: plugin.contractVersion }
  }
  return { ...host, resolveAdapter }
}

export async function startCognitionPlugins(env = process.env, service?: string) {
  const modelId = env.RICA_MODEL_PROVIDER ?? simulatedModelDefinition.id
  const platforms = await startSimulationPlatforms(env, service)
  try {
    const models = await startHost('model', [simulatedModelDefinition], [modelId], service)
    const model = models.find(modelId)!
    return {
      model,
      resolveAdapter: platforms.resolveAdapter,
      async stop() {
        await models.stop()
        await platforms.stop()
      },
    }
  } catch (error) {
    await platforms.stop()
    throw error
  }
}
