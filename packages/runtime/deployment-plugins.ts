import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  deploymentPluginChange, deploymentPluginId, deploymentPluginIds, pluginStage,
  type DeploymentPluginsView,
} from '../contracts/deployment-plugins.js'
import { newbiEndpoint } from '../contracts/newbi-pilot.js'
import type { ModelSettingsInput } from '../contracts/model-settings.js'
import type { createModelSettingsStore } from './model-settings-store.js'
import { writeSettings } from './write-settings.js'

const connector = z.object({ endpoint: newbiEndpoint })
const recordSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  plugins: z.partialRecord(deploymentPluginId, pluginStage),
  newbi: connector.optional(),
})
type Record = z.infer<typeof recordSchema>
type Change = z.infer<typeof deploymentPluginChange>

export class DeploymentPluginError extends Error {
  constructor(readonly code: 'VERSION_CONFLICT' | 'PLUGIN_STATE_CONFLICT') { super(code) }
}

export function createDeploymentPluginStore(directory: string) {
  const path = join(directory, 'deployment-plugins.json')
  let writes: Promise<unknown> = Promise.resolve()

  async function read(): Promise<Record> {
    try {
      return recordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, plugins: {} }
      throw new Error('Deployment plugin settings are unreadable')
    }
  }

  function view(record: Record, provider: ModelSettingsInput['provider']): DeploymentPluginsView {
    const plugins = {} as DeploymentPluginsView['plugins']
    const config = record.newbi
    for (const id of deploymentPluginIds) {
      const previouslyEnabled = id === provider
      plugins[id] = record.plugins[id] ?? (previouslyEnabled ? 'ENABLED' : 'NOT_INSTALLED')
    }
    return { version: record.version, plugins, newbi: { endpoint: config?.endpoint ?? null },
      configuredModel: provider === 'simulated' ? null : provider }
  }

  async function readNewbi() {
    const record = await read()
    return record.plugins.newbi === 'ENABLED' ? record.newbi : undefined
  }

  async function openNewbi(credential: string, expectedEndpoint?: string) {
    const current = await readNewbi()
    if (!current || (expectedEndpoint && expectedEndpoint !== current.endpoint)) return
    return {
      connection: { endpoint: current.endpoint, credential },
      async beforeRequest() {
        const latest = await readNewbi()
        if (latest?.endpoint !== current.endpoint) {
          throw new Error('Newbi configuration changed')
        }
      },
    }
  }

  async function readModel(settings: Pick<ReturnType<typeof createModelSettingsStore>, 'read'>) {
    const current = await settings.read()
    const { provider } = current.configuration
    if (provider === 'simulated') return current
    const stage = (await read()).plugins[provider]
    return stage && stage !== 'ENABLED' ? { ...current, configuration: { provider: 'simulated' as const } } : current
  }

  function save(change: Change, expected: number, getProvider: () => Promise<ModelSettingsInput['provider']>) {
    const write = writes.then(async () => {
      const record = await read()
      if (record.version !== expected) throw new DeploymentPluginError('VERSION_CONFLICT')
      const provider = await getProvider()
      const current = view(record, provider)
      if (change.action === 'CONFIGURE_NEWBI') {
        if (current.plugins.newbi !== 'ENABLED') throw new DeploymentPluginError('PLUGIN_STATE_CONFLICT')
        record.newbi = { endpoint: change.endpoint }
      } else {
        const transition = {
          INSTALL: ['NOT_INSTALLED', 'INSTALLED'],
          ENABLE: ['INSTALLED', 'ENABLED'],
          DISABLE: ['ENABLED', 'INSTALLED'],
        } as const
        const [before, after] = transition[change.action]
        if (current.plugins[change.id] !== before) throw new DeploymentPluginError('PLUGIN_STATE_CONFLICT')
        record.plugins[change.id] = after
      }
      record.version += 1
      await writeSettings(directory, path, record)
      return view(record, provider)
    })
    writes = write.catch(() => {})
    return write
  }

  return { async status(provider: ModelSettingsInput['provider']) { return view(await read(), provider) }, readNewbi, openNewbi, readModel, save }
}
