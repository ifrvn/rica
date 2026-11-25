import { logger } from '@ricajs/runtime/logging'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from '@hono/zod-openapi'
import { pluginAccountId, pluginActivityEvent, pluginEventPage, pluginEventQuery, remotePluginId } from '@ricajs/contracts/plugin-events'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import { withRemotePluginRole, type RemotePluginService, type RemotePluginServices } from './remote-plugin-services.js'

export function createRemotePluginEvents(db: PrismaClient, services: RemotePluginServices) {
  const app = new Hono<{ Variables: { service: RemotePluginService; pluginId: string; accountId: string } }>()
  const accountPath = '/:pluginId/accounts/:accountId'
  const target = z.object({ pluginId: remotePluginId, accountId: pluginAccountId })

  app.use(accountPath, async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const path = target.safeParse(c.req.param())
    if (!path.success) return c.json({ code: 'INVALID_SCOPE' }, 422)
    const { pluginId, accountId } = path.data
    const service = services.authenticate(pluginId, c.req.header('Authorization'))
    if (!service) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ code: 'UNAUTHENTICATED' }, 401)
    }
    if (!service.accounts.has(accountId)) return c.json({ code: 'NOT_FOUND' }, 404)
    c.set('service', service)
    c.set('pluginId', pluginId)
    c.set('accountId', accountId)
    await next()
  })
  app.onError((error, c) => {
    logger.error({ service: 'api', event: 'remote_plugin_events_failed', error: error.name })
    return c.json({ code: 'INTERNAL_ERROR' }, 500)
  })

  app.post(accountPath, bodyLimit({ maxSize: 4096, onError: c => c.json({ code: 'BODY_TOO_LARGE' }, 413) }), async c => {
    if (!c.get('service').publishActivity) return c.json({ code: 'FORBIDDEN' }, 403)
    if (c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ code: 'UNSUPPORTED_MEDIA_TYPE' }, 415)
    }
    const input = pluginActivityEvent.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ code: 'INVALID_EVENT' }, 422)
    const { id, characterId, bindingVersion, occurredAt, payload } = input.data
    const [{ outcome }] = await withRemotePluginRole(db, tx => tx.$queryRaw<[{ outcome: string }]>`
      SELECT public.rica_publish_plugin_activity_v1(${c.get('pluginId')}, ${id}::uuid, ${characterId}::uuid,
        ${c.get('accountId')}::uuid, ${bindingVersion}::integer, ${occurredAt}::timestamptz,
        ${payload.kind}, ${payload.state}) AS outcome`)
    switch (outcome) {
      case 'CREATED': return c.json({ id }, 201)
      case 'REPLAYED': return c.json({ id }, 200)
      case 'UNAVAILABLE': return c.json({ code: 'NOT_FOUND' }, 404)
      case 'CONFLICT': return c.json({ code: 'EVENT_CONFLICT' }, 409)
      case 'INVALID_TIME': return c.json({ code: 'INVALID_EVENT' }, 422)
      default: throw new Error('Unknown plugin event outcome')
    }
  })

  app.get(accountPath, async c => {
    const { subscribeTo } = c.get('service')
    if (!subscribeTo.length) return c.json({ code: 'FORBIDDEN' }, 403)
    const query = pluginEventQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ code: 'INVALID_CURSOR' }, 422)
    const { bindingVersion, after, limit } = query.data
    const [{ items }] = await withRemotePluginRole(db, tx => tx.$queryRaw<[{ items: unknown[] | null }]>`
      SELECT public.rica_read_plugin_activity_v1(${c.get('accountId')}::uuid, ${bindingVersion}::integer,
        ${after}::bigint, ${subscribeTo}::text[], ${limit}::integer) AS items`)
    if (items === null) return c.json({ code: 'NOT_FOUND' }, 404)
    const events = pluginEventPage.shape.items.parse(items)
    return c.json({ items: events, nextOffset: events.at(-1)?.offset ?? after }, 200)
  })
  return app
}
