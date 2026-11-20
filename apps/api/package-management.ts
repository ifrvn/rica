import { z } from 'zod'
import { resourceId } from '@ricajs/contracts/management'
import type { Plugin } from '@ricajs/plugin-host'
import type { PluginManagement } from '@ricajs/plugin-host/sdk'
import { authorize, ManagementError } from '@ricajs/persistence/management'
import type { ManagementPlugin } from '@ricajs/persistence/management-http'
import type { PrismaClient } from '@ricajs/persistence/prisma'

export function packageManagementRoute(db: PrismaClient, { id, implementation }: Plugin<PluginManagement>): ManagementPlugin {
  const response = z.json()
  return {
    id,
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
        const data = response.parse(await implementation.read({ characterId, actorId: actor.id, path, query: [...url.searchParams] }))
        return c.body(JSON.stringify(data), 200, { 'Content-Type': 'application/json; charset=UTF-8' })
      })
    },
  }
}
