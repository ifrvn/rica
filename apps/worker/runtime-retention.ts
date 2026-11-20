import { newbiRetentionSweep } from '@ricajs/plugin-newbi'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import { sweepSimulationRetention } from '@ricajs/simulation/retention'
import { packageObject } from '../package-database.js'
import type { PackageRetention } from '../package-plugins.js'

export async function checkPackageRetention(db: PrismaClient, sources: readonly PackageRetention[]) {
  for (const { id, schema, sweep } of sources) {
    const [row] = await db.$queryRaw<{ available: boolean | null }[]>`
      SELECT has_schema_privilege(n.oid, 'USAGE') AND has_function_privilege(p.oid, 'EXECUTE')
        AND p.prorettype = 'integer'::regtype AND NOT p.proretset AND p.prokind = 'f' AS available
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${schema} AND p.proname = ${sweep} AND p.pronargs = 0`
    if (!row?.available) throw new Error('Rica plugin retention function unavailable: ' + id)
  }
}

export async function sweepRuntimeRetention(db: PrismaClient, sources: readonly PackageRetention[] = []) {
  const packagedNewbi = sources.some(({ id, package: name }) => id === 'newbi' && name === '@ricajs/plugin-newbi')
  const results = await Promise.allSettled([
    sweepSimulationRetention(db, packagedNewbi ? undefined : newbiRetentionSweep),
    ...sources.map(async ({ id, schema, sweep }) => {
      const [{ changed }] = await db.$queryRaw<[{ changed: number }]>`
        SELECT ${packageObject(schema, sweep)}() AS changed`
      if (!Number.isSafeInteger(changed) || changed < 0) throw new Error('Invalid Rica plugin retention count: ' + id)
      return changed
    }),
  ])
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Retention sweep failed')
  return results.reduce((total, result) => total + (result.status === 'fulfilled' ? result.value : 0), 0)
}
