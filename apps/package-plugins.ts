import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { startPluginHost, type PluginDefinition, type PluginHostError } from '@ricajs/plugin-host'
import type { PluginAccounts, PluginManagement, RicaPlugin } from '@ricajs/plugin-host/sdk'

const pluginId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(50)
const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/).max(214)
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const envName = z.string().regex(/^RICA_PLUGIN_[A-Z0-9_]+$/)
const manifestSchema = z.strictObject({
  version: z.literal(1),
  plugins: z.array(z.strictObject({
    id: pluginId, package: packageName, version, config: z.json().default(null),
    database: z.strictObject({
      migrateUrlEnv: envName, runtimeUrlEnv: envName, migrationJournal: z.literal('separate').optional(),
    }).optional(),
  })),
})
const packageIdentity = z.object({ name: packageName, version })
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)
const activityView = z.strictObject({ view: identifier })
const retentionOperation = z.strictObject({ sweep: identifier })
const accountOperations = z.strictObject({
  register: identifier, profiles: identifier.optional(), remove: identifier.optional(), verifyResume: identifier.optional(),
  prepareRegistration: z.custom<NonNullable<PluginAccounts['prepareRegistration']>>(value => typeof value === 'function').optional(),
})

export type PackageActivityView = Readonly<{ platform: string; schema: string; view: string }>
export type PackageAccounts = Readonly<{ id: string; schema: string; operations: PluginAccounts }>
export type PackageRetention = Readonly<{ id: string; package: string; schema: string; sweep: string }>

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

function packageSchema(id: string) { return 'rica_plugin_' + id.replaceAll('-', '_') }

export function packageDatabaseUrl(id: string, source: string, migrationJournal?: 'separate') {
  const value = process.env[source]
  if (!value) throw new Error('Missing Rica plugin database setting: ' + source)
  const url = URL.parse(value)
  const schema = migrationJournal === 'separate' ? 'rica_migrate_' + id.replaceAll('-', '_') : packageSchema(id)
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.searchParams.getAll('schema').length !== 1 || url.searchParams.get('schema') !== schema) {
    throw new Error('Rica plugin database URL must target schema ' + schema + ': ' + id)
  }
  return value
}

async function readPackageModules(manifestPath: string | undefined) {
  const modules = []
  for (const entry of await readPackagePlugins(manifestPath)) {
    const { ricaPlugin }: { ricaPlugin?: RicaPlugin } = await import(pathToFileURL(entry.resolveExport('/rica')).href)
    if (ricaPlugin?.id !== entry.id || ricaPlugin.sdkVersion !== 1 ||
        (ricaPlugin.management === undefined && ricaPlugin.worker === undefined && ricaPlugin.activity === undefined &&
          ricaPlugin.accounts === undefined && ricaPlugin.retention === undefined) ||
        (ricaPlugin.management !== undefined && typeof ricaPlugin.management !== 'function') ||
        (ricaPlugin.worker !== undefined && typeof ricaPlugin.worker !== 'function')) {
      throw new Error('Unsupported Rica plugin SDK or capabilities: ' + entry.id)
    }
    const activity = activityView.optional().safeParse(ricaPlugin.activity)
    if (!activity.success || (activity.data && !entry.database)) {
      throw new Error('Invalid Rica plugin activity view: ' + entry.id)
    }
    const accounts = accountOperations.optional().safeParse(ricaPlugin.accounts)
    if (!accounts.success || (accounts.data && !entry.database)) {
      throw new Error('Invalid Rica plugin account operations: ' + entry.id)
    }
    const retention = retentionOperation.optional().safeParse(ricaPlugin.retention)
    if (!retention.success || (retention.data && !entry.database)) {
      throw new Error('Invalid Rica plugin retention operation: ' + entry.id)
    }
    modules.push({ entry, ricaPlugin, activity: activity.data, accounts: accounts.data, retention: retention.data })
  }
  return modules
}

export async function loadPackageManagement(manifestPath: string | undefined, builtInActivities: Readonly<Record<string, string>> = {}) {
  const definitions: PluginDefinition<PluginManagement>[] = []
  const activityViews: PackageActivityView[] = []
  const accountPlugins: PackageAccounts[] = []
  for (const { entry, ricaPlugin, activity, accounts } of await readPackageModules(manifestPath)) {
    if (activity) {
      const ownsBuiltInActivity = Object.hasOwn(builtInActivities, entry.id) && builtInActivities[entry.id] === entry.package
      activityViews.push({ platform: ownsBuiltInActivity ? entry.id : 'plugin:' + entry.id, schema: packageSchema(entry.id), view: activity.view })
    }
    if (accounts) accountPlugins.push({ id: entry.id, schema: packageSchema(entry.id), operations: accounts })
    const createManagement = ricaPlugin.management
    if (!createManagement) continue
    const databaseUrl = entry.database && packageDatabaseUrl(entry.id, entry.database.runtimeUrlEnv)
    definitions.push({
      id: entry.id, version: entry.version, contractVersion: ricaPlugin.sdkVersion,
      create() {
        let management: PluginManagement | undefined
        return {
          implementation: { read: (request, services) => management!.read(request, services) },
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
  return { plugins: definitions.map(({ id }) => host.find(id)!), activityViews, accountPlugins, stop: host.stop }
}

type PackageModules = Awaited<ReturnType<typeof readPackageModules>>

function retentionSources(modules: PackageModules): PackageRetention[] {
  return modules.flatMap(({ entry, retention }) => retention ?
    [{ id: entry.id, package: entry.package, schema: packageSchema(entry.id), sweep: retention.sweep }] : [])
}

export async function loadPackageRetention(manifestPath: string | undefined) {
  return retentionSources(await readPackageModules(manifestPath))
}

export async function loadPackageWorkerDeployment(manifestPath: string | undefined) {
  const modules = await readPackageModules(manifestPath)
  return { retention: retentionSources(modules),
    start: (shutdown: AbortSignal, report?: (diagnostic: PluginHostError['diagnostic']) => void) =>
      startPackageWorkers(modules, shutdown, report) }
}

async function startPackageWorkers(modules: PackageModules, shutdown: AbortSignal,
  report?: (diagnostic: PluginHostError['diagnostic']) => void) {
  const controller = new AbortController()
  const signal = AbortSignal.any([shutdown, controller.signal])
  const definitions: PluginDefinition<undefined>[] = []
  for (const { entry, ricaPlugin } of modules) {
    const createWorker = ricaPlugin.worker
    if (!createWorker) continue
    const databaseUrl = entry.database && packageDatabaseUrl(entry.id, entry.database.runtimeUrlEnv)
    definitions.push({
      id: entry.id, version: entry.version, contractVersion: ricaPlugin.sdkVersion,
      create() {
        signal.throwIfAborted()
        const worker = createWorker(entry.config, { databaseUrl, signal })
        return {
          implementation: undefined,
          async start() {
            if (typeof worker?.start !== 'function' || typeof worker.stop !== 'function') {
              throw new Error('Invalid Rica plugin Worker capability: ' + entry.id)
            }
            await worker.start()
            signal.throwIfAborted()
          },
          async stop() {
            controller.abort()
            if (typeof worker?.stop === 'function') await worker.stop()
          },
        }
      },
    })
  }
  const host = await startPluginHost('package-worker', definitions, definitions.map(({ id }) => ({ id })), { report })
  return {
    stop() {
      controller.abort()
      return host.stop()
    },
  }
}
