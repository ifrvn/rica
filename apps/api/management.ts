import { randomUUID } from 'node:crypto'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { scheduleInput, scheduleUpdate, scheduleView } from '../../packages/contracts/schedules.js'
import * as schema from '../../packages/contracts/management.js'
import { actionDecision, actionView, reconciliationInput, reconciliationView } from '../../packages/contracts/action-review.js'
import { decideReviewAction, listReviewActions } from '../../packages/persistence/action-review.js'
import * as management from '../../packages/persistence/management.js'
import { readSimulationReconciliation, resolveSimulationReconciliation } from '../../packages/persistence/simulation-reconciliation.js'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { AuthenticationUnavailable, type Authenticate, type Principal } from './admin-auth.js'

type Options = { db: PrismaClient; authenticate: Authenticate; creatorSubjects: readonly string[] }
type Environment = { Variables: { actor: Principal; requestId: string } }

const json = <S extends z.ZodType>(schema: S) => ({ 'application/json': { schema } })
const success = <S extends z.ZodType>(schema: S) => ({ description: 'Success', content: json(schema) })
const body = <S extends z.ZodType>(schema: S) => ({ required: true, content: json(schema) })
const failure = { description: 'Management error', content: json(schema.errorResponse) }
const errors = { 400: failure, 401: failure, 403: failure, 404: failure, 409: failure, 412: failure,
  413: failure, 422: failure, 428: failure, 500: failure, 503: failure } as const
const security = [{ Bearer: [] }]
const character = '/characters/{characterId}' as const
const characterParams = z.object({ characterId: schema.resourceId })
const identityParams = characterParams.extend({ identityId: schema.resourceId })
const grantParams = characterParams.extend({ grantId: schema.resourceId })
const actionParams = characterParams.extend({ actionId: schema.resourceId })

function error(requestId: string, code: string, message: string) {
  return { error: { requestId, code, message } }
}


function version(headers: z.infer<typeof schema.versionHeader>) {
  const header = headers['if-match']
  const value = Number(/^"(0|[1-9][0-9]{0,9})"$/.exec(header)?.[1])
  if (!Number.isInteger(value) || value >= 2_147_483_647) {
    throw new management.ManagementError(422, 'INVALID_VERSION', 'Expected a quoted resource version')
  }
  return value
}

function runVersion(header: string) {
  const value = Number(/^"run-v([1-9][0-9]{0,9})"$/.exec(header)?.[1])
  if (!Number.isInteger(value) || value >= 2_147_483_647) {
    throw new management.ManagementError(422, 'INVALID_VERSION', 'Expected a quoted run version')
  }
  return value
}

export function createManagementApp({ db, authenticate, creatorSubjects }: Options) {
  const app = new OpenAPIHono<Environment>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const requestId = c.get('requestId')
        if (result.target === 'header' && (c.req.method === 'PUT' || /\/(decisions|reconciliation)$/.test(c.req.path))
          && c.req.header('If-Match') === undefined) {
          return c.json(error(requestId, 'VERSION_REQUIRED', 'If-Match is required'), 428)
        }
        return c.json(error(requestId, 'INVALID_INPUT', 'Request fields are invalid'), 422)
      }
    },
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', { type: 'http', scheme: 'bearer' })

  app.use('*', async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    c.header('Cache-Control', 'no-store')
    const actor = await authenticate(c.req.header('Authorization'))
    if (!actor) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json(error(requestId, 'UNAUTHENTICATED', 'Authentication required'), 401)
    }
    c.set('actor', actor)
    await next()
  })
  app.use('*', bodyLimit({
    maxSize: 32_768,
    onError: (c) => c.json(error(c.get('requestId'), 'BODY_TOO_LARGE', 'Request body exceeds the size limit'), 413),
  }))
  app.onError((err, c) => {
    const requestId = c.get('requestId')
    if (err instanceof AuthenticationUnavailable) {
      return c.json(error(requestId, 'IDENTITY_PROVIDER_UNAVAILABLE', 'Authentication is temporarily unavailable'), 503)
    }
    if (err instanceof management.ManagementError) return c.json(error(requestId, err.code, err.message), err.status)
    if (err instanceof HTTPException && err.status === 400) {
      return c.json(error(requestId, 'INVALID_BODY', 'Malformed request body'), 400)
    }
    if ('code' in err && err.code === 'P2002') {
      return c.json(error(requestId, 'CONFLICT', 'Resource already exists'), 409)
    }
    if ('code' in err && (err.code === 'P2003' || err.code === 'P2004')) {
      return c.json(error(requestId, 'INVALID_INPUT', 'Request violates a resource constraint'), 422)
    }
    console.error(JSON.stringify({ service: 'api', event: 'management_error', requestId }))
    return c.json(error(requestId, 'INTERNAL_ERROR', 'Request could not be completed'), 500)
  })

  app.openapi(createRoute({
    method: 'get', path: '/characters', security,
    request: { query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(schema.characterView)) },
  }), async (c) => c.json(await management.listCharacters(db, c.get('actor'), management.parsePage(c.req.valid('query'))), 200))

  app.openapi(createRoute({
    method: 'post', path: '/characters', security,
    request: { headers: schema.idempotencyHeader, body: body(schema.characterInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const actor = c.get('actor')
    if (!creatorSubjects.includes(actor.subject)) management.denyPermission()
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      actor, operation: 'character.create', targetScope: '/characters', input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.createCharacter(tx, actor, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'get', path: character, security, request: { params: characterParams },
    responses: { ...errors, 200: success(schema.characterView) },
  }), async (c) => {
    const result = await management.getCharacter(db, { ...c.req.valid('param'), actor: c.get('actor') })
    c.header('ETag', `"${result.version ?? 0}"`)
    return c.json(result, 200)
  })

  app.openapi(createRoute({
    method: 'put', path: `${character}/core`, security,
    request: { params: characterParams, headers: schema.versionHeader, body: body(schema.coreInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'character.core.update', targetScope: scope.characterId, input: { input, expected }, requestId,
    }, (tx) => management.updateCore(tx, scope, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/identities`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(schema.identityView)) },
  }), async (c) => c.json(await management.listIdentities(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, management.parsePage(c.req.valid('query')),
  ), 200))

  app.openapi(createRoute({
    method: 'post', path: `${character}/identities`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(schema.identityInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'identity.create', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.createIdentity(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'put', path: `${character}/identities/{identityId}`, security,
    request: { params: identityParams, headers: schema.versionHeader, body: body(schema.identityUpdate) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { identityId, characterId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'identity.update', targetScope: characterId + '/' + identityId, input: { input, expected }, requestId,
    }, (tx) => management.updateIdentity(tx, scope, identityId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/accounts`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(schema.accountView)) },
  }), async (c) => c.json(await management.listAccounts(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, management.parsePage(c.req.valid('query')),
  ), 200))

  app.openapi(createRoute({
    method: 'post', path: `${character}/accounts`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(schema.accountInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'account.create', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.createAccount(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'post', path: `${character}/controls`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(schema.controlInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'control.apply', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.control(tx, scope, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/memories`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(schema.memoryView)) },
  }), async (c) => c.json(await management.listMemories(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, management.parsePage(c.req.valid('query')),
  ), 200))

  app.openapi(createRoute({
    method: 'get', path: `${character}/memory-grants`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(schema.grantView)) },
  }), async (c) => c.json(await management.listGrants(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, management.parsePage(c.req.valid('query')),
  ), 200))

  app.openapi(createRoute({
    method: 'post', path: `${character}/memory-grants`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(schema.memoryGrantInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'memory.grant.create', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.createGrant(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'post', path: `${character}/memory-grants/{grantId}/revoke`, security,
    request: { params: grantParams, headers: schema.idempotencyHeader, body: body(schema.reasonInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, grantId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'memory.grant.revoke', targetScope: characterId + '/' + grantId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.revokeGrant(tx, scope, grantId))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/audit`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(schema.auditView)) },
  }), async (c) => c.json(await management.listAudit(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, management.parsePage(c.req.valid('query')),
  ), 200))

  app.openapi(createRoute({
    method: 'post', path: `${character}/memberships`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(schema.membershipInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'membership.change',
      targetScope: scope.characterId, input, requestId, key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.changeMembership(tx, scope, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/actions`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(actionView)) },
  }), async (c) => {
    const { limit, cursor } = management.parsePage(c.req.valid('query'))
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    return c.json(await listReviewActions(db, scope, undefined, limit, cursor), 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/actions/{actionId}`, security,
    request: { params: actionParams },
    responses: { ...errors, 200: success(actionView) },
  }), async (c) => {
    const { characterId, actionId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const { items: [proposal] } = await listReviewActions(db, scope, actionId)
    c.header('ETag', `"run-v${proposal.version}"`)
    return c.json(proposal, 200)
  })

  app.openapi(createRoute({
    method: 'post', path: `${character}/actions/{actionId}/decisions`, security,
    request: { params: actionParams, headers: schema.idempotencyHeader.merge(schema.versionHeader), body: body(actionDecision) },
    responses: { ...errors, 200: success(schema.commandResponse), 409: failure },
  }), async (c) => {
    const { characterId, actionId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const headers = c.req.valid('header')
    const expected = runVersion(headers['if-match'])
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'action.review', targetScope: characterId + '/' + actionId,
      input: { input, expected }, requestId, key: headers['idempotency-key'], roles: ['REVIEWER'],
    }, (tx) => decideReviewAction(tx, scope, actionId, expected, input))
    if (result.status === 'CANCELED' || result.status === 'EXPIRED') {
      return c.json(error(requestId, 'STALE_REVIEW', 'Proposal is no longer eligible for review'), 409)
    }
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/actions/{actionId}/reconciliation`, security,
    request: { params: actionParams },
    responses: { ...errors, 200: success(reconciliationView) },
  }), async (c) => {
    const { characterId, actionId } = c.req.valid('param')
    const result = await readSimulationReconciliation(db, { characterId, actor: c.get('actor') }, actionId)
    c.header('ETag', `"run-v${result.version}"`)
    return c.json(result, 200)
  })

  app.openapi(createRoute({
    method: 'post', path: `${character}/actions/{actionId}/reconciliation`, security,
    request: { params: actionParams, headers: schema.idempotencyHeader.merge(schema.versionHeader), body: body(reconciliationInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, actionId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const headers = c.req.valid('header')
    const expected = runVersion(headers['if-match'])
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'simulation.resolve', targetScope: characterId + '/' + actionId,
      input: { input, expected }, requestId, key: headers['idempotency-key'],
    }, (tx) => resolveSimulationReconciliation(tx, scope, actionId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/schedules`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(scheduleView)) },
  }), async (c) => c.json(await management.listSchedules(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, management.parsePage(c.req.valid('query')),
  ), 200))

  app.openapi(createRoute({
    method: 'post', path: `${character}/schedules`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(scheduleInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'schedule.create', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.createSchedule(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'put', path: `${character}/schedules/{scheduleId}`, security,
    request: {
      params: characterParams.extend({ scheduleId: schema.resourceId }),
      headers: schema.versionHeader, body: body(scheduleUpdate),
    },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, scheduleId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'schedule.update', targetScope: characterId + '/' + scheduleId,
      input: { input, expected }, requestId,
    }, (tx) => management.updateSchedule(tx, scope, scheduleId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.doc31('/openapi.json', {
    openapi: '3.1.0', info: { title: 'Rica Management API', version: '1.0.0' }, servers: [{ url: '/v1' }],
  })
  return app
}
