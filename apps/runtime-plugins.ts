import type { PlatformAdapter, ResolveSimulationAdapter } from '@ricajs/contracts/simulation-platform'
import { hostedModelsPluginId, type ModelSettingsInput } from '@ricajs/plugin-hosted-models/shared'
import type { ModelProvider } from '@ricajs/contracts/model-provider'
import { PluginHostError, startPluginHost, type PluginDefinition } from '@ricajs/plugin-host'
import { simulatedModelDefinition } from '@ricajs/plugin-simulated-model'
import { hostedModelDefinition, observedHostedModelDefinition, type createModelSettingsStore } from '@ricajs/plugin-hosted-models'
import type { RecordHostedUsage, UsagePurpose } from '@ricajs/plugin-hosted-models/providers/usage'
import { simulatedPlatformDefinitions } from '@ricajs/plugin-simulated-platforms'

import type { PluginMetadata, SimulationPlatformSource } from '@ricajs/contracts/plugin-status'

function metadata(kind: PluginMetadata['kind'], { id, version, contractVersion }: Omit<PluginMetadata, 'kind'>): PluginMetadata {
  return { kind, id, version, contractVersion }
}

export const simulationPlatformCatalog = simulatedPlatformDefinitions.map((item) => metadata('platform', item))
const modelDefinitions = [simulatedModelDefinition, hostedModelDefinition]
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

export async function startSimulationPlatforms(env = process.env, service?: string, selection?: readonly string[]) {
  const configured = env.RICA_SIMULATED_PLATFORMS?.trim()
  const source: SimulationPlatformSource = selection !== undefined ? 'DEPLOYMENT_SETTINGS'
    : configured === undefined ? 'BUILT_IN_DEFAULT' : 'ENVIRONMENT'
  const ids = selection ?? (configured === undefined ? simulatedPlatformDefinitions.map(({ id }) => id)
    : configured === '' ? [] : configured.split(',').map((id) => id.trim()))
  const host = await startHost<PlatformAdapter>('platform', simulatedPlatformDefinitions, ids.map((id) => ({ id })), service)
  const resolveAdapter: ResolveSimulationAdapter = (id) => {
    const plugin = host.find(id)
    return plugin && { adapterId: plugin.id, adapterVersion: plugin.version, adapterContractVersion: plugin.contractVersion }
  }
  return { ...host, resolveAdapter, source, plugins: simulationPlatformCatalog.filter(({ id }) => !!host.find(id)) }
}

export async function startModelPlugin(configuration: ModelSettingsInput, service?: string,
  definitions: readonly PluginDefinition<ModelProvider>[] = modelDefinitions,
) {
  const id = configuration.provider === 'simulated' ? 'simulated' : hostedModelsPluginId
  const config = id === 'simulated' ? undefined : configuration
  const host = await startHost('model', definitions, [{ id, config }], service)
  const model = host.find(id)!
  return { model, metadata: metadata('model', model), stop: host.stop }
}

export function startObservedModelPlugin(configuration: ModelSettingsInput, record: RecordHostedUsage, service?: string,
  purpose?: UsagePurpose,
) {
  return startModelPlugin(configuration, service, [simulatedModelDefinition, observedHostedModelDefinition(record, purpose)])
}

export async function startConfiguredModel(
  settings: Pick<ReturnType<typeof createModelSettingsStore>, 'read'>, service?: string,
  start: typeof startModelPlugin = startModelPlugin,
) {
  const initial = await settings.read()
  let selected = await start(initial.configuration, service)
  let version = initial.version
  let provider = initial.configuration.provider
  return {
    get metadata() { return selected.metadata },
    async read(profile?: string) {
      const record = await settings.read(profile)
      if (record.version !== version || record.configuration.provider !== provider) {
        const next = await start(record.configuration, service)
        await selected.stop()
        selected = next
        version = record.version
        provider = record.configuration.provider
      }
      return selected.model
    },
    stop: () => selected.stop(),
  }
}

export async function startCognitionPlugins(
  env = process.env, service?: string, configuration: ModelSettingsInput = { provider: 'simulated' },
) {
  const platforms = await startSimulationPlatforms(env, service)
  try {
    const selected = await startModelPlugin(configuration, service)
    return {
      model: selected.model,
      resolveAdapter: platforms.resolveAdapter,
      plugins: [...platforms.plugins, selected.metadata],
      async stop() {
        await selected.stop()
        await platforms.stop()
      },
    }
  } catch (error) {
    await platforms.stop()
    throw error
  }
}
