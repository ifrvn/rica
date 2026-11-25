import { createRequire } from 'node:module'
import { createDatabase } from '@ricajs/persistence/client'

async function checkUpgrade(databaseUrl: string) {
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

export const newbiBootstrapMigration = {
  beforeHost: checkUpgrade,
  prepare(databaseUrl: string) {
    const url = new URL(databaseUrl)
    url.searchParams.set('schema', 'rica_bootstrap_newbi')
    return {
      config: createRequire(import.meta.url).resolve('@ricajs/plugin-newbi/rica/bootstrap'),
      env: { RICA_NEWBI_BOOTSTRAP_URL: url.href },
    }
  },
}
