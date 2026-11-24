import { Hono } from 'hono'
import type { Readiness } from '@ricajs/contracts/health'

import type { createAdminAuth } from './admin-auth-routes.js'
import type { createManagementApp } from './management.js'
import type { createRemotePluginEvents } from './remote-plugin-events.js'
import type { createRemotePluginTasks } from './remote-plugin-tasks.js'

type Checks = Record<keyof Readiness['checks'], () => Promise<unknown>>

export function createApp(
  check: Checks, management?: ReturnType<typeof createManagementApp>, auth?: ReturnType<typeof createAdminAuth>['app'],
  pluginEvents?: ReturnType<typeof createRemotePluginEvents>,
  pluginTasks?: ReturnType<typeof createRemotePluginTasks>,
) {
  const app = new Hono()
  app.get('/health/live', (c) => c.json({ status: 'alive' }))
  app.get('/health/ready', async (c) => {
    const [postgres, redis] = await Promise.allSettled([
      Promise.resolve().then(check.postgres),
      Promise.resolve().then(check.redis),
    ])
    const checks = { postgres: postgres.status === 'fulfilled', redis: redis.status === 'fulfilled' }
    const ready = checks.postgres && checks.redis
    const data: Readiness = { status: ready ? 'ready' : 'unavailable', checks }
    return c.json(data, ready ? 200 : 503)
  })
  if (auth) app.route('/v1/auth', auth)
  if (pluginEvents) app.route('/v1/plugin-events', pluginEvents)
  if (pluginTasks) app.route('/v1/plugin-tasks', pluginTasks)
  if (management) app.route('/v1', management)
  return app
}
