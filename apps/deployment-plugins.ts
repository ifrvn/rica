import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  deploymentConfigurations, deploymentPluginChange, deploymentPluginId, deploymentPluginIds,
  deploymentPluginsView, type DeploymentPluginId, type DeploymentPluginsView,
} from './deployment-plugin-contracts.js'
import { pluginStage } from '@ricajs/contracts/deployment-plugins'
import { writeSettings } from '@ricajs/runtime/write-settings'

const recordSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  plugins: z.partialRecord(deploymentPluginId, pluginStage),
  ...Object.fromEntries(deploymentConfigurations.map(({ id, stored }) => [id, stored.optional()])),
})
type StoredDeployment = z.infer<typeof recordSchema> & { [pluginId: string]: unknown }
type Change = z.infer<typeof deploymentPluginChange>

export class DeploymentPluginError extends Error {
  constructor(readonly code: 'VERSION_CONFLICT' | 'PLUGIN_STATE_CONFLICT') { super(code) }
}

export function createDeploymentPluginStore(directory: string) {
  const path = join(directory, 'deployment-plugins.json')
  let writes: Promise<unknown> = Promise.resolve()

  async function read(): Promise<StoredDeployment> {
    try {
      return recordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, plugins: {} }
      throw new Error('Deployment plugin settings are unreadable')
    }
  }

  function view(record: StoredDeployment, provider: string): DeploymentPluginsView {
    const plugins = {} as DeploymentPluginsView['plugins']
    for (const id of deploymentPluginIds) {
      plugins[id] = record.plugins[id] ?? 'NOT_INSTALLED'
    }
    const configuration = Object.fromEntries(deploymentConfigurations.map(({ id, stored, view }) =>
      [id, view(stored.optional().parse(record[id]))]))
    return deploymentPluginsView.parse({ version: record.version, plugins, ...configuration,
      configuredModel: provider === 'simulated' ? null : provider })
  }

  function save(change: Change, expected: number, getProvider: () => Promise<string>) {
    const write = writes.then(async () => {
      const record = await read()
      if (record.version !== expected) throw new DeploymentPluginError('VERSION_CONFLICT')
      const provider = await getProvider()
      const current = view(record, provider)
      if ('id' in change) {
        const transition = {
          INSTALL: { from: ['NOT_INSTALLED'], to: 'INSTALLED' },
          ENABLE: { from: ['INSTALLED'], to: 'ENABLED' },
          DISABLE: { from: ['ENABLED'], to: 'INSTALLED' },
          UNINSTALL: { from: ['INSTALLED', 'ENABLED'], to: 'NOT_INSTALLED' },
        } as const
        const { from, to } = transition[change.action]
        if (!from.some((stage) => current.plugins[change.id] === stage)) throw new DeploymentPluginError('PLUGIN_STATE_CONFLICT')
        record.plugins[change.id] = to
      } else {
        const configuration = deploymentConfigurations.find(({ change: schema }) => schema.shape.action.value === change.action)
        if (!configuration || current.plugins[configuration.id] !== 'ENABLED') throw new DeploymentPluginError('PLUGIN_STATE_CONFLICT')
        record[configuration.id] = configuration.apply(configuration.change.parse(change))
      }
      record.version += 1
      await writeSettings(directory, path, record)
      return view(record, provider)
    })
    writes = write.catch(() => {})
    return write
  }

  return { async status(provider: string) { return view(await read(), provider) }, save,
    async readConfiguration(id: string) {
      const record = await read()
      const plugin = deploymentPluginId.parse(id)
      return { stage: record.plugins[plugin], config: record[plugin] }
    },
    async isEnabled(id: DeploymentPluginId) {
      const record = await read()
      return record.plugins[id] === 'ENABLED'
    },
  }
}
