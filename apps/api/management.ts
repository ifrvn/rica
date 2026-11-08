import { randomUUID } from 'node:crypto'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { commitmentInput, commitmentQuery, commitmentUpdate, commitmentView } from '../../packages/contracts/commitments.js'
import { scheduleInput, scheduleUpdate, scheduleView } from '../../packages/contracts/schedules.js'
import { dailyMetricsQuery, outboxQuarantineQuery, outboxQuarantineView, runReplayView, simulationBacklogView, simulationDailyMetricsView } from '../../packages/contracts/simulation-observability.js'
import { readQuarantinedOutbox, readSimulationBacklog, readSimulationDailyMetrics, replaySimulationRun, retryQuarantinedOutbox } from '../../packages/persistence/simulation-observability.js'
import * as schema from '../../packages/contracts/management.js'
import type { ResolveSimulationAdapter } from '../../packages/contracts/simulation-platform.js'
import { newbiAccountInput, newbiClosureInput, newbiDecisionInput, newbiInboxView, newbiReplyInput, newbiReplyView } from '../../packages/contracts/newbi-pilot.js'
import { bindNewbiAccount, closeNewbiReply, createNewbiReply, decideNewbiReply, getNewbiInbox, getNewbiReply } from '../../packages/persistence/newbi-management.js'
import { actionDecision, actionView, reconciliationInput, reconciliationView } from '../../packages/contracts/action-review.js'
import { decideReviewAction, listReviewActions } from '../../packages/persistence/action-review.js'
import * as management from '../../packages/persistence/management.js'
import { readSimulationReconciliation, resolveSimulationReconciliation } from '../../packages/persistence/simulation-reconciliation.js'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { localIssuer, type Authenticate, type Principal } from './admin-auth.js'

type Options = {
  db: PrismaClient; authenticate: Authenticate; origin: string; cookie: string; resolveAdapter: ResolveSimulationAdapter
}
type Environment = { Variables: { actor: Principal; requestId: string } }

const json = <S extends z.ZodType>(schema: S) => ({ 'application/json': { schema } })
const success = <S extends z.ZodType>(schema: S) => ({ description: 'Success', content: json(schema) })
const body = <S extends z.ZodType>(schema: S) => ({ required: true, content: json(schema) })
const failure = { description: 'Management error', content: json(schema.errorResponse) }
const errors = { 400: failure, 401: failure, 403: failure, 404: failure, 409: failure, 412: failure,
  413: failure, 422: failure, 428: failure, 500: failure, 503: failure } as const
const security = [{ SessionCookie: [] }]
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

export function createManagementApp({ db, authenticate, origin, cookie, resolveAdapter }: Options) {
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
  app.openAPIRegistry.registerComponent('securitySchemes', 'SessionCookie', { type: 'apiKey', in: 'cookie', name: cookie })

  app.use('*', async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('Origin') !== origin) {
      return c.json(error(requestId, 'ORIGIN_FORBIDDEN', 'Request origin is invalid'), 403)
    }
    let actor: Principal | null
    try { actor = await authenticate(c.req.raw) }
    catch { return c.json(error(requestId, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable'), 503) }
    if (!actor) return c.json(error(requestId, 'UNAUTHENTICATED', 'Authentication required'), 401)
    c.set('actor', actor)
    await next()
  })
  app.use('*', bodyLimit({
    maxSize: 32_768,
    onError: (c) => c.json(error(c.get('requestId'), 'BODY_TOO_LARGE', 'Request body exceeds the size limit'), 413),
  }))
  app.onError((err, c) => {
    const requestId = c.get('requestId')
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
    if (!actor.canCreate) management.denyPermission()
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
    method: 'get', path: `${character}/accounts/{accountId}/automation-eligibility`, security,
    request: { params: characterParams.extend({ accountId: schema.resourceId }) },
    responses: { ...errors, 200: success(schema.automationEligibilityView) },
  }), async (c) => {
    const { characterId, accountId } = c.req.valid('param')
    const view = await management.readAutomationEligibility(db, { characterId, actor: c.get('actor') }, accountId)
    return c.json(schema.automationEligibilityView.parse(view), 200)
  })

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

  const energyParams = characterParams.extend({ utcDay: z.iso.date() })
  app.openapi(createRoute({
    method: 'get', path: `${character}/daily-energy/{utcDay}`, security,
    request: { params: energyParams }, responses: { ...errors, 200: success(schema.dailyEnergyView) },
  }), async (c) => {
    const { characterId, utcDay } = c.req.valid('param')
    return c.json(await management.readDailyEnergy(db, { characterId, actor: c.get('actor') }, utcDay), 200)
  })

  app.openapi(createRoute({
    method: 'post', path: `${character}/daily-energy`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(schema.dailyEnergyInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'state.energy.approve', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.approveDailyEnergy(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/identities/{identityId}/reflections/{utcDay}`, security,
    request: { params: identityParams.extend({ utcDay: z.iso.date() }) },
    responses: { ...errors, 200: success(schema.identityReflectionView) },
  }), async (c) => {
    const { characterId, identityId, utcDay } = c.req.valid('param')
    const view = await management.readIdentityReflection(db, { characterId, actor: c.get('actor') }, identityId, utcDay)
    return c.json(schema.identityReflectionView.parse(view), 200)
  })

  const beliefs = `${character}/identities/{identityId}/beliefs` as const
  const beliefParams = identityParams.extend({ beliefId: schema.resourceId })
  app.openapi(createRoute({
    method: 'get', path: `${beliefs}/{beliefId}`, security,
    request: { params: beliefParams, query: z.object({ revision: z.string().regex(/^[1-9][0-9]{0,8}$/).optional() }) },
    responses: { ...errors, 200: success(schema.beliefView) },
  }), async (c) => {
    const { characterId, identityId, beliefId } = c.req.valid('param')
    const { revision } = c.req.valid('query')
    const view = schema.beliefView.parse(await management.readBelief(
      db, { characterId, actor: c.get('actor') }, identityId, beliefId, revision ? Number(revision) : undefined,
    ))
    c.header('ETag', '"' + view.version + '"')
    return c.json(view, 200)
  })

  app.openapi(createRoute({
    method: 'post', path: beliefs, security,
    request: { params: identityParams, headers: schema.idempotencyHeader, body: body(schema.beliefInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, identityId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'belief.create', targetScope: characterId + '/' + identityId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.writeBelief(tx, scope, identityId, randomUUID(), 0, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'put', path: `${beliefs}/{beliefId}`, security,
    request: { params: beliefParams, headers: schema.versionHeader, body: body(schema.beliefInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, identityId, beliefId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'belief.update', targetScope: characterId + '/' + identityId + '/' + beliefId,
      input: { input, expected }, requestId,
    }, (tx) => management.writeBelief(tx, scope, identityId, beliefId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'post', path: `${beliefs}/{beliefId}/restore`, security,
    request: { params: beliefParams, headers: schema.versionHeader, body: body(schema.beliefRestoreInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, identityId, beliefId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'belief.restore', targetScope: characterId + '/' + identityId + '/' + beliefId,
      input: { input, expected }, requestId,
    }, (tx) => management.writeBelief(tx, scope, identityId, beliefId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  const goals = `${character}/identities/{identityId}/goals` as const
  const goalParams = identityParams.extend({ goalId: schema.resourceId })
  const goalQuery = z.object({ revision: z.string().regex(/^[1-9][0-9]{0,8}$/).optional() })
  const goalList = z.array(schema.manualGoalView)
  app.openapi(createRoute({
    method: 'get', path: goals, security, request: { params: identityParams },
    responses: { ...errors, 200: success(goalList) },
  }), async (c) => {
    const { characterId, identityId } = c.req.valid('param')
    return c.json(goalList.parse(await management.readManualGoals(db, { characterId, actor: c.get('actor') }, identityId)), 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${goals}/{goalId}`, security, request: { params: goalParams, query: goalQuery },
    responses: { ...errors, 200: success(schema.manualGoalView) },
  }), async (c) => {
    const { characterId, identityId, goalId } = c.req.valid('param')
    const revision = c.req.valid('query').revision
    const view = schema.manualGoalView.parse(await management.readManualGoals(
      db, { characterId, actor: c.get('actor') }, identityId, goalId, revision ? Number(revision) : undefined,
    ))
    c.header('ETag', '"' + view.version + '"')
    return c.json(view, 200)
  })

  app.openapi(createRoute({
    method: 'post', path: goals, security,
    request: { params: identityParams, headers: schema.idempotencyHeader, body: body(schema.manualGoalInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, identityId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'goal.create', targetScope: characterId + '/' + identityId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.writeManualGoal(tx, scope, identityId, randomUUID(), 0, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'put', path: `${goals}/{goalId}`, security,
    request: { params: goalParams, headers: schema.versionHeader, body: body(schema.manualGoalInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, identityId, goalId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'goal.update', targetScope: characterId + '/' + identityId + '/' + goalId,
      input: { input, expected }, requestId,
    }, (tx) => management.writeManualGoal(tx, scope, identityId, goalId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  const contactParams = characterParams.extend({ contactId: schema.resourceId })
  app.openapi(createRoute({
    method: 'get', path: `${character}/contacts/{contactId}/boundary`, security,
    request: { params: contactParams }, responses: { ...errors, 200: success(schema.contactBoundaryView) },
  }), async (c) => {
    const { characterId, contactId } = c.req.valid('param')
    const view = await management.readContactBoundary(db, { characterId, actor: c.get('actor') }, contactId)
    c.header('ETag', '"' + view.version + '"')
    return c.json(view, 200)
  })

  app.openapi(createRoute({
    method: 'put', path: `${character}/contacts/{contactId}/boundary`, security,
    request: { params: contactParams, headers: schema.versionHeader, body: body(schema.contactBoundaryInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, contactId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const expected = version(c.req.valid('header'))
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'contact.boundary', targetScope: characterId + '/' + contactId, input: { input, expected }, requestId,
    }, (tx) => management.changeContactBoundary(tx, scope, contactId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  const memoryParams = characterParams.extend({ memoryId: schema.resourceId })
  app.openapi(createRoute({
    method: 'get', path: `${character}/memories/{memoryId}/provenance`, security,
    request: { params: memoryParams }, responses: { ...errors, 200: success(schema.memoryProvenanceView) },
  }), async (c) => {
    const { characterId, memoryId } = c.req.valid('param')
    const view = await management.readMemoryProvenance(db, { characterId, actor: c.get('actor') }, memoryId)
    c.header('ETag', '"' + view.revision + '"')
    return c.json(view, 200)
  })

  app.openapi(createRoute({
    method: 'put', path: `${character}/memories/{memoryId}/correction`, security,
    request: { params: memoryParams, headers: schema.versionHeader, body: body(schema.memoryCorrectionInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, memoryId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const expected = version(c.req.valid('header'))
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'memory.correct', targetScope: characterId + '/' + memoryId, input: { input, expected }, requestId,
    }, (tx) => management.correctMemory(tx, scope, memoryId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

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
    }, async (tx) => {
      if (scope.actor.issuer === localIssuer && input.action === 'GRANT'
        && !await tx.adminUser.findUnique({ where: { username: input.subject }, select: { id: true } })) {
        throw new management.ManagementError(422, 'UNKNOWN_USER', 'Create the local user before granting access')
      }
      return management.changeMembership(tx, scope, input)
    })
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/actions`, security,
    request: { params: characterParams, query: schema.listQuery },
    responses: { ...errors, 200: success(schema.pageView(actionView)) },
  }), async (c) => {
    const { limit, cursor } = management.parsePage(c.req.valid('query'))
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    return c.json(await listReviewActions(db, scope, resolveAdapter, undefined, limit, cursor), 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/actions/{actionId}`, security,
    request: { params: actionParams },
    responses: { ...errors, 200: success(actionView) },
  }), async (c) => {
    const { characterId, actionId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const { items: [proposal] } = await listReviewActions(db, scope, resolveAdapter, actionId)
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
    }, (tx) => decideReviewAction(tx, scope, actionId, expected, input, resolveAdapter))
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

  app.openapi(createRoute({
    method: 'get', path: `${character}/commitments`, security,
    request: { params: characterParams, query: commitmentQuery },
    responses: { ...errors, 200: success(schema.pageView(commitmentView)) },
  }), async (c) => c.json(await management.listCommitments(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, c.req.valid('query'),
  ), 200))

  app.openapi(createRoute({
    method: 'post', path: `${character}/commitments`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(commitmentInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'commitment.create', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => management.createCommitment(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'put', path: `${character}/commitments/{commitmentId}`, security,
    request: {
      params: characterParams.extend({ commitmentId: schema.resourceId }),
      headers: schema.versionHeader, body: body(commitmentUpdate),
    },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, commitmentId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'commitment.update', targetScope: characterId + '/' + commitmentId,
      input: { input, expected }, requestId,
    }, (tx) => management.updateCommitment(tx, scope, commitmentId, expected, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/runs/{runId}/replay`, security,
    request: { params: characterParams.extend({ runId: schema.resourceId }) },
    responses: { ...errors, 200: success(runReplayView) },
  }), async (c) => {
    const { characterId, runId } = c.req.valid('param')
    return c.json(await replaySimulationRun(db, { characterId, actor: c.get('actor') }, runId), 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/outbox/quarantined`, security,
    request: { params: characterParams, query: outboxQuarantineQuery },
    responses: { ...errors, 200: success(outboxQuarantineView) },
  }), async (c) => c.json(await readQuarantinedOutbox(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, c.req.valid('query').after,
  ), 200))

  app.openapi(createRoute({
    method: 'post', path: `${character}/outbox/{eventId}/retry`, security,
    request: {
      params: characterParams.extend({ eventId: schema.resourceId }),
      headers: schema.versionHeader, body: body(schema.reasonInput),
    },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, eventId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'outbox.retry', targetScope: characterId + '/' + eventId,
      input: { ...c.req.valid('json'), expected }, requestId,
    }, (tx) => retryQuarantinedOutbox(tx, scope, eventId, expected))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${character}/monitoring/daily`, security,
    request: { params: characterParams, query: dailyMetricsQuery },
    responses: { ...errors, 200: success(simulationDailyMetricsView) },
  }), async (c) => c.json(await readSimulationDailyMetrics(
    db, { ...c.req.valid('param'), actor: c.get('actor') }, c.req.valid('query'),
  ), 200))

  app.openapi(createRoute({
    method: 'get', path: `${character}/monitoring`, security,
    request: { params: characterParams },
    responses: { ...errors, 200: success(simulationBacklogView) },
  }), async (c) => c.json(await readSimulationBacklog(
    db, { ...c.req.valid('param'), actor: c.get('actor') },
  ), 200))

  const newbi = `${character}/newbi` as const
  const newbiReplyParams = characterParams.extend({ replyId: schema.resourceId })
  app.openapi(createRoute({
    method: 'post', path: `${newbi}/accounts`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(newbiAccountInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'newbi.account.bind', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => bindNewbiAccount(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'post', path: `${newbi}/replies`, security,
    request: { params: characterParams, headers: schema.idempotencyHeader, body: body(newbiReplyInput) },
    responses: { ...errors, 201: success(schema.commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'newbi.reply.create', targetScope: scope.characterId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => createNewbiReply(tx, scope, input))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'get', path: `${newbi}/replies/{replyId}`, security,
    request: { params: newbiReplyParams }, responses: { ...errors, 200: success(newbiReplyView) },
  }), async (c) => {
    const { characterId, replyId } = c.req.valid('param')
    return c.json(await getNewbiReply(db, { characterId, actor: c.get('actor') }, replyId), 200)
  })

  app.openapi(createRoute({
    method: 'post', path: `${newbi}/replies/{replyId}/decision`, security,
    request: { params: newbiReplyParams, headers: schema.idempotencyHeader, body: body(newbiDecisionInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, replyId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'newbi.reply.review', targetScope: characterId + '/' + replyId, input, requestId,
      key: c.req.valid('header')['idempotency-key'], roles: ['REVIEWER'],
    }, (tx) => decideNewbiReply(tx, scope, replyId, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'post', path: `${newbi}/replies/{replyId}/close`, security,
    request: { params: newbiReplyParams, headers: schema.idempotencyHeader, body: body(newbiClosureInput) },
    responses: { ...errors, 200: success(schema.commandResponse) },
  }), async (c) => {
    const { characterId, replyId } = c.req.valid('param')
    const scope = { characterId, actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await management.executeManagementCommand(db, {
      ...scope, operation: 'newbi.reply.close', targetScope: characterId + '/' + replyId, input, requestId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => closeNewbiReply(tx, scope, replyId, input))
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: `${newbi}/accounts/{accountId}/events`, security,
    request: { params: z.object({ characterId: schema.resourceId, accountId: schema.resourceId }) },
    responses: { ...errors, 200: success(newbiInboxView) },
  }), async (c) => {
    const { characterId, accountId } = c.req.valid('param')
    return c.json(await getNewbiInbox(db, { characterId, actor: c.get('actor') }, accountId), 200)
  })

  app.doc31('/openapi.json', {
    openapi: '3.1.0', info: { title: 'Rica Management API', version: '1.0.0' }, servers: [{ url: '/v1' }],
  })
  return app
}
