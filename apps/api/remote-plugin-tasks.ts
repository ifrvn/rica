import { Hono, type Handler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { commandResponse, idempotencyHeader } from '@ricajs/contracts/management'
import { pluginAccountId, remotePluginId, remoteTaskClaim, remoteTaskInput, remoteTaskLeaseView,
  remoteTaskReceipt, remoteTaskReceiptView } from '@ricajs/contracts/plugin-events'
import { authorize, executeManagementCommand, ManagementError } from '@ricajs/persistence/management'
import { body, characterParams, errors, security, success, type ManagementEnvironment } from '@ricajs/persistence/management-http'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import { withRemotePluginRole, type RemotePluginServices } from './remote-plugin-services.js'

export function createRemotePluginTasks(db: PrismaClient, services: RemotePluginServices) {
  const app = new Hono()
  const base = '/:pluginId/accounts/:accountId'
  const scope = z.object({ pluginId: remotePluginId, accountId: pluginAccountId, taskId: pluginAccountId.optional() })
  app.onError((error, c) => {
    console.error(JSON.stringify({ service: 'api', event: 'remote_plugin_tasks_failed', error: error.name }))
    return c.json({ code: 'INTERNAL_ERROR' }, 500)
  })
  const limit = bodyLimit({ maxSize: 8192, onError: c => c.json({ code: 'BODY_TOO_LARGE' }, 413) })
  const handle: Handler = async c => {
    c.header('Cache-Control', 'no-store')
    const parsed = scope.safeParse(c.req.param())
    if (!parsed.success) return c.json({ code: 'INVALID_SCOPE' }, 422)
    const { pluginId, accountId, taskId } = parsed.data
    const service = services.authenticate(pluginId, c.req.header('Authorization'))
    if (!service) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ code: 'UNAUTHENTICATED' }, 401)
    }
    if (!service.accounts.has(accountId)) return c.json({ code: 'NOT_FOUND' }, 404)
    if (!service.tasks.length) return c.json({ code: 'FORBIDDEN' }, 403)
    if (c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ code: 'UNSUPPORTED_MEDIA_TYPE' }, 415)
    }
    const input = await c.req.json().catch(() => null)
    const receipt = taskId ? remoteTaskReceipt.safeParse(input).data : undefined
    const bindingVersion = taskId ? receipt?.bindingVersion : remoteTaskClaim.safeParse(input).data?.bindingVersion
    if (bindingVersion === undefined) return c.json({ code: 'INVALID_TASK_REQUEST' }, 422)
    const [{ result }] = await withRemotePluginRole(db, tx => tx.$queryRaw<[{ result: { conflict?: boolean } | null }]>`
      SELECT public.rica_remote_task_v1(${pluginId}, ${accountId}::uuid, ${bindingVersion}::integer,
        ${service.tasks}::text[], ${taskId ?? null}::uuid, ${receipt?.lease ?? null}::uuid,
        ${receipt?.status ?? null}::text, ${receipt ? JSON.stringify(receipt.result) : null}::jsonb) AS result`)
    if (result === null) return c.json({ code: 'NOT_FOUND' }, 404)
    if (result.conflict) return c.json({ code: 'STALE_LEASE' }, 409)
    return c.json((taskId ? remoteTaskReceiptView : remoteTaskLeaseView).parse(result), 200)
  }
  app.post(base + '/claim', limit, handle)
  app.post(base + '/:taskId/receipt', limit, handle)
  return app
}

export function registerRemoteTaskManagement(app: OpenAPIHono<ManagementEnvironment>, db: PrismaClient, services: RemotePluginServices) {
  const path = '/characters/{characterId}/remote-plugins/{pluginId}/tasks' as const
  const params = characterParams.extend({ pluginId: remotePluginId })
  app.openapi(createRoute({
    method: 'post', path, security, request: { params, headers: idempotencyHeader, body: body(remoteTaskInput) },
    responses: { ...errors, 200: success(commandResponse) },
  }), async c => {
    const { characterId, pluginId } = c.req.valid('param')
    const actor = c.get('actor')
    const requestId = c.get('requestId')
    const input = c.req.valid('json')
    const missing = () => new ManagementError(404, 'NOT_FOUND', 'Remote task scope is not available')
    const result = await executeManagementCommand(db, {
      characterId, actor, requestId, input, key: c.req.valid('header')['idempotency-key'],
      operation: 'plugin.remote.' + pluginId + '.task.queue', targetScope: characterId,
      async authorizeTarget(tx) {
        if (!services.canQueue(pluginId, input.accountId, input.type) || !await tx.platformAccount.findFirst({
          where: { id: input.accountId, characterId, bindingVersion: input.bindingVersion, status: 'ACTIVE',
            identity: { status: 'ACTIVE', character: { status: 'ACTIVE' } } }, select: { id: true },
        })) throw missing()
      },
    }, async tx => {
      const [{ id }] = await tx.$queryRaw<[{ id: string | null }]>`
        SELECT public.rica_queue_remote_task_v1(${pluginId}, ${characterId}::uuid, ${input.accountId}::uuid,
          ${input.bindingVersion}::integer, ${input.type}, ${JSON.stringify(input.data)}::jsonb) AS id`
      if (!id) throw missing()
      return { id, status: 'PENDING' }
    })
    return c.json({ ...result, requestId }, 200)
  })
  app.openapi(createRoute({
    method: 'get', path: `${path}/{taskId}`, security, request: { params: params.extend({ taskId: pluginAccountId }) },
    responses: { ...errors, 200: success(z.object({ id: pluginAccountId, status: z.string(), result: z.unknown() })) },
  }), async c => {
    const { characterId, pluginId, taskId } = c.req.valid('param')
    const result = await db.$transaction(async tx => {
      await authorize(tx, { characterId, actor: c.get('actor') })
      const [job] = await tx.$queryRaw<{ id: string; status: string; result: unknown }[]>`
        SELECT t.id,t.result, CASE
          WHEN t.status IN ('SUCCEEDED', 'FAILED') THEN t.status
          WHEN a.binding_version <> t.binding_version OR c.auth_epoch <> t.auth_epoch
            OR a.status <> 'ACTIVE' OR i.status <> 'ACTIVE' OR c.status <> 'ACTIVE' THEN 'CANCELLED'
          WHEN t.expires_at <= statement_timestamp() THEN 'EXPIRED'
          WHEN t.lease_until <= statement_timestamp() THEN 'PENDING'
          ELSE t.status END AS status
        FROM public.remote_plugin_tasks t JOIN public.platform_accounts a ON a.id = t.account_id
        JOIN public.characters c ON c.id = t.character_id
        JOIN public.identities i ON (i.character_id,i.id) = (t.character_id,t.identity_id)
        WHERE t.character_id = ${characterId}::uuid AND t.plugin_id = ${pluginId} AND t.id = ${taskId}::uuid`
      if (!job) throw new ManagementError(404, 'NOT_FOUND', 'Remote task not found')
      return job
    })
    return c.json(result, 200)
  })
}
