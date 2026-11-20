import { z } from '@hono/zod-openapi'
import * as schema from '@ricajs/contracts/management'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { ManagementError, type ManagementCommandHandler, type PlatformAccountHooks, type Scope } from './index.js'
import type { Prisma } from '../generated/client.js'

export type ManagementPrincipal = Readonly<{ issuer: string; subject: string; id: string; canCreate?: boolean }>
export type ManagementEnvironment = { Variables: { actor: ManagementPrincipal; requestId: string } }

export type ManagementPlugin = {
  id: string
  registerRoutes(app: OpenAPIHono<ManagementEnvironment>): void
  // Sources project id, kind, platform, identity, account, account_id, state, created_at.
  runActivity?: Partial<Record<z.infer<typeof schema.runActivityKind>, (characterId: string) => Prisma.Sql>>
  account?: PlatformAccountHooks & {
    registration: z.ZodType<{ platform: string }>
    register(scope: Scope, input: unknown): ManagementCommandHandler
  }
  workspace?: { fields: z.ZodRawShape; read(): Promise<object> }
  status?: { fields: z.ZodRawShape; read(characterId: string): Promise<object> }
  accountFields?: z.ZodRawShape
}

export function extensionFields(base: z.ZodRawShape, fields: readonly (z.ZodRawShape | undefined)[]) {
  const extensions: { -readonly [Key in keyof z.ZodRawShape]: z.ZodRawShape[Key] } = {}
  for (const shape of fields) {
    for (const [name, field] of Object.entries(shape ?? {})) {
      if (name in base || name in extensions) throw new Error('Duplicate management field: ' + name)
      extensions[name] = field
    }
  }
  return extensions
}

const json = <S extends z.ZodType>(schema: S) => ({ 'application/json': { schema } })
export const success = <S extends z.ZodType>(schema: S) => ({ description: 'Success', content: json(schema) })
export const body = <S extends z.ZodType>(schema: S) => ({ required: true, content: json(schema) })
export const failure = { description: 'Management error', content: json(schema.errorResponse) }
export const errors = { 400: failure, 401: failure, 403: failure, 404: failure, 409: failure, 412: failure,
  413: failure, 422: failure, 428: failure, 500: failure, 503: failure } as const
export const security = [{ SessionCookie: [] }]
export const character = '/characters/{characterId}' as const
export const characterParams = z.object({ characterId: schema.resourceId })

export function error(requestId: string, code: string, message: string) {
  return { error: { requestId, code, message } }
}

export function version(headers: z.infer<typeof schema.versionHeader>) {
  const header = headers['if-match']
  const value = Number(/^"(0|[1-9][0-9]{0,9})"$/.exec(header)?.[1])
  if (!Number.isInteger(value) || value >= 2_147_483_647) {
    throw new ManagementError(422, 'INVALID_VERSION', 'Expected a quoted resource version')
  }
  return value
}
