import { z } from 'zod'
import { resourceId } from '@ricajs/contracts/management'
import type { Plugin } from '@ricajs/plugin-host'
import type { PluginManagement } from '@ricajs/plugin-host/sdk'
import { authorize, denyPermission, ManagementError } from '@ricajs/persistence/management'
import type { ManagementPlugin } from '@ricajs/persistence/management-http'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import type { loadPackageManagement } from '../package-plugins.js'
import { packageAccountHooks } from './package-accounts.js'

export function packageManagementPlugins(db: PrismaClient, host: Awaited<ReturnType<typeof loadPackageManagement>>) {
  const plugins = new Map(host.accountPlugins.map(entry => [entry.id, packageAccountHooks(entry)]))
  for (const plugin of host.plugins) {
    plugins.set(plugin.id, packageManagementRoute(db, plugin, plugins.get(plugin.id)?.account))
  }
  return [...plugins.values()]
}

export function packageManagementRoute(db: PrismaClient, { id, implementation }: Plugin<PluginManagement>,
  account?: ManagementPlugin['account']): ManagementPlugin {
  const response = z.json()
  const batch = z.array(resourceId).max(100)
  return {
    id, account,
    registerRoutes(app) {
      app.get(`/characters/:characterId/plugins/${id}/*`, async (c) => {
        const character = resourceId.safeParse(c.req.param('characterId'))
        if (!character.success) throw new ManagementError(422, 'INVALID_INPUT', 'Invalid character ID')
        const actor = c.get('actor')
        const characterId = character.data
        await db.$transaction((tx) => authorize(tx, { actor, characterId }))
        const url = new URL(c.req.url)
        const segments = url.pathname.split('/')
        const namespace = segments.indexOf('plugins')
        const suffix = segments.slice(namespace + 2).join('/')
        const path = '/' + suffix
        const data = response.parse(await implementation.read({ characterId, actorId: actor.id, path, query: [...url.searchParams] }, {
          async readAccounts(ids) {
            if (!account) denyPermission()
            const requested = batch.safeParse(ids)
            if (!requested.success) throw new ManagementError(422, 'INVALID_INPUT', 'Invalid account ID batch')
            return db.$transaction(async (tx) => {
              await authorize(tx, { actor, characterId })
              return tx.platformAccount.findMany({
                where: { characterId, platform: id, id: { in: requested.data } },
                select: { id: true, identityId: true, instanceKey: true, remoteAccountId: true, status: true, bindingVersion: true },
                orderBy: { id: 'asc' },
              })
            }, { isolationLevel: 'RepeatableRead' })
          },
        }))
        return c.body(JSON.stringify(data), 200, { 'Content-Type': 'application/json; charset=UTF-8' })
      })
    },
  }
}
