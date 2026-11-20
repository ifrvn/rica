import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageDatabaseUrl, readPackagePlugins } from '../apps/package-plugins.js'

const prismaManifest = createRequire(import.meta.url).resolve('prisma/package.json')
const prisma = resolve(dirname(prismaManifest), JSON.parse(readFileSync(prismaManifest, 'utf8')).bin.prisma)
const configExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const hostConfig = fileURLToPath(new URL('../prisma.config' + configExtension, import.meta.url))
const hostArgs = process.argv.slice(2)
const plugins = await readPackagePlugins(hostArgs.length ? undefined : process.env.RICA_PLUGIN_MANIFEST)
const migrations = plugins.flatMap((plugin) => plugin.database ? [{
  config: plugin.resolveExport('/rica/prisma'),
  url: packageDatabaseUrl(plugin.id, plugin.database.migrateUrlEnv),
}] : [])

function deploy(config: string, args: string[], env = process.env) {
  const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--config', config, ...args], { stdio: 'inherit', env })
  if (result.error) throw result.error
  return result.status ?? 1
}

let status = deploy(hostConfig, hostArgs)
for (const migration of migrations) {
  if (status !== 0) break
  status = deploy(migration.config, [], { ...process.env, RICA_PLUGIN_DATABASE_URL: migration.url })
}
process.exitCode = status
