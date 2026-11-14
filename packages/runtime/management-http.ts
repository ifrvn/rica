import { z } from '@hono/zod-openapi'
import * as schema from '../contracts/management.js'

export type ManagementPrincipal = Readonly<{ issuer: string; subject: string; id: string; canCreate?: boolean }>
export type ManagementEnvironment = { Variables: { actor: ManagementPrincipal; requestId: string } }

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
