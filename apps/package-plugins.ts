import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { startPluginHost, type PluginDefinition } from '@ricajs/plugin-host'
import type { PluginManagement, RicaPlugin } from '@ricajs/plugin-host/sdk'

const pluginId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(50)
const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/).max(214)
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const envName = z.string().regex(/^RICA_PLUGIN_[A-Z0-9_]+$/)
const manifestSchema = z.strictObject({
  version: z.literal(1),
  plugins: z.array(z.strictObject({
    id: pluginId, package: packageName, version, config: z.json().default(null),
    database: z.strictObject({ migrateUrlEnv: envName, runtimeUrlEnv: envName }).optional(),
  })),
})
const packageIdentity = z.object({ name: packageName, version })

export async function readPackagePlugins(manifestPath: string | undefined) {
  if (!manifestPath) return []
  const path = resolve(manifestPath)
  const manifest = manifestSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!manifest.success) throw new Error('Invalid Rica plugin deployment manifest')
  const ids = new Set<string>()
  const installedPackages = new Set<string>()
  const fromDeployment = createRequire(path)
  return Promise.all(manifest.data.plugins.map(async (entry) => {
    if (ids.has(entry.id) || installedPackages.has(entry.package)) throw new Error('Duplicate Rica plugin: ' + entry.id)
    ids.add(entry.id)
    installedPackages.add(entry.package)
    const packageJson = fromDeployment.resolve(entry.package + '/package.json')
    const installed = packageIdentity.safeParse(JSON.parse(await readFile(packageJson, 'utf8')))
    if (!installed.success || installed.data.name !== entry.package || installed.data.version !== entry.version) {
      throw new Error('Installed Rica plugin version does not match deployment: ' + entry.id)
    }
    if (entry.database && entry.database.migrateUrlEnv === entry.database.runtimeUrlEnv) {
      throw new Error('Rica plugin requires separate migration and runtime settings: ' + entry.id)
    }
    return {
      ...entry,
      resolveExport(subpath: '/rica' | '/rica/prisma') {
        const file = fromDeployment.resolve(entry.package + subpath)
        const location = relative(dirname(packageJson), file)
        if (isAbsolute(location) || location === '..' || location.startsWith('..' + sep)) {
          throw new Error('Rica plugin entry is outside its package: ' + entry.id)
        }
        return file
      },
    }
  }))
}

export function packageDatabaseUrl(id: string, source: string) {
  const value = process.env[source]
  if (!value) throw new Error('Missing Rica plugin database setting: ' + source)
  const url = URL.parse(value)
  const schema = 'rica_plugin_' + id.replaceAll('-', '_')
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.searchParams.getAll('schema').length !== 1 || url.searchParams.get('schema') !== schema) {
    throw new Error('Rica plugin database URL must target schema ' + schema + ': ' + id)
  }
  return value
}

export async function loadPackageManagement(manifestPath: string | undefined) {
  const definitions: PluginDefinition<PluginManagement>[] = []
  for (const entry of await readPackagePlugins(manifestPath)) {
    const databaseUrl = entry.database && packageDatabaseUrl(entry.id, entry.database.runtimeUrlEnv)
    const { ricaPlugin }: { ricaPlugin?: RicaPlugin } = await import(pathToFileURL(entry.resolveExport('/rica')).href)
    if (ricaPlugin?.id !== entry.id || ricaPlugin.sdkVersion !== 1 || typeof ricaPlugin.management !== 'function') {
      throw new Error('Unsupported Rica plugin SDK or capabilities: ' + entry.id)
    }
    const createManagement = ricaPlugin.management
    definitions.push({
      id: entry.id, version: entry.version, contractVersion: ricaPlugin.sdkVersion,
      create() {
        let management: PluginManagement | undefined
        return {
          implementation: { read: (request) => management!.read(request) },
          async start() {
            management = await createManagement(entry.config, { databaseUrl })
            if (typeof management?.read !== 'function' || (management.stop !== undefined && typeof management.stop !== 'function')) {
              throw new Error('Invalid Rica plugin management capability: ' + entry.id)
            }
          },
          async stop() { if (typeof management?.stop === 'function') await management.stop() },
        }
      },
    })
  }
  const host = await startPluginHost('package-management', definitions, definitions.map(({ id }) => ({ id })))
  return { plugins: definitions.map(({ id }) => host.find(id)!), stop: host.stop }
}
