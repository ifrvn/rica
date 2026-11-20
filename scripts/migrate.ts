import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '@ricajs/persistence/client'
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
  url: packageDatabaseUrl(plugin.id, plugin.database.migrateUrlEnv, plugin.database.migrationJournal),
}] : [])

function deploy(config: string, args: string[], env = process.env) {
  const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--config', config, ...args], { stdio: 'inherit', env })
  if (result.error) throw result.error
  return result.status ?? 1
}

async function checkNewbiUpgrade(databaseUrl: string) {
  const db = createDatabase(databaseUrl)
  try {
    const [{ incomplete }] = await db.$queryRaw<[{ incomplete: boolean }]>`
      SELECT to_regclass('public.newbi_replies') IS NOT NULL
        OR (to_regnamespace('rica_plugin_newbi') IS NOT NULL
          AND (to_regclass('rica_plugin_newbi.section_glossary_samples') IS NULL
            OR to_regprocedure('rica_plugin_newbi.finish_reply(uuid,integer,uuid,integer,boolean)') IS NULL
            OR to_regprocedure('rica_plugin_newbi.send_connection(uuid)') IS NULL)) AS incomplete
    `
    if (incomplete) throw new Error('Finish Newbi migrations with the previous Rica release before upgrading')
  } catch (error) {
    // Prisma can create a missing database during deploy.
    const driver = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } })?.meta?.driverAdapterError
    if (driver?.cause?.originalCode !== '3D000') throw error
  } finally {
    await db.$disconnect()
  }
}

const hostUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
if (!hostArgs.length && hostUrl) await checkNewbiUpgrade(hostUrl)
let status = deploy(hostConfig, hostArgs)
if (status === 0 && !hostArgs.length) {
  if (!hostUrl) throw new Error('Rica migration requires a database URL')
  const url = new URL(hostUrl)
  url.searchParams.set('schema', 'rica_bootstrap_newbi')
  status = deploy(require.resolve('@ricajs/plugin-newbi/rica/bootstrap'), [], {
    ...process.env, RICA_NEWBI_BOOTSTRAP_URL: url.href,
  })
}
for (const migration of migrations) {
  if (status !== 0) break
  status = deploy(migration.config, [], { ...process.env, RICA_PLUGIN_DATABASE_URL: migration.url })
}
process.exitCode = status
