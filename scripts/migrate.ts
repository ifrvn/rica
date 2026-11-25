import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledPluginMigrations } from '../apps/bundled-plugin-migrations.js'
import { packageDatabaseUrl, readPackagePlugins } from '../apps/package-plugins.js'

const require = createRequire(import.meta.url)
const prismaManifest = require.resolve('prisma/package.json')
const prisma = resolve(dirname(prismaManifest), JSON.parse(readFileSync(prismaManifest, 'utf8')).bin.prisma)
const configExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const hostConfig = fileURLToPath(new URL('../prisma.config' + configExtension, import.meta.url))
const hostArgs = process.argv.slice(2)
const plugins = await readPackagePlugins(hostArgs.length ? undefined : process.env.RICA_PLUGIN_MANIFEST)
const migrations = plugins.flatMap((plugin) => plugin.database ? [{
  config: plugin.resolveExport('/rica/prisma'),
  env: { RICA_PLUGIN_DATABASE_URL: packageDatabaseUrl(plugin.id, plugin.database.migrateUrlEnv, plugin.database.migrationJournal) },
}] : [])

function deploy(config: string, args: string[], env = process.env) {
  const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--config', config, ...args], { stdio: 'inherit', env })
  if (result.error) throw result.error
  return result.status ?? 1
}

const hostUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
const bootstrap: { config: string; env: Record<string, string> }[] = []
if (!hostArgs.length && bundledPluginMigrations.length) {
  if (!hostUrl) throw new Error('Rica migration requires a database URL')
  for (const migration of bundledPluginMigrations) {
    await migration.beforeHost?.(hostUrl)
    bootstrap.push(migration.prepare(hostUrl))
  }
}
let status = deploy(hostConfig, hostArgs)
for (const { config, env } of [...bootstrap, ...migrations]) {
  if (status !== 0) break
  status = deploy(config, [], { ...process.env, ...env })
}
process.exitCode = status
