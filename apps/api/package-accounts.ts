import { z } from '@hono/zod-openapi'
import { simulationAccountRegistration } from '@ricajs/contracts/management'
import type { PluginJson } from '@ricajs/plugin-host/sdk'
import { ManagementError, registerAccount } from '@ricajs/persistence/management'
import type { ManagementPlugin } from '@ricajs/persistence/management-http'
import { Prisma } from '@ricajs/persistence/prisma'
import type { PackageAccounts } from '../package-plugins.js'
import { packageObject } from './package-database.js'

export function packageAccountHooks({ id: platform, schema, operations }: PackageAccounts): ManagementPlugin {
  const registration = simulationAccountRegistration.extend({ platform: z.literal(platform), data: z.unknown().default(null) })
  const relation = operations.profiles ? packageObject(schema, operations.profiles) : undefined

  async function apply(tx: Prisma.TransactionClient, operation: string, characterId: string,
    { id, instanceKey, remoteAccountId }: { id: string; instanceKey: string; remoteAccountId: string }, data: PluginJson = null) {
    const [row] = await tx.$queryRaw<{ accepted: boolean }[]>`
      SELECT ${packageObject(schema, operation)}(
        ${characterId}::uuid, ${id}::uuid, ${instanceKey}::text, ${remoteAccountId}::text, ${JSON.stringify(data)}::jsonb
      ) AS accepted`
    if (row?.accepted !== true) throw new ManagementError(409, 'PLUGIN_ACCOUNT_REJECTED', 'Plugin did not accept the account operation')
  }

  return {
    id: platform,
    registerRoutes() {},
    account: {
      platform, registration,
      async register(tx, scope, input) {
        const { data, ...ref } = registration.parse(input)
        const result = await registerAccount(tx, scope, ref)
        await apply(tx, operations.register, scope.characterId, { ...ref, ...result }, z.json().parse(data))
        return result
      },
      async profiles(tx, accounts, characterId) {
        if (!relation) return () => ({})
        const ids = Prisma.join(accounts.map(({ id }) => Prisma.sql`${id}::uuid`))
        const rows = await tx.$queryRaw<{ account_id: string; profile: unknown }[]>`
          SELECT account_id, profile FROM ${relation}
          WHERE character_id = ${characterId}::uuid AND account_id IN (${ids})`
        const entries = new Map(rows.map(row => [row.account_id, row.profile]))
        return ({ id }) => entries.has(id) ? { pluginProfile: entries.get(id) } : {}
      },
      async remove(tx, account, characterId) {
        if (operations.remove) await apply(tx, operations.remove, characterId, account)
      },
      async verifyResume(tx, account, characterId) {
        if (!operations.verifyResume) throw new ManagementError(409, 'STATE_CONFLICT', 'Plugin does not authorize account activation')
        await apply(tx, operations.verifyResume, characterId, account)
      },
    },
  }
}
