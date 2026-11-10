import type { PlatformAdapter, ResolveSimulationAdapter } from '../packages/contracts/simulation-platform.js'
import { PluginHostError, startPluginHost, type PluginDefinition } from '../packages/runtime/plugin-registry.js'
import { simulatedModelDefinition } from '../packages/runtime/simulated-model.js'
import { hostedModelConfig, hostedModelDefinitions } from '../packages/runtime/hosted-models.js'
import { simulatedPlatformDefinitions } from '../packages/runtime/simulated-platforms.js'

import type { PluginMetadata } from '../packages/contracts/plugin-status.js'

function metadata(kind: PluginMetadata['kind'], { id, version, contractVersion }: Omit<PluginMetadata, 'kind'>): PluginMetadata {
  return { kind, id, version, contractVersion }
}

export const simulationPlatformCatalog = simulatedPlatformDefinitions.map((item) => metadata('platform', item))
const modelDefinitions = [simulatedModelDefinition, ...hostedModelDefinitions]
export const cognitionCatalog = [...simulationPlatformCatalog, ...modelDefinitions.map((item) => metadata('model', item))]

async function startHost<T>(kind: string, definitions: readonly PluginDefinition<T>[],
  selections: readonly { id: string; config?: unknown }[], service?: string) {
  const report = service ? (diagnostic: PluginHostError['diagnostic']) => {
    console.info(JSON.stringify({ service, event: 'plugin_status', ...diagnostic }))
  } : undefined
  try {
    return await startPluginHost(kind, definitions, selections, { report })
  } catch (error) {
    if (error instanceof PluginHostError) report?.(error.diagnostic)
    throw error
  }
}

export async function startSimulationPlatforms(env = process.env, service?: string) {
  const configured = env.RICA_SIMULATED_PLATFORMS?.trim()
  const ids = configured === undefined ? simulatedPlatformDefinitions.map(({ id }) => id)
    : configured === '' ? [] : configured.split(',').map((id) => id.trim())
  const host = await startHost<PlatformAdapter>('platform', simulatedPlatformDefinitions, ids.map((id) => ({ id })), service)
  const resolveAdapter: ResolveSimulationAdapter = (id) => {
    const plugin = host.find(id)
    return plugin && { adapterId: plugin.id, adapterVersion: plugin.version, adapterContractVersion: plugin.contractVersion }
  }
  return { ...host, resolveAdapter, plugins: simulationPlatformCatalog.filter(({ id }) => !!host.find(id)) }
}

export async function startCognitionPlugins(env = process.env, service?: string) {
  const modelId = env.RICA_MODEL_PROVIDER ?? simulatedModelDefinition.id
  const platforms = await startSimulationPlatforms(env, service)
  try {
    const models = await startHost('model', modelDefinitions, [{ id: modelId, config: hostedModelConfig(modelId, env) }], service)
    const model = models.find(modelId)!
    return {
      model,
      resolveAdapter: platforms.resolveAdapter,
      plugins: [...platforms.plugins, metadata('model', model)],
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
