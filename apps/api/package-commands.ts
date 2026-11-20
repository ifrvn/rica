import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { commandResponse, idempotencyHeader, resourceId } from '@ricajs/contracts/management'
import { executeManagementCommand, ManagementError } from '@ricajs/persistence/management'
import { body, characterParams, errors, security, success, type ManagementEnvironment } from '@ricajs/persistence/management-http'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import type { PackageCommands } from '../package-plugins.js'
import { packageObject } from '../package-database.js'

const resultSchema = commandResponse.pick({ id: true, status: true, version: true }).strict()
const jsonData = z.unknown().refine(value => z.json().safeParse(value).success, 'Expected a JSON value')

export function registerPackageCommands(app: OpenAPIHono<ManagementEnvironment>, db: PrismaClient, source: PackageCommands) {
  for (const command of source.commands) {
    const input = z.strictObject({ data: jsonData,
      ...(command.scope === 'account' ? { accountId: resourceId } : {}) })
    app.openapi(createRoute({
      method: 'post', path: `/characters/{characterId}/plugins/${source.id}/commands/${command.id}`,
      security, request: { params: characterParams, headers: idempotencyHeader, body: body(input) },
      responses: { ...errors, 200: success(commandResponse) },
    }), async (c) => {
      const { characterId } = c.req.valid('param')
      const actor = c.get('actor')
      const requestId = c.get('requestId')
      const payload = c.req.valid('json')
      const accountId = payload.accountId ?? null
      const result = await executeManagementCommand(db, {
        actor, characterId, requestId, input: payload, key: c.req.valid('header')['idempotency-key'],
        operation: `plugin.${source.id}.${command.id}`, targetScope: characterId,
        async authorizeTarget(tx) {
          if (!accountId) return
          const account = await tx.platformAccount.findFirst({
            where: { id: accountId, characterId, platform: source.id, status: { not: 'REVOKED' } }, select: { id: true },
          })
          if (!account) throw new ManagementError(404, 'NOT_FOUND', 'Plugin account not found')
        },
      }, async (tx) => {
        const [row] = await tx.$queryRaw<{ result: unknown }[]>`
          SELECT ${packageObject(source.schema, command.function)}(
            ${characterId}::uuid, ${actor.id}::text, ${accountId}::uuid, ${JSON.stringify(payload.data)}::jsonb
          ) AS result`
        if (row?.result === null) throw new ManagementError(409, 'PLUGIN_COMMAND_REJECTED', 'Plugin did not accept the command')
        return resultSchema.parse(row?.result)
      })
      return c.json({ ...result, requestId }, 200)
    })
  }
}
