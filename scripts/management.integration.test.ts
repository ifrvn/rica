import { startCognitionPlugins, startSimulationPlatforms } from '../apps/runtime-plugins.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { newbiExecutorIdentity, newbiExecutorKey } from '../packages/contracts/newbi-executor-identity.js'
import { createNewbiReplyExecutor } from '../packages/runtime/newbi-client.js'
import { startNewbiReader, verifyNewbiBinding } from '../apps/worker/newbi-read-plugin.js'
import { pollNewbiEvents } from '../packages/persistence/newbi-events.js'
import { executeNewbiReply } from '../packages/persistence/newbi-execution.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { simulatedModelPlugin } from '../packages/runtime/simulated-model.js'
import { startOutboxWorker } from '../apps/worker/outbox.js'
import { dailyScheduleSlot, scanSimulationSchedules } from '../packages/persistence/simulation-schedules.js'
import { after, before, test } from 'node:test'
import { actorId, loadManagementConfig, localIssuer } from '../apps/api/admin-auth.js'
import { createAdminAuth } from '../apps/api/admin-auth-routes.js'
import { Redis } from 'ioredis'
import { createApp } from '../apps/api/app.js'
import { createManagementApp } from '../apps/api/management.js'
import { deriveMemory, revokeMemoryAccess } from '../packages/persistence/memory.js'
import { reviewTarget } from '../packages/contracts/action-review.js'
import { decideReviewAction, listReviewActions } from '../packages/persistence/action-review.js'
import { sweepSimulationRetention } from '../packages/persistence/simulation-retention.js'
import { loadRunContinuity } from '../packages/persistence/run-continuity.js'
import { createDatabase } from '../packages/persistence/client.js'
import { scanIdentityReflections } from '../packages/persistence/identity-reflection.js'
import { createSimulatedPlatformIngress, ingestSimulatedEvent } from '../packages/persistence/inbound.js'
import { draftQueuedEvent, prepareSimulatedRun, runQueuedEvent } from '../packages/persistence/run-context.js'
import { processSimulatedDraft } from '../packages/persistence/simulated-draft.js'
import { executeSimulation, recordSimulationReceipt, reserveSimulation, runSimulationBatch } from '../packages/persistence/simulation-execution.js'
import { loadConfig } from '../packages/runtime/config.js'

const config = loadConfig()
const simulationPlatforms = await startSimulationPlatforms({})
const owner = createDatabase(config.databaseUrl)
const adminUrl = new URL(config.databaseUrl)
adminUrl.searchParams.set('options', '-c role=rica_admin_api')
const management = createDatabase(adminUrl.toString())
const issuer = 'https://identity.example.test'
const fixtureOrigin = 'http://localhost:5173'
const subjects = new Set(['admin-a', 'admin-b', 'reviewer', 'auditor'])
let connectorEnv: NodeJS.ProcessEnv = {}
const app = createApp({ postgres: async () => true, redis: async () => true }, createManagementApp({
  db: management,
  origin: fixtureOrigin, cookie: 'fixture-session', resolveAdapter: simulationPlatforms.resolveAdapter,
  verifyConnector: (endpoint, agentId) => verifyNewbiBinding(endpoint, agentId, connectorEnv),
  authenticate: async (request) => {
    const subject = request.headers.get('Cookie')?.match(/^fixture-session=([a-z-]+)$/u)?.[1]
    return subject && subjects.has(subject) ? {
      issuer, subject, id: actorId(issuer, subject), canCreate: subject.startsWith('admin-'),
    } : null
  },
}))

const prefix = 'management-' + randomUUID()
const characterIds: string[] = []
let a: string
let b: string
let identityA: string
let identityB: string
let accountA: string

type RequestOptions = { actor?: string | null; key?: string; ifMatch?: string; data?: unknown }
async function request(method: string, path: string, options: RequestOptions = {}) {
  const { actor = 'admin-a', data, key, ifMatch } = options
  const headers = new Headers()
  headers.set('Origin', fixtureOrigin)
  if (actor) headers.set('Cookie', 'fixture-session=' + actor)
  if (data !== undefined) headers.set('Content-Type', 'application/json')
  if (key) headers.set('Idempotency-Key', key)
  if (ifMatch) headers.set('If-Match', ifMatch)
  const response = await app.request('/v1' + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

function characterPath(id: string) { return '/characters/' + id }
function characterData(suffix: string) {
  return { slug: prefix + suffix, timezone: 'UTC', coreProfile: { name: 'Rica', aiDisclosure: 'AI role' } }
}

before(async () => {
  for (const [actor, suffix] of [['admin-a', '-a'], ['admin-b', '-b']]) {
    const created = await request('POST', '/characters', { actor, key: prefix, data: characterData(suffix) })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    characterIds.push(created.body.id)
  }
  ;[a, b] = characterIds
  const ia = await request('POST', characterPath(a) + '/identities', {
    key: 'identity-a', data: { slug: 'one', roleProfile: { writingStyle: 'formal' } },
  })
  const ib = await request('POST', characterPath(b) + '/identities', {
    actor: 'admin-b', key: 'identity-b', data: { slug: 'two', roleProfile: { writingStyle: 'casual' } },
  })
  assert.equal(ia.status, 201, JSON.stringify(ia.body))
  assert.equal(ib.status, 201, JSON.stringify(ib.body))
  identityA = ia.body.id
  identityB = ib.body.id
  const account = await request('POST', characterPath(a) + '/accounts', {
    key: 'account-a', data: {
      identityId: identityA, platform: 'mock-a', instanceKey: 'integration', remoteAccountId: prefix,
    },
  })
  assert.equal(account.status, 201, JSON.stringify(account.body))
  accountA = account.body.id
  const role = await request('POST', characterPath(a) + '/memberships', {
    key: 'role-reviewer', data: { subject: 'reviewer', role: 'REVIEWER', action: 'GRANT', reason: 'Reviewer fixture' },
  })
  assert.equal(role.status, 200, JSON.stringify(role.body))
})

after(async () => {
  try {
    await owner.$transaction(async (tx) => {
      const where = { characterId: { in: characterIds } }
      await tx.managementIdempotency.deleteMany({ where: {
        OR: characterIds.flatMap((id) => [
          { routeScope: { contains: id } }, { response: { path: ['id'], equals: id } },
        ]),
      } })
      await tx.outboxEvent.deleteMany({ where: { run: where } })
      await tx.commitmentRevision.deleteMany({ where })
      await tx.simulationCommitment.deleteMany({ where })
      await tx.simulationReceipt.deleteMany({ where })
      await tx.simulationAttempt.deleteMany({ where })
      await tx.actionApproval.deleteMany({ where })
      await tx.actionProposal.deleteMany({ where })
      await tx.simulatedDraft.deleteMany({ where })
      await tx.contextSnapshotEvidence.deleteMany({ where })
      await tx.contextSnapshot.deleteMany({ where })
      await tx.scheduleOccurrence.deleteMany({ where })
      await tx.simulationSchedule.deleteMany({ where })
      await tx.identityStateRevision.deleteMany({ where })
      await tx.agentRun.deleteMany({ where })
      await tx.inboundEvent.deleteMany({ where })
      await tx.managementAudit.deleteMany({ where })
      await tx.managementMembership.deleteMany({ where })
      await tx.memoryGrant.deleteMany({ where })
      await tx.goalVersion.deleteMany({ where })
      await tx.identityReflection.deleteMany({ where })
      await tx.beliefEvidence.deleteMany({ where })
      await tx.beliefVersion.deleteMany({ where })
      await tx.memorySource.deleteMany({ where })
      await tx.memoryCorrection.deleteMany({ where })
      await tx.memory.deleteMany({ where })
      await tx.sourceRecord.deleteMany({ where })
      await tx.conversation.deleteMany({ where })
      await tx.contact.deleteMany({ where })
      await tx.newbiReply.deleteMany({ where })
      await tx.platformAccount.deleteMany({ where })
      await tx.identity.updateMany({ where, data: { status: 'PAUSED', activeVersion: null } })
      await tx.identityVersion.deleteMany({ where })
      await tx.identity.deleteMany({ where })
      await tx.character.updateMany({ where: { id: { in: characterIds } }, data: { status: 'PAUSED', activeCoreVersion: null } })
      await tx.coreVersion.deleteMany({ where })
      await tx.dailyEnergyProjection.deleteMany({ where })
      await tx.modelDailyUsage.deleteMany({ where })
      await tx.character.deleteMany({ where: { id: { in: characterIds } } })
    })
  } finally {
    await Promise.all([management.$disconnect(), owner.$disconnect()])
  }
})

test('local authentication enforces origin, membership and session revocation', { timeout: 30_000 }, async () => {
  const authConfig = loadManagementConfig({
    RICA_MANAGEMENT_DATABASE_URL: adminUrl.toString(), RICA_ADMIN_ORIGIN: fixtureOrigin,
  })!
  const redis = new Redis(config.redisUrl)
  const auth = createAdminAuth(management, redis, authConfig)
  const local = createApp({ postgres: async () => true, redis: async () => true },
    createManagementApp({
      db: management, authenticate: auth.authenticate, origin: fixtureOrigin, cookie: authConfig.cookie,
      resolveAdapter: simulationPlatforms.resolveAdapter,
    }),
    auth.app,
  )
  const suffix = randomUUID()
  const username = 'local-' + suffix
  const oldPassword = 'old fixture password'
  const newPassword = 'new fixture password'
  async function accountCommand(args: string[], password: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/admin-user.ts', ...args], {
      env: { ...process.env, MIGRATION_DATABASE_URL: config.databaseUrl }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    const closed = once(child, 'close')
    child.stdin.end(password + '\n')
    assert.equal((await closed)[0], 0, output)
  }
  const submit = (path: string, data: object, cookie = '', origin = fixtureOrigin) => local.request('/v1/auth/' + path, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  const session = (cookie: string) => local.request('/v1/auth/session', { headers: { Cookie: cookie } })
  try {
    await accountCommand(['add', username, '--creator'], oldPassword)
    const user = await owner.adminUser.findUniqueOrThrow({ where: { username } })
    assert.equal(user.actorId, actorId(localIssuer, username))
    assert.equal(user.canCreate, true)
    await owner.managementMembership.create({ data: {
      characterId: b, issuer: localIssuer, subject: username, role: 'AUDITOR',
    } })
    assert.equal((await submit('login', { username, password: oldPassword }, '', 'https://foreign.example.test')).status, 403)
    assert.equal((await submit('login', { username, password: newPassword })).status, 401)
    const login = await submit('login', { username, password: oldPassword })
    assert.equal(login.status, 200)
    const cookieHeader = login.headers.get('set-cookie')!
    const cookie = cookieHeader.split(';')[0]
    assert.match(cookieHeader, /HttpOnly/i)
    assert.match(cookieHeader, /SameSite=Strict/i)
    const currentSession = await session(cookie)
    assert.equal(currentSession.status, 200)
    assert.deepEqual(await currentSession.json(), { username, canCreate: true })
    assert.equal((await local.request('/v1' + characterPath(b), { headers: { Cookie: cookie } })).status, 200)
    assert.equal((await local.request('/v1' + characterPath(a), { headers: { Cookie: cookie } })).status, 404)
    assert.equal((await local.request('/v1/characters', { method: 'POST', headers: { Cookie: cookie } })).status, 403)

    assert.equal((await submit('passkeys/register/options', { password: oldPassword })).status, 401)
    assert.equal((await submit('passkeys/register/options', { password: newPassword }, cookie)).status, 422)
    const options = await submit('passkeys/register/options', { password: oldPassword }, cookie)
    assert.equal(options.status, 200)
    const { challengeId } = await options.json()
    const second = await submit('login', { username, password: oldPassword })
    const secondCookie = second.headers.get('set-cookie')!.split(';')[0]
    const response = { id: 'fake', rawId: 'fake', type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: 'e30', attestationObject: 'AA' } }
    assert.equal((await submit('passkeys/register/verify', { challengeId, response }, secondCookie)).status, 422)
    assert.equal((await submit('passkeys/register/verify', { challengeId, response }, cookie)).status, 422)
    assert.equal(await owner.adminPasskey.count({ where: { userId: user.id } }), 0)

    assert.equal((await submit('logout', {}, cookie)).status, 200)
    assert.equal((await session(cookie)).status, 401)
    await accountCommand(['reset', username], newPassword)
    assert.equal((await session(secondCookie)).status, 401)
    assert.equal((await submit('login', { username, password: oldPassword })).status, 401)
    const renewed = await submit('login', { username, password: newPassword })
    assert.equal(renewed.status, 200)
    await submit('logout', {}, renewed.headers.get('set-cookie')!.split(';')[0])
  } finally {
    await owner.managementMembership.deleteMany({ where: { issuer: localIssuer, subject: username } })
    await owner.adminUser.deleteMany({ where: { username } })
    await redis.quit()
  }
})

test('authentication and membership distinguish unauthenticated, forbidden and foreign resources', async () => {
  const absent = await request('GET', characterPath(a), { actor: null })
  assert.equal(absent.status, 401)
  assert.equal((await app.request('/v1' + characterPath(a) + '/identities', {
    method: 'POST', headers: { Cookie: 'fixture-session=admin-a', Origin: 'http://other.example' },
  })).status, 403)
  assert.equal(absent.body.error.requestId, absent.headers.get('x-request-id'))
  assert.equal((await request('GET', characterPath(b))).status, 404)
  const catalog = await request('GET', characterPath(a) + '/plugins')
  assert.equal(catalog.status, 200)
  assert.equal(catalog.body.services.length, 5)
  assert.ok(catalog.body.services.every(({ report }: { report: unknown }) => report === null))
  assert.equal((await request('GET', characterPath(a) + '/plugins', { actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', characterPath(a) + '/plugins', { actor: 'admin-b' })).status, 404)

  const reviewerWorkspace = await request('GET', characterPath(a), { actor: 'reviewer' })
  assert.equal(reviewerWorkspace.status, 200)
  assert.deepEqual(reviewerWorkspace.body.roles, ['REVIEWER'])
  assert.deepEqual(reviewerWorkspace.body.simulationPlatforms, [])
  const adminWorkspace = await request('GET', characterPath(a))
  assert.equal(adminWorkspace.status, 200)
  assert.deepEqual(adminWorkspace.body.roles, ['ADMIN'])
  assert.deepEqual(adminWorkspace.body.simulationPlatforms, ['mock-a', 'mock-b'])
  const membersPath = characterPath(a) + '/memberships'
  const firstMembers = await request('GET', membersPath + '?limit=1')
  assert.equal(firstMembers.status, 200, JSON.stringify(firstMembers.body))
  assert.deepEqual(firstMembers.body.items, [{ subject: 'admin-a', roles: ['ADMIN'] }])
  assert.equal(firstMembers.body.nextCursor, 'admin-a')
  assert.deepEqual((await request('GET', membersPath + '?limit=1&after=admin-a')).body.items,
    [{ subject: 'reviewer', roles: ['REVIEWER'] }])
  assert.equal((await request('GET', membersPath, { actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', membersPath, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('POST', characterPath(a) + '/identities', {
    actor: 'reviewer', key: 'should-not-create', data: { slug: 'forbidden', roleProfile: {} },
  })).status, 403)
  assert.equal((await request('POST', characterPath(a) + '/accounts', {
    key: 'foreign-identity', data: {
      identityId: identityB, platform: 'mock-b', instanceKey: 'integration', remoteAccountId: 'foreign',
    },
  })).status, 404)
  assert.equal((await request('POST', characterPath(a) + '/memberships', {
    key: 'last-admin', data: { subject: 'admin-a', role: 'ADMIN', action: 'REVOKE', reason: 'Attempt lockout' },
  })).body.error.code, 'LAST_ADMIN')
  assert.equal((await request('POST', characterPath(a) + '/memberships', {
    key: 'remove-reviewer', data: { subject: 'reviewer', role: 'REVIEWER', action: 'REVOKE', reason: 'Remove access' },
  })).status, 200)
  assert.equal((await request('GET', characterPath(a), { actor: 'reviewer' })).status, 404)
  assert.deepEqual((await request('GET', '/characters')).body.items.map(({ id }: { id: string }) => id), [a])
})

test('management commands reject stale updates and commit idempotency and audit atomically', async () => {
  const path = characterPath(a)
  const core = { coreProfile: { aiDisclosure: 'AI role, version two' } }
  assert.equal((await request('PUT', path + '/core', { data: core })).status, 428)
  const updates = await Promise.all(Array.from({ length: 2 }, () =>
    request('PUT', path + '/core', { ifMatch: '"1"', data: core }),
  ))
  assert.deepEqual(updates.map(({ status }) => status).sort(), [200, 412])
  const character = await request('GET', path)
  assert.equal(character.headers.get('etag'), '"2"')
  assert.equal(character.body.version, 2)

  const data = { slug: 'single-create', roleProfile: { displayName: 'One', writingStyle: 'concise' } }
  assert.equal((await request('POST', path + '/identities', { data })).status, 422)
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    request('POST', path + '/identities', { key: 'same-key', data }),
  ))
  assert.ok(results.every(({ status, body }) => status === 201 && body.id === results[0].body.id))
  assert.equal((await request('POST', path + '/identities', { key: 'same-key', data: { ...data, slug: 'different' } })).status, 409)
  const id = results[0].body.id
  assert.equal((await owner.managementAudit.count({ where: { targetId: id } })), 1)
  await assert.rejects(management.managementAudit.deleteMany({ where: { targetId: id } }), /permission denied/i)
  assert.equal((await owner.managementAudit.count({ where: { targetId: a, operation: 'character.core.update' } })), 1)
  const log = await request('GET', path + '/audit?limit=1')
  assert.equal(log.status, 200)
  assert.equal(log.body.items.length, 1)
  assert.match(log.body.items[0].digest, /^[a-f0-9]{64}$/)
  const next = await request('GET', path + '/audit?limit=1&cursor=' + log.body.nextCursor)
  assert.equal(next.status, 200)
  assert.notEqual(next.body.items[0].id, log.body.items[0].id)
  assert.equal((await request('GET', path + '/identities?cursor=' + identityB)).status, 422)
  const spec = await request('GET', '/openapi.json')
  assert.equal(spec.status, 200)
  assert.ok(spec.body.paths['/characters/{characterId}/core'].put.parameters.some(
    (parameter: { name: string; required: boolean }) => parameter.name === 'if-match' && parameter.required,
  ))
})


async function databaseNow() {
  const [clock] = await owner.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS now`
  return clock.now.getTime()
}

async function proposeReview(accountId = accountA, contactId?: string, model = simulatedModelPlugin, identityId = identityA) {
  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    const audience = await owner.conversation.create({
      data: {
        characterId: a, identityId, accountId, remoteKey: randomUUID(),
        channel: contactId ? 'PRIVATE' : 'PUBLIC', privateContactId: contactId,
      },
    })
    const proposalText = 'unique review ' + randomUUID()
    const memory = await owner.memory.create({
      data: { characterId: a, identityId, scope: 'IDENTITY', visibility: 'PUBLIC', content: proposalText },
    })
    const source = await owner.sourceRecord.create({
      data: { characterId: a, identityId, kind: 'fixture', sourceKey: randomUUID(), classification: 'PUBLIC' },
    })
    await owner.memorySource.create({ data: { characterId: a, memoryId: memory.id, sourceId: source.id } })
    const grant = await owner.memoryGrant.create({
      data: {
        characterId: a, memoryId: memory.id, recipientIdentityId: identityId, recipientAccountId: accountId,
        ...(contactId
          ? { purpose: 'PRIVATE_REPLY', recipientConversationId: audience.id, recipientContactId: contactId }
          : { purpose: 'PUBLIC_REFERENCE', audience: audience.id }),
        validFrom: new Date('2000-01-01T00:00:00Z'),
        validUntil: new Date('2999-01-01T00:00:00Z'), approvedBy: 'fixture', reason: 'Review fixture',
      },
    })
    const result = await ingestSimulatedEvent(runtime, {
      accountId, conversationId: audience.id, contactId, sourceKey: randomUUID(), kind: 'REPLY',
      occurredAt: new Date(), messageText: proposalText,
    })
    assert.equal(result.status, 'ACCEPTED')
    const runJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, runJob.eventId)
    const draftJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, draftJob.eventId, simulationPlatforms.resolveAdapter, model)
    const action = await owner.actionProposal.findUniqueOrThrow({ where: { runId: result.runId } })
    return { action, grant, proposalText }
  } finally {
    await runtime.$disconnect()
  }
}

function actionPath(id: string) { return characterPath(a) + '/actions/' + id }

test('only a reviewer can see the draft and concurrent approval has one effect', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE' } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: accountA }, data: { status: 'ACTIVE' } })
  const role = await request('POST', characterPath(a) + '/memberships', {
    key: 'enable-review', data: { subject: 'reviewer', role: 'REVIEWER', action: 'GRANT', reason: 'Review fixture' },
  })
  assert.equal(role.status, 200)
  const { action, proposalText } = await proposeReview()
  const path = actionPath(action.id)
  assert.equal((await request('GET', path)).status, 403)
  const queue = await request('GET', characterPath(a) + '/actions', { actor: 'reviewer' })
  assert.equal(queue.body.items[0].content, null)
  const preview = await request('GET', path, { actor: 'reviewer' })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.target.accountId, accountA)
  assert.equal(preview.body.content, '供您参考：' + proposalText + '\n\nAI 披露：AI role, version two')
  const ifMatch = preview.headers.get('etag') ?? ''
  const data = { reviewDigest: action.reviewDigest, decision: 'APPROVE', reason: 'Check target and content' }
  const submit = (key: string, body = data, version = ifMatch) =>
    request('POST', path + '/decisions', { actor: 'reviewer', key, ifMatch: version, data: body })

  assert.equal((await submit('missing-if-match', data, '')).status, 428)
  assert.equal((await submit('invalid-digest', { ...data, reviewDigest: '0'.repeat(64) })).status, 409)
  const proposerId = createHash('sha256').update(JSON.stringify([issuer, 'reviewer'])).digest('hex')
  await owner.actionProposal.update({ where: { id: action.id }, data: { proposerId } })
  assert.equal((await submit('own-action')).status, 403)
  await owner.actionProposal.update({ where: { id: action.id }, data: { proposerId: null } })

  const results = await Promise.all(['review-1', 'review-2'].map(async (key) => ({ key, result: await submit(key) })))
  assert.deepEqual(results.map(({ result }) => result.status).sort(), [200, 412])
  const success = results.find(({ result }) => result.status === 200)!
  assert.equal(success.result.body.status, 'READY')
  assert.equal((await submit(success.key)).status, 200)
  assert.equal(await owner.actionApproval.count({ where: { actionId: action.id } }), 1)
  assert.equal(await owner.managementAudit.count({ where: { targetId: action.id, operation: 'action.review' } }), 1)

  await owner.character.update({ where: { id: a }, data: { authEpoch: { increment: 1 } } })
  const invalidated = await request('GET', path, { actor: 'reviewer' })
  assert.equal(invalidated.body.state, 'CANCELED')
  assert.equal(invalidated.body.content, null)
  assert.equal(await owner.managementAudit.count({ where: { targetId: action.id, operation: 'action.invalidate' } }), 1)
})

test('review rechecks evidence expiry and adapter version, and records a valid rejection', async () => {
  for (const scenario of ['grant-expiry', 'adapter-change', 'proposal-expiry', 'payload-change', 'reject'] as const) {
    const { action, grant } = await proposeReview()
    const now = await databaseNow()
    if (scenario === 'grant-expiry') {
      await owner.memoryGrant.update({
        where: { id: grant.id }, data: { validFrom: new Date(now - 60_000), validUntil: new Date(now - 1000) },
      })
    } else if (scenario === 'adapter-change') {
      await owner.actionProposal.update({ where: { id: action.id }, data: { adapterVersion: '0.0.1' } })
    } else if (scenario === 'payload-change') {
      await owner.simulatedDraft.update({
        where: { characterId_runId: { characterId: a, runId: action.runId } },
        data: { content: 'Changed draft content' },
      })
    } else if (scenario === 'proposal-expiry') {
      await owner.actionProposal.update({
        where: { id: action.id },
        data: { createdAt: new Date(now - 60_000), expiresAt: new Date(now - 1000) },
      })
    }
    const path = actionPath(action.id)
    const preview = await request('GET', path, { actor: 'reviewer' })
    const rejected = scenario === 'reject'
    const expected = rejected ? 'WAITING_APPROVAL' : scenario === 'proposal-expiry' ? 'EXPIRED' : 'CANCELED'
    const queue = await request('GET', characterPath(a) + '/actions', { actor: 'reviewer' })
    assert.equal(queue.status, 200)
    const listed = queue.body.items.find(({ id }: { id: string }) => id === action.id)
    assert.equal(listed.state, expected)
    assert.equal(listed.content, null)
    assert.equal(preview.body.state, expected)
    assert.equal(Boolean(preview.body.content), rejected)
    const result = await request('POST', path + '/decisions', {
      actor: 'reviewer', key: scenario, ifMatch: preview.headers.get('etag') ?? '',
      data: { reviewDigest: action.reviewDigest, decision: 'REJECT', reason: 'Review fixture' },
    })
    assert.equal(result.status, rejected ? 200 : 409)
    if (rejected) assert.equal(result.body.status, 'REJECTED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state,
      rejected ? 'REJECTED' : expected)
    assert.equal(await owner.managementAudit.count({ where: { targetId: action.id, operation: 'action.review' } }), 1)
    assert.equal(await owner.actionApproval.count({ where: { actionId: action.id } }), rejected ? 1 : 0)
  }
})


function simulationConnectionString() {
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_simulation_executor')
  return url.toString()
}

function simulationDatabase() {
  return createDatabase(simulationConnectionString())
}

async function approveSimulation(accountId = accountA, contactId?: string, identityId = identityA) {
  const proposal = await proposeReview(accountId, contactId, simulatedModelPlugin, identityId)
  const response = await request('POST', actionPath(proposal.action.id) + '/decisions', {
    actor: 'reviewer', key: 'approve-' + proposal.action.id, ifMatch: '"run-v3"',
    data: { reviewDigest: proposal.action.reviewDigest, decision: 'APPROVE', reason: 'Approved simulation fixture' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return proposal
}

async function newSimulationAccount(identityId = identityA) {
  const account = await owner.platformAccount.create({
    data: {
      characterId: a, identityId, status: 'ACTIVE',
      platform: 'mock-a', instanceKey: 'integration', remoteAccountId: randomUUID(),
    },
  })
  return account.id
}

function simulationZone(hour: number) {
  const shift = (hour - new Date().getUTCHours() + 35) % 24 - 11
  return shift === 0 ? 'UTC' : 'Etc/GMT' + (shift > 0 ? '-' : '+') + Math.abs(shift)
}

test('simulation approval and permit bind adapter ID, implementation and contract version', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: accountA }, data: { status: 'ACTIVE' } })
  const { action: pending } = await proposeReview()
  const scope = { characterId: a, actor: { issuer, subject: 'reviewer', id: actorId(issuer, 'reviewer') } }
  const current = simulationPlatforms.resolveAdapter('mock-a')!
  const replacements = [
    { ...current, adapterId: 'replacement-adapter' },
    { ...current, adapterVersion: '2.0.0' },
    { ...current, adapterContractVersion: 2 },
  ]
  const executor = simulationDatabase()
  try {
    const { items: [active] } = await listReviewActions(management, scope, simulationPlatforms.resolveAdapter, pending.id)
    assert.equal(active.state, 'WAITING_APPROVAL')
    assert.ok(active.content)
    for (const changed of replacements) {
      const resolveChanged = () => changed
      const { items: [preview] } = await listReviewActions(management, scope, resolveChanged, pending.id)
      assert.equal(preview.state, 'CANCELED')
      assert.equal(preview.content, null)
      const { action } = await approveSimulation(await newSimulationAccount())

      // A permit must include the digest from the approval.
      await assert.rejects(executor.$executeRaw`
        INSERT INTO public.simulation_attempts(character_id,action_id,account_id,window_start,permit_until)
        VALUES (${a}::uuid,${action.id}::uuid,${reviewTarget.parse(action.target).accountId}::uuid,
          statement_timestamp(),statement_timestamp()+interval '10 seconds')
      `, /adapter-bound approval/)
      await executeSimulation(executor, action.id, resolveChanged, async () => assert.fail('Replacement adapter reached execution'))
      assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state, 'BLOCKED')
      assert.equal(await owner.simulationAttempt.count({ where: { actionId: action.id } }), 0)
    }
    const rejected = await management.$transaction((tx) => decideReviewAction(tx, scope, pending.id, active.version,
      { decision: 'APPROVE', reviewDigest: pending.reviewDigest, reason: 'Check replaced contract' }, () => replacements[2]))
    assert.equal(rejected.status, 'CANCELED')
    assert.equal(await owner.actionApproval.count({ where: { actionId: pending.id } }), 0)
  } finally {
    await executor.$disconnect()
  }
})

test('disabled platform prevents drafting, review preview and execution permission', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: accountA }, data: { status: 'ACTIVE' } })
  const enabled = await approveSimulation()
  const disabled = await startSimulationPlatforms({ RICA_SIMULATED_PLATFORMS: 'mock-b' })
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const scope = { characterId: a, actor: { issuer, subject: 'reviewer', id: actorId(issuer, 'reviewer') } }
    const { items: [preview] } = await listReviewActions(management, scope, disabled.resolveAdapter, enabled.action.id)
    assert.equal(preview.state, 'CANCELED')
    assert.equal(preview.content, null)

    await executeSimulation(executor, enabled.action.id, disabled.resolveAdapter, async () => assert.fail('Disabled platform reached the adapter'))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: enabled.action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: enabled.action.id } }), 0)

    const { conversationId } = reviewTarget.parse(enabled.action.target)
    const incoming = await ingestSimulatedEvent(runtime, {
      accountId: accountA, conversationId, sourceKey: randomUUID(), kind: 'REPLY',
      occurredAt: new Date(), messageText: 'Disabled platform draft fixture',
    })
    assert.equal(incoming.status, 'ACCEPTED')
    const job = await owner.outboxEvent.findFirstOrThrow({ where: { runId: incoming.runId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, job.eventId)
    const draft = await owner.outboxEvent.findFirstOrThrow({ where: { runId: incoming.runId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, draft.eventId, disabled.resolveAdapter, {
      ...simulatedModelPlugin,
      implementation: {
        async decide() { assert.fail('Disabled platform called the model') },
        async write() { assert.fail('Disabled platform called the model') },
      },
    })
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: incoming.runId } })).state, 'CANCELED')
    assert.equal(await owner.actionProposal.count({ where: { runId: incoming.runId } }), 0)
  } finally {
    await Promise.all([disabled.stop(), runtime.$disconnect(), executor.$disconnect()])
  }
})

test('receipt rechecks an ordinary writing grant after execution is permitted', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  const { action, grant } = await approveSimulation(await newSimulationAccount())
  const executor = simulationDatabase()
  try {
    let permitted = false
    await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      permitted = true
      const now = await databaseNow()
      await owner.memoryGrant.update({
        where: { id: grant.id }, data: { validFrom: new Date(now - 60_000), validUntil: new Date(now - 1000) },
      })
      return recordSimulationReceipt(db, id)
    })
    assert.equal(permitted, true)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: action.id } })).status, 'NOT_SENT')
  } finally {
    await executor.$disconnect()
  }
})

test('simulation defers quiet hours and rejects stale evidence or a paused binding', async () => {
  const executor = simulationDatabase()
  try {
    const quiet = await approveSimulation()
    await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(1) } })
    assert.equal(await reserveSimulation(executor, quiet.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: quiet.action.runId } })).state, 'READY')
    await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })

    const stale = await approveSimulation()
    const now = await databaseNow()
    await owner.memoryGrant.update({
      where: { id: stale.grant.id }, data: { validFrom: new Date(now - 60_000), validUntil: new Date(now - 1000) },
    })
    assert.equal(await reserveSimulation(executor, stale.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: stale.action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: stale.action.id } }), 0)

    const revoked = await approveSimulation(await newSimulationAccount())
    const revokedGrant = await request('POST', characterPath(a) + '/memory-grants/' + revoked.grant.id + '/revoke', {
      key: 'revoke-before-permit', data: { reason: 'Withdraw evidence after approval' },
    })
    assert.equal(revokedGrant.status, 200)
    await executeSimulation(executor, revoked.action.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Revoked proposal reached the adapter'))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: revoked.action.runId } })).state, 'CANCELED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: revoked.action.id } }), 0)

    // A matching payload hash is insufficient if the approved content omits the authoritative disclosure.
    const undisclosed = await approveSimulation(await newSimulationAccount())
    const content = 'Previously approved content without disclosure'
    await owner.simulatedDraft.update({
      where: { characterId_runId: { characterId: a, runId: undisclosed.action.runId } }, data: { content },
    })
    await owner.actionProposal.update({
      where: { id: undisclosed.action.id }, data: { payloadHash: createHash('sha256').update(content).digest('hex') },
    })
    assert.equal(await reserveSimulation(executor, undisclosed.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: undisclosed.action.id } }), 0)

    const paused = await approveSimulation(await newSimulationAccount())
    await executeSimulation(executor, paused.action.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      await owner.character.update({ where: { id: a }, data: { status: 'PAUSED', authEpoch: { increment: 1 } } })
      return recordSimulationReceipt(db, id)
    })
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: paused.action.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: paused.action.id } })).status, 'NOT_SENT')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: paused.action.runId } })).state, 'BLOCKED')
    assert.equal(await reserveSimulation(executor, quiet.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: quiet.action.id } }), 0)
  } finally {
    await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE' } })
    await executor.$disconnect()
  }
})

test('duplicate delivery uses one local receipt and the daily reservation cannot exceed five', async () => {
  const executor = simulationDatabase()
  try {
    const proposals = []
    for (let i = 0; i < 6; i++) proposals.push((await approveSimulation()).action)
    const first = proposals[0]
    await recordSimulationReceipt(executor, first.id)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: first.id } }), 0)

    let calls = 0
    await Promise.all(Array.from({ length: 6 }, () => executeSimulation(executor, first.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      calls++
      return recordSimulationReceipt(db, id)
    })))
    assert.equal(calls, 1)
    for (let round = 0; round < 5; round++) {
      await Promise.all(proposals.slice(1).map(({ id }) => executeSimulation(executor, id, simulationPlatforms.resolveAdapter)))
    }

    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: proposals.map(({ id }) => id) } } }), 5)
    assert.equal(await owner.simulationAttempt.count({ where: { accountId: accountA } }), 5)
    assert.equal(await owner.agentRun.count({
      where: { id: { in: proposals.map(({ runId }) => runId) }, state: 'READY' },
    }), 1)
    await assert.rejects(executor.simulatedDraft.findMany({ select: { content: true } }), /permission denied/i)
  } finally {
    await executor.$disconnect()
  }
})

test('simulation rate limits the same contact across conversations for a rolling hour', async () => {
  const executor = simulationDatabase()
  try {
    const accountId = await newSimulationAccount()
    async function contact() {
      return (await owner.contact.create({
        data: { characterId: a, identityId: identityA, accountId, remoteKey: randomUUID() },
      })).id
    }
    const firstContact = await contact()
    const first = (await approveSimulation(accountId, firstContact)).action
    const second = (await approveSimulation(accountId, firstContact)).action
    const other = (await approveSimulation(accountId, await contact())).action
    await executeSimulation(executor, first.id, simulationPlatforms.resolveAdapter)
    await executeSimulation(executor, second.id, simulationPlatforms.resolveAdapter)
    await executeSimulation(executor, other.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: [first.id, other.id] } } }), 2)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: second.id } }), 0)

    await owner.simulationReceipt.update({
      where: { actionId: first.id }, data: { createdAt: new Date((await databaseNow()) - 3_601_000) },
    })
    await executeSimulation(executor, second.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: second.id } }), 1)
  } finally {
    await executor.$disconnect()
  }
})

async function crashSimulationProcess(actionId: string, checkpoint: 'permit' | 'receipt') {
  const program = `
    import { createDatabase } from './packages/persistence/client.ts'
    import { reserveSimulation, recordSimulationReceipt } from './packages/persistence/simulation-execution.ts'
    import { startSimulationPlatforms } from './apps/runtime-plugins.ts'
    const simulationPlatforms = await startSimulationPlatforms({})
    const [id, phase] = process.argv.slice(1)
    const db = createDatabase(process.env.RICA_TEST_SIMULATION_URL)
    if (!await reserveSimulation(db, id, simulationPlatforms.resolveAdapter)) throw new Error('Permit was not issued')
    if (phase === 'receipt' && !await recordSimulationReceipt(db, id)) throw new Error('Receipt was not written')
    process.send(phase)
    process.on('message', () => {})
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, actionId, checkpoint], {
    env: { ...process.env, RICA_TEST_SIMULATION_URL: simulationConnectionString() },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  })
  const closed = once(child, 'close')
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(10_000) }),
      closed.then(() => { throw new Error('Simulation process exited before the checkpoint') }),
    ])
    assert.equal(message, checkpoint)
  } finally {
    child.kill('SIGKILL')
    await closed
  }
}

test('restart and adapter replacement reconcile in-flight attempts without replaying them', async () => {
  const executor = simulationDatabase()
  try {
    const unknownAccount = await newSimulationAccount()
    const lost = (await approveSimulation(unknownAccount)).action
    const waiting = (await approveSimulation(unknownAccount)).action
    const recorded = (await approveSimulation(await newSimulationAccount())).action
    const notSent = (await approveSimulation(await newSimulationAccount())).action
    await crashSimulationProcess(lost.id, 'permit')
    await crashSimulationProcess(recorded.id, 'receipt')

    // The persisted proposals belong to the old adapter after a process replacement.
    await owner.actionProposal.updateMany({
      where: { id: { in: [lost.id, recorded.id, notSent.id] } }, data: { adapterVersion: '0.0.1' },
    })
    await executeSimulation(executor, notSent.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Old approval reached the replacement adapter'))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: notSent.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: notSent.id } }), 0)

    const expired = new Date((await databaseNow()) - 1000)
    await owner.simulationAttempt.updateMany({
      where: { actionId: { in: [lost.id, recorded.id] } }, data: { permitUntil: expired },
    })
    await runSimulationBatch(executor, null, simulationPlatforms.resolveAdapter)
    await runSimulationBatch(executor, null, simulationPlatforms.resolveAdapter)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: lost.runId } })).state, 'RECONCILING')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: recorded.runId } })).state, 'SIMULATED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: waiting.runId } })).state, 'READY')
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: [lost.id, waiting.id] } } }), 0)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: recorded.id } }), 1)

    const replayPath = characterPath(a) + '/runs/' + lost.runId + '/replay'
    const unknown = await request('GET', replayPath)
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body))
    assert.equal(unknown.body.proposal.attemptStatus, 'UNKNOWN')
    assert.ok(unknown.body.proposal.permittedAt)
    assert.equal(unknown.body.proposal.receiptAt, null)

    const path = actionPath(lost.id) + '/reconciliation'
    assert.equal((await request('GET', path, { actor: 'reviewer' })).status, 403)
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    const pending = await request('GET', path)
    assert.equal(pending.body.evidenceRef, null)
    assert.equal((await request('POST', path, {
      key: 'resolve-prematurely', ifMatch: pending.headers.get('etag') ?? '',
      data: { outcome: 'DEFINITELY_NOT_SENT', evidenceRef: '0'.repeat(64), reason: 'Too early' },
    })).status, 409)

    await owner.simulationAttempt.update({
      where: { actionId: lost.id }, data: { permitUntil: new Date((await databaseNow()) - 16 * 60_000) },
    })
    const review = await request('GET', path)
    assert.equal(review.status, 200)
    assert.equal(review.body.outcome, 'DEFINITELY_NOT_SENT')
    const ifMatch = review.headers.get('etag') ?? ''
    const decision = {
      outcome: review.body.outcome, evidenceRef: review.body.evidenceRef, reason: 'Checked sealed local ledger',
    }
    assert.equal((await request('POST', path, {
      key: 'forged-evidence', ifMatch, data: { ...decision, outcome: 'CONFIRMED' },
    })).status, 409)
    const resolved = await request('POST', path, { key: 'correct-resolution', ifMatch, data: decision })
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body))
    assert.equal(resolved.body.status, 'BLOCKED')
    assert.equal((await request('POST', path, { key: 'correct-resolution', ifMatch, data: decision })).status, 200)
    assert.equal(await owner.managementAudit.count({ where: { targetId: lost.id, operation: 'simulation.resolve' } }), 1)
    const attempt = await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: lost.id } })
    assert.equal(attempt.status, 'NOT_SENT')
    assert.equal(attempt.resolutionEvidence, decision.evidenceRef)
    assert.equal(attempt.resolutionReason, decision.reason)
    const closed = await request('GET', replayPath)
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.equal(closed.body.proposal.attemptStatus, 'NOT_SENT')
    assert.equal(closed.body.proposal.permittedAt, unknown.body.proposal.permittedAt)
    assert.equal(closed.body.proposal.receiptAt, null)
    assert.equal(JSON.stringify(closed.body).includes(decision.reason), false)
    await assert.rejects(executor.simulationAttempt.findMany({ select: { resolutionReason: true } }), /permission denied/i)

    await runSimulationBatch(executor, null, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: waiting.id } }), 1)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: lost.id } }), 0)
  } finally {
    await executor.$disconnect()
  }
})


function scheduleRuntimeUrl() {
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_runtime')
  return url.toString()
}

async function scheduleConversation() {
  return owner.conversation.create({
    data: {
      characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID(), channel: 'PUBLIC',
    },
  })
}

test('daily schedule slots skip spring gaps and choose the earlier fall overlap', async () => {
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const zone = 'America/New_York'
    const gap = await dailyScheduleSlot(runtime, zone, '02:30', new Date('2026-03-08T06:00:00Z'))
    assert.equal(gap.toISOString(), '2026-03-09T06:30:00.000Z')
    const fold = await dailyScheduleSlot(runtime, zone, '01:30', new Date('2026-11-01T04:00:00Z'))
    assert.equal(fold.toISOString(), '2026-11-01T05:30:00.000Z')
    const afterFirst = await dailyScheduleSlot(runtime, zone, '01:30', new Date('2026-11-01T05:45:00Z'))
    assert.equal(afterFirst.toISOString(), '2026-11-02T06:30:00.000Z')
  } finally {
    await runtime.$disconnect()
  }
})

test('parallel schedule scans catch up only the latest eligible slot and edits cancel the old run', async () => {
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    await owner.character.update({ where: { id: a }, data: { timezone: 'UTC' } })
    const conversation = await scheduleConversation()
    const path = characterPath(a) + '/schedules'
    const plan = {
      scheduleKey: 'daily-fixture', accountId: accountA, conversationId: conversation.id, enabled: true,
      zone: 'UTC', rule: { kind: 'DAILY', localTime: '09:00' },
    }
    assert.equal((await request('POST', path, { actor: 'reviewer', key: 'forbidden-schedule', data: plan })).status, 403)
    const created = await request('POST', path, { key: 'daily-fixture', data: plan })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const stale = await request('POST', path, {
      key: 'late-fixture', data: { ...plan, scheduleKey: 'late-fixture', rule: { kind: 'DAILY', localTime: '08:00' } },
    })
    assert.equal(stale.status, 201, JSON.stringify(stale.body))
    assert.deepEqual((await request('GET', path)).body.items.map(({ scheduleKey }: { scheduleKey: string }) => scheduleKey),
      ['daily-fixture', 'late-fixture'])
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    const scheduleId = created.body.id
    await owner.simulationSchedule.updateMany({
      where: { id: { in: [scheduleId, stale.body.id] } }, data: { nextAt: new Date('2026-03-10T08:00:00Z') },
    })
    const now = new Date('2026-03-12T10:30:00Z')
    await Promise.all(Array.from({ length: 6 }, () => scanSimulationSchedules(runtime, null, now)))
    await scanSimulationSchedules(runtime, null, new Date('2026-03-11T10:30:00Z'))
    const occurrences = await owner.scheduleOccurrence.findMany({ where: { scheduleId } })
    assert.equal(occurrences.length, 1)
    assert.equal(occurrences[0].scheduledAt.toISOString(), '2026-03-12T09:00:00.000Z')
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: stale.body.id } }), 0)
    const runId = occurrences[0].runId
    assert.equal(await owner.outboxEvent.count({ where: { runId, type: runQueuedEvent } }), 1)
    assert.equal(await owner.managementAudit.count({ where: { targetId: runId, operation: 'schedule.fire' } }), 1)
    await assert.rejects(ingestSimulatedEvent(runtime, {
      accountId: accountA, sourceKey: 'schedule:forged', kind: 'POST', occurredAt: now,
    }), /Invalid simulated event/)

    const disabled = await request('PUT', path + '/' + scheduleId, {
      ifMatch: '"1"', data: { zone: plan.zone, rule: plan.rule, enabled: false },
    })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.body.version, 2)
    const run = await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })
    assert.equal(run.state, 'CANCELED')
    assert.equal(run.stateReason, 'SCHEDULE_CHANGED')
    assert.equal(await owner.managementAudit.count({ where: { targetId: runId, operation: 'schedule.invalidate' } }), 1)
    assert.equal((await request('PUT', path + '/' + scheduleId, {
      ifMatch: '"1"', data: { zone: plan.zone, rule: plan.rule, enabled: true },
    })).status, 412)
    await owner.simulationSchedule.update({ where: { id: stale.body.id }, data: { enabled: false, nextAt: null } })
  } finally {
    await runtime.$disconnect()
  }
})

test('an overdue reminder survives quiet hours and reaches the normal Worker once', async () => {
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const conversation = await scheduleConversation()
    const dueAt = '2025-12-30T05:30:00.000Z'
    const created = await request('POST', characterPath(a) + '/schedules', {
      key: 'commitment-fixture',
      data: {
        scheduleKey: 'commitment-fixture', accountId: accountA, conversationId: conversation.id,
        zone: 'UTC', enabled: true, rule: { kind: 'REMINDER', dueAt },
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const id = created.body.id
    await scanSimulationSchedules(runtime, null, new Date('2026-01-02T03:00:00Z'))
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: id } }), 0)
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id } })).nextAt?.toISOString(),
      '2026-01-02T08:00:00.000Z')
    for (let i = 0; i < 2; i++) await scanSimulationSchedules(runtime, null, new Date('2026-01-02T08:00:00Z'))
    const occurrences = await owner.scheduleOccurrence.findMany({ where: { scheduleId: id } })
    assert.equal(occurrences.length, 1)
    assert.equal(occurrences[0].scheduledAt.toISOString(), dueAt)
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id } })).nextAt, null)
    const worker = await startOutboxWorker(scheduleRuntimeUrl(), config.redisUrl, simulatedModelPlugin, simulationPlatforms.resolveAdapter)
    try {
      const runId = occurrences[0].runId
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if ((await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })).state === 'CONTEXT_READY') break
        await sleep(50)
      }
      assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })).state, 'CONTEXT_READY')
      assert.equal(await owner.outboxEvent.count({ where: { runId, type: runQueuedEvent, processedAt: { not: null } } }), 1)

      await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
      const live = await request('POST', characterPath(a) + '/schedules', {
        key: 'worker-scanned-reminder',
        data: {
          scheduleKey: 'worker-scanned-reminder', accountId: accountA, conversationId: conversation.id,
          zone: 'UTC', enabled: true, rule: { kind: 'REMINDER', dueAt: new Date(Math.min(await databaseNow(), Date.now()) - 10_000).toISOString() },
        },
      })
      assert.equal(live.status, 201)
      let state: string | undefined
      const scanDeadline = Date.now() + 10_000
      while (Date.now() < scanDeadline) {
        const occurrence = await owner.scheduleOccurrence.findFirst({
          where: { scheduleId: live.body.id }, select: { run: { select: { state: true } } },
        })
        state = occurrence?.run.state
        if (state === 'CONTEXT_READY') break
        await sleep(50)
      }
      assert.equal(state, 'CONTEXT_READY')
      assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: live.body.id } }), 1)
    } finally {
      await worker.close()
    }
  } finally {
    await runtime.$disconnect()
  }
})


async function commitmentFixture(privateRecipient = false) {
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const accountId = await newSimulationAccount()
  const contact = privateRecipient ? await owner.contact.create({
    data: { characterId: a, identityId: identityA, accountId, remoteKey: randomUUID() },
  }) : null
  const { action } = await approveSimulation(accountId, contact?.id)
  const due = new Date()
  due.setUTCHours(3, 0, 0, 0)
  due.setUTCDate(due.getUTCDate() + 1)
  return { accountId, contactId: contact?.id, action, due }
}

async function confirmCommitmentReceipt(actionId: string) {
  const executor = simulationDatabase()
  try {
    await executeSimulation(executor, actionId, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId } }), 1)
  } finally {
    await executor.$disconnect()
  }
}

test('commitments require a confirmed receipt and preserve its recipient across filters', async () => {
  const { accountId, contactId, action, due } = await commitmentFixture(true)
  const path = characterPath(a) + '/commitments'
  const data = { actionId: action.id, title: 'Follow up with the recipient', dueAt: due.toISOString(), reason: 'Confirmed agreement' }

  assert.equal((await request('POST', path, { key: 'unconfirmed-commitment', data })).status, 404)
  await confirmCommitmentReceipt(action.id)
  assert.equal((await request('POST', path, { actor: 'reviewer', key: 'reviewer-commitment', data })).status, 403)
  assert.equal((await request('POST', characterPath(b) + '/commitments', {
    actor: 'admin-b', key: 'foreign-commitment', data,
  })).status, 404)
  assert.equal((await request('POST', path, { key: 'forged-scope', data: { ...data, accountId: accountA } })).status, 422)

  const result = await request('POST', path, { key: 'confirmed-commitment', data })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  assert.equal((await request('POST', path, { key: 'confirmed-commitment', data })).body.id, result.body.id)
  assert.equal((await request('POST', path, { key: 'duplicate-receipt', data })).status, 409)
  const list = await request('GET', path + '?accountId=' + accountId + '&contactId=' + contactId)
  assert.equal(list.status, 200)
  assert.equal(list.body.items.length, 1)
  const [commitment] = list.body.items
  assert.equal(commitment.actionId, action.id)
  assert.equal(commitment.contactId, contactId)
  assert.deepEqual((await request('GET', path + '?accountId=' + accountA)).body.items, [])

  const schedulePath = characterPath(a) + '/schedules/' + commitment.scheduleId
  assert.equal((await request('PUT', schedulePath, {
    ifMatch: '"1"', data: { zone: 'UTC', enabled: false, rule: { kind: 'REMINDER', dueAt: data.dueAt } },
  })).status, 409)
  const fulfilled = await request('PUT', path + '/' + result.body.id, {
    ifMatch: '"1"', data: { operation: 'FULFILL', reason: 'Agreement completed' },
  })
  assert.equal(fulfilled.body.status, 'FULFILLED')
  assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id: commitment.scheduleId } })).nextAt, null)
  assert.equal(await owner.simulationSchedule.count({
    where: { scheduleKey: 'commitment:' + result.body.id },
  }), 1)
})

test('a commitment reminder catches up once, and defer or cancel invalidates its pending runs', async () => {
  const { action, due } = await commitmentFixture()
  await confirmCommitmentReceipt(action.id)
  await owner.character.update({ where: { id: a }, data: { timezone: 'UTC' } })
  const path = characterPath(a) + '/commitments'
  const result = await request('POST', path, {
    key: 'commitment-catchup',
    data: { actionId: action.id, title: 'Deadline reminder', dueAt: due.toISOString(), reason: 'Follow-up agreement' },
  })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  const id = result.body.id
  const { scheduleId } = await owner.simulationCommitment.findUniqueOrThrow({ where: { id } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const overnight = new Date(due.getTime() + 86_400_000)
    const morning = new Date(overnight.getTime() + 5 * 3_600_000)
    await scanSimulationSchedules(runtime, null, overnight)
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId } }), 0)
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).nextAt?.toISOString(),
      morning.toISOString())
    await Promise.all([scanSimulationSchedules(runtime, null, morning), scanSimulationSchedules(runtime, null, morning)])
    const [first] = await owner.scheduleOccurrence.findMany({ where: { scheduleId } })
    assert.equal(first.scheduledAt.toISOString(), due.toISOString())
    assert.equal(await owner.outboxEvent.count({ where: { runId: first.runId, type: runQueuedEvent } }), 1)
    const replay = await request('GET', characterPath(a) + '/runs/' + first.runId + '/replay')
    assert.equal(replay.status, 200)
    assert.equal(replay.body.schedule.commitmentId, id)
    assert.equal(new Date(replay.body.schedule.scheduledAt).toISOString(), due.toISOString())

    const newDue = new Date(morning.getTime() + 86_400_000 + 3_600_000)
    const deferred = await request('PUT', path + '/' + id, {
      ifMatch: '"1"', data: { operation: 'DEFER', dueAt: newDue.toISOString(), reason: 'Recipient requested more time' },
    })
    assert.equal(deferred.status, 200, JSON.stringify(deferred.body))
    assert.equal(deferred.body.status, 'DEFERRED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: first.runId } })).stateReason, 'SCHEDULE_CHANGED')
    await scanSimulationSchedules(runtime, null, newDue)
    const occurrences = await owner.scheduleOccurrence.findMany({ where: { scheduleId }, orderBy: { scheduledAt: 'asc' } })
    assert.equal(occurrences.length, 2)
    assert.equal(occurrences[1].scheduleVersion, 2)

    const canceled = await request('PUT', path + '/' + id, {
      ifMatch: '"2"', data: { operation: 'CANCEL', reason: 'Recipient canceled' },
    })
    assert.equal(canceled.body.status, 'CANCELED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: occurrences[1].runId } })).state, 'CANCELED')
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).nextAt, null)
    assert.deepEqual((await owner.commitmentRevision.findMany({
      where: { commitmentId: id }, orderBy: { version: 'asc' },
    })).map(({ state, reason }) => [state, reason]), [
      ['OPEN', 'Follow-up agreement'], ['DEFERRED', 'Recipient requested more time'], ['CANCELED', 'Recipient canceled'],
    ])
  } finally {
    await runtime.$disconnect()
  }
})


test('run replay masks expired and revoked evidence and keeps the original trace scoped', async () => {
  const { action, grant, proposalText } = await proposeReview(await newSimulationAccount())
  const root = characterPath(a)
  const path = root + '/runs/' + action.runId + '/replay'
  const membership = await request('POST', root + '/memberships', {
    key: 'observability-auditor', data: { subject: 'auditor', role: 'AUDITOR', action: 'GRANT', reason: 'Audit fixture' },
  })
  assert.equal(membership.status, 200)
  assert.equal((await request('GET', path, { actor: null })).status, 401)
  assert.equal((await request('GET', path, { actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('GET', characterPath(b) + '/runs/' + action.runId + '/replay', { actor: 'admin-b' })).status, 404)

  const replay = await request('GET', path, { actor: 'auditor' })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(replay.body.proposal.id, action.id)
  assert.equal(replay.body.state, 'WAITING_APPROVAL')
  assert.equal(replay.body.mode, 'SIMULATION')
  const evidence = (response: typeof replay) => response.body.snapshots.find(
    ({ purpose }: { purpose: string }) => purpose === 'PUBLIC_REFERENCE',
  ).evidence
  assert.deepEqual(evidence(replay), [{ rank: 1, available: true, memoryId: grant.memoryId, revision: 1 }])
  assert.equal(JSON.stringify(replay.body).includes(proposalText), false)

  await owner.memoryGrant.update({
    where: { id: grant.id },
    data: { validFrom: new Date((await databaseNow()) - 120_000), validUntil: new Date((await databaseNow()) - 1000) },
  })
  const expired = await request('GET', path, { actor: 'auditor' })
  assert.deepEqual(evidence(expired), [{ rank: 1, available: false }])
  assert.equal(expired.body.stateVersion, replay.body.stateVersion)
  assert.equal(expired.body.proposal.id, action.id)

  const revoked = await request('POST', root + '/memory-grants/' + grant.id + '/revoke', {
    key: 'replay-revocation', data: { reason: 'Remove replay access' },
  })
  assert.equal(revoked.status, 200)
  const after = await request('GET', path)
  assert.deepEqual(evidence(after), [{ rank: 1, available: false }])
  assert.equal(after.body.state, 'CANCELED')
  assert.equal(JSON.stringify(after.body).includes(grant.memoryId), false)
})

test('monitoring reports only the current character’s backlog without triggering work', async () => {
  const path = characterPath(a) + '/monitoring'
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const before = await request('GET', path, { actor: 'auditor' })
  assert.equal(before.status, 200, JSON.stringify(before.body))
  assert.equal((await request('GET', path, { actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
  const otherBefore = await request('GET', characterPath(b) + '/monitoring', { actor: 'admin-b' })
  assert.equal(otherBefore.status, 200)

  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const { action } = await approveSimulation(await newSimulationAccount())
    await assert.rejects(executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter, async () => {
      throw new Error('Outcome unknown')
    }), /Outcome unknown/)
    await proposeReview(await newSimulationAccount())
    const run = await ingestSimulatedEvent(runtime, {
      accountId: accountA, sourceKey: randomUUID(), kind: 'MENTION', occurredAt: new Date(),
    })
    assert.equal(run.status, 'ACCEPTED')
    await owner.outboxEvent.updateMany({ where: { runId: run.runId }, data: { enqueuedAt: new Date() } })
    const conversation = await scheduleConversation()
    const created = await request('POST', characterPath(a) + '/schedules', {
      key: 'monitoring-schedule',
      data: {
        scheduleKey: 'monitoring-schedule', accountId: accountA, conversationId: conversation.id,
        zone: 'UTC', enabled: true, rule: { kind: 'REMINDER', dueAt: new Date((await databaseNow()) - 1000).toISOString() },
      },
    })
    assert.equal(created.status, 201)

    const after = await request('GET', path, { actor: 'auditor' })
    assert.equal(after.status, 200, JSON.stringify(after.body))
    for (const category of ['outbox', 'approvals', 'reconciliation', 'schedules']) {
      assert.equal(after.body[category].count, before.body[category].count + 1, category)
      assert.ok(after.body[category].oldestAt)
    }
    assert.equal(after.body.outbox.enqueued, before.body.outbox.enqueued + 1)
    const otherAfter = await request('GET', characterPath(b) + '/monitoring', { actor: 'admin-b' })
    const counts = ({ observedAt: _, ...rest }: Record<string, unknown>) => rest
    assert.deepEqual(counts(otherAfter.body), counts(otherBefore.body))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: run.runId } })).state, 'QUEUED')
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: created.body.id } }), 0)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('grant and account management enforce bound references and revoke access with an epoch change', async () => {
  const path = characterPath(a)
  const memory = await owner.memory.create({
    data: { characterId: a, identityId: identityA, scope: 'IDENTITY', visibility: 'PUBLIC', content: 'Private persistence fixture' },
  })
  const audience = await owner.conversation.create({
    data: { characterId: a, identityId: identityA, accountId: accountA, remoteKey: prefix, channel: 'PUBLIC' },
  })
  const now = await databaseNow()
  const data = {
    memoryId: memory.id, recipientIdentityId: identityA, recipientAccountId: accountA,
    purpose: 'PUBLIC_REFERENCE', audience: audience.id, reason: 'Public grant',
    validFrom: new Date(now - 1000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
  }
  const foreign = await request('POST', path + '/memory-grants', {
    key: 'wrong-recipient', data: { ...data, recipientIdentityId: identityB },
  })
  assert.equal(foreign.status, 404)
  const grant = await request('POST', path + '/memory-grants', { key: 'public-grant', data })
  assert.equal(grant.status, 201, JSON.stringify(grant.body))
  const revoke = await request('POST', path + '/memory-grants/' + grant.body.id + '/revoke', {
    key: 'revoke-grant', data: { reason: 'Remove public access' },
  })
  assert.equal(revoke.status, 200)
  assert.equal(revoke.body.authEpoch, grant.body.authEpoch + 1)
  const ownContact = await owner.contact.create({ data: {
    characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID(), displayLabel: 'Grant fixture contact',
  } })
  const otherContact = await owner.contact.create({ data: { characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID() } })
  const privateConversation = await owner.conversation.create({ data: {
    characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID(),
    channel: 'PRIVATE', privateContactId: ownContact.id,
  } })
  const options = path + '/identities/' + identityA + '/conversations?accountId=' + accountA + '&channel=PRIVATE&limit=100'
  const choices = await request('GET', options)
  assert.equal(choices.status, 200, JSON.stringify(choices.body))
  assert.deepEqual(choices.body.items.find((item: { id: string }) => item.id === privateConversation.id), {
    id: privateConversation.id, channel: 'PRIVATE', privateContactId: ownContact.id, contactLabel: 'Grant fixture contact',
  })
  assert.ok(choices.body.items.every((item: { channel: string }) => item.channel === 'PRIVATE'))
  assert.equal((await request('GET', options + '&cursor=' + audience.id)).status, 422)
  assert.equal((await request('GET', options, { actor: 'auditor' })).status, 403)
  const wrongIdentity = path + '/identities/' + identityB + '/conversations?accountId=' + accountA
  assert.equal((await request('GET', wrongIdentity)).status, 404)
  const privateData = { ...data, purpose: 'PRIVATE_REPLY', audience: undefined,
    recipientConversationId: privateConversation.id, recipientContactId: ownContact.id }
  assert.equal((await request('POST', path + '/memory-grants', {
    key: 'wrong-private-contact', data: { ...privateData, recipientContactId: otherContact.id },
  })).status, 404)
  const privateGrant = await request('POST', path + '/memory-grants', { key: 'private-grant', data: privateData })
  assert.equal(privateGrant.status, 201, JSON.stringify(privateGrant.body))
  const grants = await request('GET', path + '/memory-grants?memoryId=' + memory.id)
  const savedGrant = grants.body.items.find(({ id }: { id: string }) => id === grant.body.id)
  assert.ok(savedGrant)
  assert.ok(savedGrant.revokedAt)
  assert.equal(grants.body.items.length, 2)
  const privateMetadata = grants.body.items.find(({ id }: { id: string }) => id === privateGrant.body.id)
  assert.equal(privateMetadata.recipientContactId, ownContact.id)
  assert.equal(privateMetadata.recipientConversationId, privateConversation.id)
  const memories = await request('GET', path + '/memories?identityId=' + identityA + '&scope=IDENTITY&status=ACTIVE&limit=100',
    { actor: 'auditor' })
  assert.equal(memories.status, 200)
  const savedMemory = memories.body.items.find(({ id }: { id: string }) => id === memory.id)
  assert.ok(savedMemory)
  assert.ok(!('content' in savedMemory))
  assert.ok(memories.body.items.every((item: { identityId: string; scope: string; status: string }) =>
    item.identityId === identityA && item.scope === 'IDENTITY' && item.status === 'ACTIVE'))
  await assert.rejects(management.memory.findMany({ select: { content: true } }), /permission denied/i)
  const approved = (await approveSimulation()).action
  const account = await request('POST', path + '/controls', {
    key: 'revoke-account', data: { scope: 'ACCOUNT', scopeId: accountA, operation: 'REVOKE_ACCOUNT', reason: 'Unlink' },
  })
  assert.equal(account.status, 200)
  assert.equal(account.body.status, 'REVOKED')
  const bound = await owner.platformAccount.findUniqueOrThrow({ where: { id: accountA } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    const payload = {
      id: 'revoked-simulated-subject', account: bound.remoteAccountId, thread: audience.remoteKey,
      kind: 'REPLY', occurredAt: new Date().toISOString(), text: 'Reply after revocation',
    }
    assert.deepEqual(await ingest({ accountId: bound.id, platform: bound.platform, instanceKey: bound.instanceKey, verifiedRemoteAccountId: bound.remoteAccountId }, payload),
      { status: 'ACCOUNT_UNAVAILABLE' })
    assert.equal(await owner.inboundEvent.count({ where: { accountId: bound.id, sourceKey: payload.id } }), 0)
    await executeSimulation(executor, approved.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Revoked account reached the adapter'))
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: approved.id } }), 0)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
  assert.equal((await request('POST', path + '/controls', {
    key: 'resume-revoked', data: { scope: 'ACCOUNT', scopeId: accountA, operation: 'RESUME', reason: 'Rejected transition' },
  })).status, 409)
})

test('memory correction revokes old citations and descendants and keeps a metadata trail', async () => {
  const { action, grant } = await proposeReview(await newSimulationAccount())
  const memoryId = grant.memoryId
  const child = await deriveMemory(owner, { characterId: a, parentMemoryId: memoryId, content: 'Derived old claim' })
  const path = characterPath(a) + '/memories/' + memoryId
  const initial = await request('GET', path + '/provenance')
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('etag'), '"1"')
  assert.equal(initial.body.sources.length, 1)
  const detail = await request('GET', path, { actor: 'auditor' })
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  assert.deepEqual(detail.body.provenance, initial.body)
  assert.equal(detail.body.memory.id, memoryId)
  assert.equal(detail.body.memory.createdAt, (await owner.memory.findUniqueOrThrow({ where: { id: memoryId } })).createdAt.toISOString())
  assert.equal('content' in detail.body.memory, false)
  assert.equal((await request('GET', path, { actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', characterPath(b) + '/memories/' + memoryId, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('GET', characterPath(b) + '/memories/' + memoryId + '/provenance', { actor: 'admin-b' })).status, 404)
  const options = { ifMatch: '"1"', data: { content: 'Corrected claim', reason: 'Check source' } }
  assert.equal((await request('PUT', path + '/correction', { ...options, actor: 'reviewer' })).status, 403)
  const outcomes = await Promise.all([request('PUT', path + '/correction', options), request('PUT', path + '/correction', options)])
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [200, 412])
  assert.equal((await owner.memory.findUniqueOrThrow({ where: { id: memoryId } })).content, 'Corrected claim')
  const derived = await owner.memory.findUniqueOrThrow({ where: { id: child.id } })
  assert.equal(derived.status, 'REVOKED')
  assert.equal(derived.content, '')
  assert.ok((await owner.memoryGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt)
  const trace = await request('GET', path + '/provenance')
  assert.equal(trace.body.revision, 2)
  assert.deepEqual(trace.body.corrections.map(({ revision }: { revision: number }) => revision), [2])
  assert.ok(!JSON.stringify(trace.body).includes('Corrected claim'))
  const replay = await request('GET', characterPath(a) + '/runs/' + action.runId + '/replay')
  const evidence = replay.body.snapshots.flatMap((snapshot: { evidence: { available: boolean }[] }) => snapshot.evidence)
  assert.ok(evidence.length > 0 && evidence.every(({ available }: { available: boolean }) => !available))
})

test('explicit contact opt-out blocks an in-flight send and old approval stays blocked after release', async () => {
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const accountId = await newSimulationAccount()
  const otherAccountId = await newSimulationAccount()
  const remoteKey = randomUUID()
  const contact = await owner.contact.create({ data: { characterId: a, identityId: identityA, accountId, remoteKey } })
  const otherContact = await owner.contact.create({
    data: { characterId: a, identityId: identityA, accountId: otherAccountId, remoteKey },
  })
  const inFlight = (await approveSimulation(accountId, contact.id)).action
  const old = (await approveSimulation(accountId, contact.id)).action
  const independent = (await approveSimulation(otherAccountId, otherContact.id)).action
  const target = reviewTarget.parse(inFlight.target)
  const account = await owner.platformAccount.findUniqueOrThrow({ where: { id: accountId } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    let stopRunId: string | undefined
    await executeSimulation(executor, inFlight.id, simulationPlatforms.resolveAdapter, async (database, id) => {
      const result = await ingest({
        accountId, platform: account.platform, instanceKey: account.instanceKey, verifiedRemoteAccountId: account.remoteAccountId,
      }, {
        id: randomUUID(), account: account.remoteAccountId, thread: target.conversation, sender: remoteKey,
        kind: 'REPLY', occurredAt: new Date().toISOString(), text: '不要联系我。',
      })
      assert.equal(result.status, 'ACCEPTED')
      stopRunId = result.runId
      return recordSimulationReceipt(database, id)
    })
    assert.ok(stopRunId)
    const stopEvent = await owner.outboxEvent.findFirstOrThrow({ where: { runId: stopRunId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, stopEvent.eventId)
    const stopDraft = await owner.outboxEvent.findFirstOrThrow({ where: { runId: stopRunId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, stopDraft.eventId, simulationPlatforms.resolveAdapter, simulatedModelPlugin)
    assert.equal(await owner.actionProposal.count({ where: { runId: stopRunId } }), 0)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: inFlight.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: inFlight.id } })).status, 'NOT_SENT')
    const path = characterPath(a) + '/contacts/' + contact.id + '/boundary'
    const boundary = await request('GET', path)
    assert.equal(boundary.status, 200)
    assert.equal(boundary.body.blocked, true)
    assert.equal(boundary.body.version, 1)
    const contactPath = characterPath(a) + '/identities/' + identityA + '/contacts?limit=100'
    const contactList = await request('GET', contactPath, { actor: 'auditor' })
    assert.equal(contactList.status, 200, JSON.stringify(contactList.body))
    const contactRow = contactList.body.items.find((item: { id: string }) => item.id === contact.id)
    assert.deepEqual(contactRow, { id: contact.id, accountId, version: 1, blocked: true, label: contact.displayLabel })
    assert.equal((await request('GET', contactPath, { actor: 'reviewer' })).status, 403)
    assert.equal((await owner.contact.findUniqueOrThrow({ where: { id: otherContact.id } })).noContactAt, null)
    assert.equal(await owner.managementAudit.count({ where: { targetId: contact.id, operation: 'contact.opt_out' } }), 1)

    const options = { ifMatch: '"1"', data: { blocked: false, reason: 'Verified renewed consent' } }
    assert.equal((await request('PUT', path, { ...options, actor: 'reviewer' })).status, 403)
    assert.equal((await request('PUT', path, { ...options, ifMatch: '"0"' })).status, 412)
    assert.equal((await request('PUT', path, options)).status, 200)
    await executeSimulation(executor, old.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Old approval was revived'))
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: old.id } }), 0)
    await executeSimulation(executor, independent.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: independent.id } }), 1)
    const fresh = (await approveSimulation(accountId, contact.id)).action
    const released = await owner.contact.findUniqueOrThrow({ where: { id: contact.id } })
    assert.ok(released.boundaryChangedAt)
    const backdated = await owner.agentRun.update({
      where: { id: fresh.runId }, data: { createdAt: new Date(released.boundaryChangedAt.getTime() - 1000) },
    })
    assert.equal(backdated.contactBoundaryVersion, 2)
    await executeSimulation(executor, fresh.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: fresh.id } }), 1)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

async function beliefEvidence(sourceId?: string, accountId?: string, expiresAt?: Date) {
  const source = sourceId ? { id: sourceId } : await owner.sourceRecord.create({
    data: { characterId: a, identityId: identityA, accountId, kind: 'fixture', sourceKey: randomUUID(), classification: 'PERSONAL' },
  })
  const memory = await owner.memory.create({
    data: {
      characterId: a, identityId: identityA, accountId, scope: accountId ? 'ACCOUNT' : 'IDENTITY',
      visibility: 'PERSONAL', content: 'Belief fixture', expiresAt,
    },
  })
  await owner.memorySource.create({ data: { characterId: a, memoryId: memory.id, sourceId: source.id } })
  return { sourceId: source.id, citation: { memoryId: memory.id, memoryRevision: 1, direction: 'SUPPORT', weight: 1 } }
}

const beliefCollection = (identityId: string) => characterPath(a) + '/identities/' + identityId + '/beliefs'
const beliefData = (evidence: unknown[], statement = 'I prefer a quiet workspace') => ({
  kind: 'PREFERENCE', statement, reason: 'Reviewed evidence', evidence,
})

test('belief evolution counts origin sources once and records strong conflict without overwriting history', async () => {
  const first = await beliefEvidence()
  const duplicate = await beliefEvidence(first.sourceId)
  const independent = await beliefEvidence()
  const contrary = await beliefEvidence()
  const collection = beliefCollection(identityA)
  const initial = await request('POST', collection, { key: 'belief-pending', data: beliefData([first.citation]) })
  assert.equal(initial.status, 201, JSON.stringify(initial.body))
  assert.equal(initial.body.status, 'PENDING')
  const path = collection + '/' + initial.body.id
  const pendingReplay = await request('PUT', path, { ifMatch: '"1"', data: beliefData([duplicate.citation]) })
  assert.equal(pendingReplay.body.status, 'PENDING')
  assert.equal((await request('PUT', path, {
    ifMatch: '"2"', data: beliefData([first.citation, duplicate.citation]),
  })).status, 422)
  assert.equal((await request('POST', collection, {
    key: 'belief-value', data: { ...beliefData([first.citation, independent.citation]), kind: 'VALUE' },
  })).status, 422)
  const evidence = [first.citation, independent.citation]
  const promoted = await request('PUT', path, { ifMatch: '"2"', data: beliefData(evidence) })
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
  assert.equal(promoted.body.status, 'ACTIVE')
  assert.equal((await request('GET', path)).body.confidence, 0.7)
  assert.equal((await request('PUT', path, {
    ifMatch: '"3"', data: beliefData([duplicate.citation, independent.citation]),
  })).status, 200)
  assert.equal((await request('GET', path)).body.confidence, 0.7)
  const disputed = await request('PUT', path, {
    ifMatch: '"4"', data: beliefData([...evidence, { ...contrary.citation, direction: 'OPPOSE' }]),
  })
  assert.equal(disputed.body.status, 'DISPUTED')
  assert.equal((await request('GET', path + '?revision=4')).body.status, 'ACTIVE')
})

test('belief rollback appends a revision and cannot restore revoked or out-of-scope evidence', async () => {
  const first = await beliefEvidence()
  const second = await beliefEvidence()
  const third = await beliefEvidence()
  const accountOnly = await beliefEvidence(undefined, accountA)
  const collection = beliefCollection(identityA)
  assert.equal((await request('POST', collection, {
    key: 'belief-account', data: beliefData([first.citation, accountOnly.citation]),
  })).status, 422)
  const initial = await request('POST', collection, {
    key: 'belief-restore', data: beliefData([first.citation, second.citation]),
  })
  assert.equal(initial.status, 201, JSON.stringify(initial.body))
  const path = collection + '/' + initial.body.id
  assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('GET', beliefCollection(identityB) + '/' + initial.body.id)).status, 404)
  assert.equal((await request('PUT', path, {
    ifMatch: '"1"', data: beliefData([second.citation, third.citation], 'I prefer to work outside'),
  })).status, 200)
  const data = { restoreVersion: 1, reason: 'Restore the previous preference' }
  assert.equal((await request('POST', path + '/restore', { ifMatch: '"1"', data })).status, 412)
  const restored = await request('POST', path + '/restore', { ifMatch: '"2"', data })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  assert.equal(restored.body.version, 3)
  assert.equal((await request('GET', path)).body.restoredFrom, 1)
  const summaries = await request('GET', collection, { actor: 'auditor' })
  assert.equal(summaries.status, 200, JSON.stringify(summaries.body))
  assert.deepEqual(summaries.body.items.find((item: { id: string }) => item.id === initial.body.id),
    { id: initial.body.id, kind: 'PREFERENCE', version: 3 })
  assert.equal((await request('GET', beliefCollection(identityB))).status, 404)
  assert.equal((await request('GET', collection, { actor: 'reviewer' })).status, 403)

  assert.equal(await revokeMemoryAccess(owner, { kind: 'SOURCE', characterId: a, id: first.sourceId }), true)
  for (const url of [path, path + '?revision=1']) {
    const view = await request('GET', url)
    assert.equal(view.body.status, 'INVALIDATED')
    assert.equal(view.body.statement, null)
    assert.equal(view.body.confidence, null)
    assert.deepEqual(view.body.evidence, [])
    assert.deepEqual(view.body.remainingEvidence, { supportingSources: 1, opposingSources: 0, confidence: 0.6 })
  }
  assert.equal((await request('POST', path + '/restore', { ifMatch: '"3"', data })).status, 409)
  const replacement = await request('PUT', path, {
    ifMatch: '"3"', data: beliefData([second.citation, third.citation], 'I prefer to work outside'),
  })
  assert.equal(replacement.body.status, 'ACTIVE')
  assert.equal((await request('GET', path)).body.version, 4)
})

async function reflectionIdentity(roleProfile: Record<string, unknown> = {}, characterId = a) {
  const created = await request('POST', characterPath(characterId) + '/identities', {
    key: randomUUID(), data: { slug: 'reflection-' + randomUUID(), roleProfile },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id: string = created.body.id
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE' } })
  await owner.identity.update({ where: { id }, data: { status: 'ACTIVE' } })
  return id
}

function reflectionPath(identityId: string, utcDay: string) {
  return characterPath(a) + '/identities/' + identityId + '/reflections/' + utcDay
}

async function reflectionDay() {
  const date = new Date((await databaseNow()) - 86_400_000)
  date.setUTCHours(12, 0, 0, 0)
  return { date, utcDay: date.toISOString().slice(0, 10) }
}

test('daily reflection deduplicates runs and creates only an identity-local pending preference', async () => {
  const identityId = await reflectionIdentity()
  const otherIdentity = await reflectionIdentity()
  const { date, utcDay } = await reflectionDay()
  const account = await owner.platformAccount.create({
    data: {
      characterId: a, identityId, status: 'ACTIVE', platform: 'mock-a',
      instanceKey: 'integration', remoteAccountId: randomUUID(),
    },
  })
  const conversation = await owner.conversation.create({
    data: { characterId: a, identityId, accountId: account.id, remoteKey: randomUUID(), channel: 'PUBLIC' },
  })
  await owner.inboundEvent.create({
    data: {
      characterId: a, identityId, accountId: account.id, conversationId: conversation.id, sourceKey: randomUUID(), kind: 'POST',
      occurredAt: date, receivedAt: date, messageText: 'unverified fixture message',
    },
  })
  const memory = await owner.memory.create({
    data: { characterId: a, identityId, scope: 'IDENTITY', visibility: 'PERSONAL', content: 'private experience', createdAt: date },
  })
  const source = await owner.sourceRecord.create({
    data: { characterId: a, identityId, kind: 'fixture', sourceKey: randomUUID(), classification: 'PERSONAL' },
  })
  await owner.memorySource.create({ data: { characterId: a, memoryId: memory.id, sourceId: source.id } })
  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    await Promise.all([scanIdentityReflections(runtime, null), scanIdentityReflections(runtime, null)])
    const path = reflectionPath(identityId, utcDay)
    const reflection = await request('GET', path)
    assert.equal(reflection.status, 200, JSON.stringify(reflection.body))
    assert.deepEqual(reflection.body.observedActivity, { kind: 'OBSERVED_ACTIVITY', simulatedReceipts: 0 })
    assert.deepEqual(reflection.body.unverifiedExternal, { kind: 'UNVERIFIED_EXTERNAL', inboundMessages: 1 })
    assert.equal(reflection.body.fictionalProfile.kind, 'FICTIONAL_PROFILE')
    assert.equal(JSON.stringify(reflection.body).includes('unverified fixture message'), false)
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    assert.equal((await request('GET', reflectionPath(otherIdentity, utcDay))).body.candidateBeliefId, null)
    const beliefId = reflection.body.candidateBeliefId
    const beliefPath = beliefCollection(identityId) + '/' + beliefId
    const belief = await request('GET', beliefPath)
    assert.equal(belief.body.status, 'PENDING')
    assert.equal(belief.body.evidence[0].memoryId, memory.id)
    assert.equal(await owner.beliefVersion.count({ where: { characterId: a, identityId } }), 1)

    assert.equal(await revokeMemoryAccess(owner, { kind: 'SOURCE', characterId: a, id: source.id }), true)
    assert.equal((await request('GET', beliefPath)).body.status, 'INVALIDATED')
  } finally {
    await runtime.$disconnect()
  }
})

test('daily reflection plans a bounded autonomous goal only with identity permission', async () => {
  const policy = { topic: 'REVIEW_INTERACTIONS', maxDays: 2, budget: 4 }
  const identityId = await reflectionIdentity({ autonomousGoal: policy })
  const disabled = await reflectionIdentity()
  const { date, utcDay } = await reflectionDay()
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const account = await newSimulationAccount(identityId)
  const otherAccount = await newSimulationAccount(disabled)
  const executor = simulationDatabase()
  try {
    for (const [accountId, id] of [[account, identityId], [otherAccount, disabled]]) {
      const { action } = await approveSimulation(accountId, undefined, id)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state, 'SIMULATED')
      await owner.simulationReceipt.update({ where: { actionId: action.id }, data: { createdAt: date } })
    }
  } finally {
    await executor.$disconnect()
  }

  const base = characterPath(a) + '/identities/' + identityId
  const goals = base + '/goals'
  const manual = {
    title: 'Manual fixture', status: 'ACTIVE', priority: 50, budget: 5, reason: 'Existing plan',
    dueAt: new Date((await databaseNow()) + 86_400_000).toISOString(),
  }
  for (const key of ['existing-plan-1', 'existing-plan-2']) {
    assert.equal((await request('POST', goals, { key, data: manual })).status, 201)
  }

  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    let cursor: string | null = null
    do { cursor = await scanIdentityReflections(runtime, cursor) } while (cursor)
  } finally {
    await runtime.$disconnect()
  }
  for (const id of [identityId, disabled]) {
    const reflection = await request('GET', reflectionPath(id, utcDay))
    assert.equal(reflection.status, 200, JSON.stringify(reflection.body))
    assert.equal(reflection.body.observedActivity.simulatedReceipts, 1)
  }
  const list = await request('GET', goals)
  assert.equal(list.status, 200, JSON.stringify(list.body))
  const [self] = list.body.filter(({ origin }: { origin: string }) => origin === 'SELF')
  assert.equal(list.body.length, 3)
  assert.equal(self.status, 'ACTIVE')
  assert.equal(self.reflectionDay, utcDay)
  assert.equal(self.topic, policy.topic)
  assert.equal(self.budget, policy.budget)
  assert.equal(Date.parse(self.dueAt) - Date.parse(self.createdAt), 2 * 86_400_000)
  assert.ok(self.nextStep)
  assert.deepEqual((await request('GET', characterPath(a) + '/identities/' + disabled + '/goals')).body, [])
  assert.equal((await request('POST', goals, { key: 'fourth-goal', data: manual })).body.error.code, 'GOAL_LIMIT')

  const { action } = await proposeReview(account, undefined, simulatedModelPlugin, identityId)
  const replay = await request('GET', characterPath(a) + '/runs/' + action.runId + '/replay')
  assert.ok(replay.body.goalRefs.some(({ id, version }: { id: string; version: number }) => id === self.id && version === 1))
  const path = goals + '/' + self.id
  assert.equal((await request('PUT', path, { ifMatch: '"1"', data: manual })).body.error.code, 'GOAL_SELF_MANAGED')

  const revoked = await request('PUT', base, {
    ifMatch: '"1"', data: { roleProfile: {}, reason: 'Withdraw autonomous goal permission' },
  })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  const canceled = await request('GET', path)
  assert.equal(canceled.body.status, 'CANCELED')
  assert.equal(canceled.body.version, 2)
  assert.equal((await request('GET', path + '?revision=1')).body.status, 'ACTIVE')
})

test('external low-risk automation is assessed per account without enabling a simulator', async () => {
  const identityId = await reflectionIdentity()
  const active = await newSimulationAccount(identityId)
  const paused = await newSimulationAccount(identityId)
  await owner.platformAccount.update({ where: { id: paused }, data: { status: 'PAUSED' } })
  const path = (id: string) => characterPath(a) + '/accounts/' + id + '/automation-eligibility'
  assert.equal((await request('GET', path(active), { actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', path(active), { actor: 'admin-b' })).status, 404)
  const activeView = await request('GET', path(active))
  const pausedView = await request('GET', path(paused))
  assert.equal(activeView.status, 200, JSON.stringify(activeView.body))
  assert.deepEqual(activeView.body, {
    accountId: active, identityId, bindingVersion: 1, eligible: false, reasons: ['SIMULATION_ONLY', 'EXTERNAL_AUTO_DISABLED'],
  })
  assert.equal(pausedView.status, 200, JSON.stringify(pausedView.body))
  assert.equal(pausedView.body.eligible, false)
  assert.deepEqual(pausedView.body.reasons, ['BINDING_INACTIVE', 'SIMULATION_ONLY', 'EXTERNAL_AUTO_DISABLED'])
})

async function beliefReviewAccount() {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  return newSimulationAccount()
}

test('subjective belief projection stays inside decisions and expired references block execution', { timeout: 20_000 }, async () => {
  const expiresAt = new Date((await databaseNow()) + 8000)
  const first = await beliefEvidence(undefined, undefined, expiresAt)
  const second = await beliefEvidence()
  const statement = 'I prefer a shaded trail'
  const created = await request('POST', beliefCollection(identityA), {
    key: 'belief-decision-projection', data: beliefData([first.citation, second.citation], statement),
  })
  assert.equal(created.body.status, 'ACTIVE')
  const reference = { id: created.body.id, version: 1 }
  const model: typeof simulatedModelPlugin = {
    ...simulatedModelPlugin,
    implementation: {
      async decide(input, signal) {
        assert.deepEqual(input.context.beliefs.find(({ id }) => id === reference.id), {
          ...reference, kind: 'PREFERENCE', statement, confidence: 0.7, subjective: true,
        })
        return simulatedModelPlugin.implementation.decide(input, signal)
      },
      async write(input, signal) {
        assert.equal('context' in input, false)
        assert.equal(JSON.stringify(input).includes(statement), false)
        return simulatedModelPlugin.implementation.write(input, signal)
      },
    },
  }
  const { action } = await proposeReview(await beliefReviewAccount(), undefined, model)
  const approval = await request('POST', actionPath(action.id) + '/decisions', {
    actor: 'reviewer', key: 'approve-belief-projection', ifMatch: '"run-v3"',
    data: { reviewDigest: action.reviewDigest, decision: 'APPROVE', reason: 'Belief projection fixture' },
  })
  assert.equal(approval.status, 200, JSON.stringify(approval.body))
  const path = characterPath(a) + '/runs/' + action.runId + '/replay'
  const replay = await request('GET', path)
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.ok(replay.body.beliefRefs.some(({ id, version }: { id: string; version: number }) => id === reference.id && version === 1))
  assert.equal(JSON.stringify(replay.body).includes(statement), false)

  const waiting = await approveSimulation(await newSimulationAccount())
  const executor = simulationDatabase()
  try {
    let permitted = false
    await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      permitted = true
      while ((await databaseNow()) < expiresAt.getTime()) await sleep(100)
      return recordSimulationReceipt(db, id)
    })
    assert.equal(permitted, true)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
    assert.equal(await reserveSimulation(executor, waiting.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: waiting.action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: waiting.action.id } }), 0)
  } finally {
    await executor.$disconnect()
  }
})

test('subjective belief supersession during decision prevents the in-flight proposal', async () => {
  const first = await beliefEvidence()
  const second = await beliefEvidence()
  const third = await beliefEvidence()
  const collection = beliefCollection(identityA)
  const created = await request('POST', collection, {
    key: 'belief-in-flight', data: beliefData([first.citation, second.citation]),
  })
  assert.equal(created.body.status, 'ACTIVE')
  let runId: string | undefined
  const model: typeof simulatedModelPlugin = {
    ...simulatedModelPlugin,
    implementation: {
      ...simulatedModelPlugin.implementation,
      async decide({ context }) {
        runId = context.runId
        assert.ok(context.beliefs.some(({ id, version }) => id === created.body.id && version === 1))
        const updated = await request('PUT', collection + '/' + created.body.id, {
          ifMatch: '"1"', data: beliefData([second.citation, third.citation], 'I prefer to work outside'),
        })
        assert.equal(updated.body.status, 'ACTIVE')
        return 'REPLY'
      },
    },
  }
  await assert.rejects(proposeReview(await beliefReviewAccount(), undefined, model), { code: 'P2025' })
  assert.ok(runId)
  const run = await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })
  assert.equal(run.state, 'CANCELED')
  assert.equal(run.stateReason, 'DRAFT_UNAVAILABLE')
})

test('manual goal cap is atomic and replay pins the identity version of active goals', async () => {
  const path = characterPath(a) + '/identities/' + identityA + '/goals'
  const data = {
    title: 'Preserve a local activity plan', status: 'ACTIVE', budget: 2, priority: 60,
    dueAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Configure local simulation',
  }
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    request('POST', path, { key: 'm2-goal-' + i, data })))
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 201, 201, 409])
  const initial = await request('GET', path)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.length, 3)
  const id: string = initial.body[0].id
  const goalPath = path + '/' + id
  const foreign = characterPath(b) + '/identities/' + identityA + '/goals/' + id
  assert.equal((await request('GET', foreign, { actor: 'admin-b' })).status, 404)
  const otherIdentity = await owner.identity.findFirstOrThrow({ where: { characterId: a, id: { not: identityA } } })
  assert.equal((await request('GET', characterPath(a) + '/identities/' + otherIdentity.id + '/goals/' + id)).status, 404)
  assert.equal((await request('PUT', goalPath, { ifMatch: '"1"', data, actor: 'reviewer' })).status, 403)

  const { action } = await proposeReview(await newSimulationAccount())
  const replayPath = characterPath(a) + '/runs/' + action.runId + '/replay'
  const replay = await request('GET', replayPath)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.goalRefs.length, 3)
  assert.ok(replay.body.goalRefs.some((ref: { id: string; version: number }) => ref.id === id && ref.version === 1))
  assert.ok(!JSON.stringify(replay.body).includes(data.title))
  assert.equal((await request('PUT', goalPath, { ifMatch: '"1"', data: { ...data, status: 'PAUSED' } })).status, 200)
  assert.equal((await request('GET', goalPath + '?revision=1')).body.status, 'ACTIVE')
  assert.equal((await request('GET', goalPath)).body.status, 'PAUSED')
  const current = await proposeReview(await newSimulationAccount())
  const newer = await request('GET', characterPath(a) + '/runs/' + current.action.runId + '/replay')
  assert.equal(newer.body.goalRefs.length, 2)
  assert.deepEqual((await request('GET', replayPath)).body.goalRefs, replay.body.goalRefs)
})

async function stateFixtureAccount(slug: string) {
  const created = await request('POST', characterPath(a) + '/identities', {
    key: slug, data: { slug, roleProfile: {} },
  })
  assert.equal(created.status, 201)
  const identityId: string = created.body.id
  await owner.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } })
  return owner.platformAccount.create({
    data: { characterId: a, identityId, platform: 'mock-a', status: 'ACTIVE', instanceKey: 'integration',
      remoteAccountId: randomUUID() },
  })
}

test('late state inputs replay with the rule configuration pinned to each event', async () => {
  const account = await stateFixtureAccount('rule-replay')
  const conversation = await owner.conversation.create({
    data: { characterId: a, identityId: account.identityId, accountId: account.id, channel: 'PUBLIC', remoteKey: randomUUID() },
  })
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    const source = { accountId: account.id, platform: account.platform, instanceKey: account.instanceKey,
      verifiedRemoteAccountId: account.remoteAccountId }
    async function prepare(instant: number) {
      const event = await ingest(source, {
        id: randomUUID(), account: account.remoteAccountId, thread: conversation.remoteKey, kind: 'POST',
        occurredAt: new Date(instant).toISOString(), text: 'Rule fixture',
      })
      assert.equal(event.status, 'ACCEPTED')
      const job = await owner.outboxEvent.findFirstOrThrow({ where: { runId: event.runId, type: runQueuedEvent } })
      await prepareSimulatedRun(runtime, job.eventId)
      return event.runId
    }

    const earlier = Date.now() - 48 * 3_600_000
    const original = await prepare(earlier + 24 * 3_600_000)
    const path = characterPath(a) + '/identities/' + account.identityId
    const zero = [0, 0, 0, 0, 0, 0, 0]
    const stateRule = {
      motivationHalfLifeHours: 12, affectHalfLifeHours: 6,
      deltas: { POST: [0.10, 0, 0, 0, 0, 0, 0], MENTION: zero, REPLY: zero },
    }
    const options = { ifMatch: '"1"', data: { roleProfile: { stateRule }, reason: 'Tune simulation rules' } }
    assert.equal((await request('PUT', path, { ...options, actor: 'reviewer' })).status, 403)
    assert.equal((await request('PUT', path, {
      ...options, data: { ...options.data, roleProfile: { stateRule: { ...stateRule,
        deltas: { ...stateRule.deltas, POST: [0.16, 0, 0, 0, 0, 0, 0] },
      } } },
    })).status, 422)
    const updated = await request('PUT', path, options)
    assert.equal(updated.status, 200)
    assert.equal(updated.body.version, 2)
    const late = await prepare(earlier)

    const old = await owner.identityStateRevision.findUniqueOrThrow({ where: { runId: original } })
    const current = await owner.identityStateRevision.findUniqueOrThrow({ where: { runId: late } })
    assert.equal(old.ruleConfiguration, null)
    assert.ok(Math.abs(old.values[0] - 0.58) < 1e-12)
    assert.deepEqual(current.ruleConfiguration, stateRule)
    assert.equal(current.revision, 2)
    assert.equal(current.throughEventId, old.eventId)
    // The late input adds 0.10. The original input applies v1's 24-hour decay and 0.08 increment.
    assert.ok(Math.abs(current.values[0] - 0.63) < 1e-12)
    const context = await runtime.$transaction((tx) => loadRunContinuity(tx, late))
    assert.equal(context?.identityState.configurationVersion, 2)
    const profilePath = characterPath(a) + '/identities?limit=100'
    const find = (result: Awaited<ReturnType<typeof request>>) =>
      result.body.items.find(({ id }: { id: string }) => id === account.identityId).profile
    assert.deepEqual(find(await request('GET', profilePath)).stateRule, stateRule)
    assert.ok(!('stateRule' in find(await request('GET', profilePath, { actor: 'reviewer' }))))
  } finally {
    await runtime.$disconnect()
  }
})

test('approved energy is immutable and visible only within its character and UTC day', async () => {
  const [clock] = await owner.$queryRaw<{ day: string }[]>`
    SELECT ((statement_timestamp() AT TIME ZONE 'UTC')::date)::text AS day
  `
  const today = new Date(clock.day + 'T00:00:00Z').getTime()
  const utcDay = new Date(today + 86_400_000).toISOString().slice(0, 10)
  const path = characterPath(a) + '/daily-energy'
  const input = { utcDay, energy: 'HIGH', reason: 'Approved abstract projection' }
  const options = { key: 'daily-energy-fixture', data: input }
  assert.equal((await request('POST', path, { ...options, actor: 'reviewer' })).status, 403)
  assert.equal((await request('POST', path, { ...options, data: { ...input, utcDay: clock.day } })).status, 422)
  const approved = await request('POST', path, options)
  assert.equal(approved.status, 201)
  assert.equal((await request('POST', path, options)).body.id, approved.body.id)
  assert.equal((await request('POST', path, { key: 'replace-daily', data: { ...input, energy: 'LOW' } })).status, 409)
  const view = await request('GET', path + '/' + utcDay)
  assert.equal(view.body.energy, 'HIGH')
  assert.ok(!('reason' in view.body))
  assert.equal((await request('GET', characterPath(b) + '/daily-energy/' + utcDay, { actor: 'admin-b' })).status, 404)

  const foreign = await request('POST', characterPath(b) + '/daily-energy', {
    actor: 'admin-b', key: 'foreign-energy', data: { ...input, energy: 'LOW' },
  })
  assert.equal(foreign.status, 201)
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    for (const slug of ['energy-first', 'energy-second']) {
      const account = await stateFixtureAccount(slug)
      const run = await ingestSimulatedEvent(runtime, {
        accountId: account.id, sourceKey: randomUUID(), kind: 'POST', occurredAt: new Date(today),
      })
      assert.equal(run.status, 'ACCEPTED')
      const runId = run.runId
      const event = await owner.outboxEvent.findFirstOrThrow({ where: { runId, type: runQueuedEvent } })
      await prepareSimulatedRun(runtime, event.eventId)
      for (const [offset, expected] of [[-1, 'NORMAL'], [0, 'HIGH'], [1, 'NORMAL']] as const) {
        await owner.agentRun.update({
          where: { id: runId }, data: { createdAt: new Date(today + (1 + offset) * 86_400_000) },
        })
        const context = await runtime.$transaction<Awaited<ReturnType<typeof loadRunContinuity>>>(
          (tx) => loadRunContinuity(tx, runId),
        )
        assert.equal(context?.identityState.sharedEnergy, expected)
        assert.equal(context?.identityState.affect.energy, 0.7)
      }
    }
    await assert.rejects(runtime.dailyEnergyProjection.count(), /permission denied/i)
  } finally {
    await runtime.$disconnect()
  }
})

async function topicAccount(identityId: string, platform: 'mock-a' | 'mock-b', privateChannel = false, characterId = a) {
  const account = await owner.platformAccount.create({
    data: { characterId, identityId, status: 'ACTIVE', platform, instanceKey: 'integration', remoteAccountId: randomUUID() },
  })
  const contact = privateChannel ? await owner.contact.create({
    data: { characterId, identityId, accountId: account.id, remoteKey: randomUUID() },
  }) : null
  const conversation = await owner.conversation.create({
    data: {
      characterId, identityId, accountId: account.id, remoteKey: randomUUID(),
      channel: privateChannel ? 'PRIVATE' : 'PUBLIC', privateContactId: contact?.id,
    },
  })
  return { account, conversation, contact }
}

async function prepareTopic(runtime: ReturnType<typeof createDatabase>, target: Awaited<ReturnType<typeof topicAccount>>,
  text: string, sourceKey = randomUUID(), occurredAt = new Date(),
) {
  const { account, conversation, contact } = target
  const source = {
    accountId: account.id, platform: account.platform, instanceKey: account.instanceKey, verifiedRemoteAccountId: account.remoteAccountId,
  }
  const payload = account.platform === 'mock-a' ? {
    id: sourceKey, account: account.remoteAccountId, thread: conversation.remoteKey, sender: contact?.remoteKey,
    kind: 'POST', occurredAt: occurredAt.toISOString(), text,
  } : {
    delivery: sourceKey, recipient: account.remoteAccountId, action: 'post', timeMs: occurredAt.getTime(),
    message: { conversation: conversation.remoteKey, author: contact?.remoteKey, body: text },
  }
  const result = await createSimulatedPlatformIngress(runtime, simulationPlatforms.find)(source, payload)
  assert.equal(result.status, 'ACCEPTED')
  const runJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: runQueuedEvent } })
  await prepareSimulatedRun(runtime, runJob.eventId)
  const job = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: draftQueuedEvent } })
  return { runId: result.runId, eventId: job.eventId }
}

async function topicProposal(runtime: ReturnType<typeof createDatabase>, target: Awaited<ReturnType<typeof topicAccount>>,
  text: string, model = simulatedModelPlugin,
) {
  const { runId, eventId } = await prepareTopic(runtime, target, text)
  await processSimulatedDraft(runtime, eventId, simulationPlatforms.resolveAdapter, model)
  return owner.actionProposal.findUniqueOrThrow({ where: { runId } })
}

test('outbox retry cap survives Worker restart and ADMIN can reopen it once', { timeout: 35_000 }, async () => {
  const identityId = await reflectionIdentity()
  const target = await topicAccount(identityId, 'mock-a')
  const runtimeUrl = scheduleRuntimeUrl()
  const runtime = createDatabase(runtimeUrl)
  try {
    const { runId, eventId } = await prepareTopic(runtime, target, 'Outbox recovery fixture')
    const where = { eventId }
    const read = () => owner.outboxEvent.findUniqueOrThrow({ where })
    const wait = async (predicate: (row: Awaited<ReturnType<typeof read>>) => boolean) => {
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        const row = await read()
        if (predicate(row)) return row
        await sleep(50)
      }
      assert.fail('Outbox did not reach the expected state')
    }
    let failures = 0
    const failing: typeof simulatedModelPlugin = {
      ...simulatedModelPlugin,
      implementation: {
        ...simulatedModelPlugin.implementation,
        async decide(input, signal) {
          if (input.context.runId !== runId) return simulatedModelPlugin.implementation.decide(input, signal)
          failures++
          throw new Error('synthetic model failure')
        },
      },
    }
    const first = await startOutboxWorker(runtimeUrl, config.redisUrl, failing, simulationPlatforms.resolveAdapter)
    try {
      await wait(({ attempts, attemptUntil }) => attempts === 3 && attemptUntil === null)
    } finally {
      await first.close()
    }
    assert.equal(failures, 3)
    await owner.outboxEvent.update({ where, data: { enqueuedAt: new Date(Date.now() - 15_000) } })
    const restarted = await startOutboxWorker(runtimeUrl, config.redisUrl, failing, simulationPlatforms.resolveAdapter)
    try {
      const held = await wait(({ quarantinedAt }) => quarantinedAt !== null)
      assert.equal(held.attempts, 4)
      assert.equal(held.processedAt, null)
    } finally {
      await restarted.close()
    }
    assert.equal(failures, 4)
    const list = await request('GET', characterPath(a) + '/outbox/quarantined')
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.ok(list.body.items.some((row: { id: string; generation: number }) => row.id === eventId && row.generation === 0))
    const monitoring = await request('GET', characterPath(a) + '/monitoring')
    assert.ok(monitoring.body.outbox.quarantined >= 1)

    const suffix = '/outbox/' + eventId + '/retry'
    const options = { ifMatch: '"0"', data: { reason: 'Model provider recovered' } }
    assert.equal((await request('POST', characterPath(a) + suffix, { ...options, actor: 'reviewer' })).status, 403)
    assert.equal((await request('POST', characterPath(b) + suffix, { ...options, actor: 'admin-b' })).status, 404)
    const retried = await Promise.all(Array.from({ length: 2 }, () => request('POST', characterPath(a) + suffix, options)))
    assert.deepEqual(retried.map(({ status }) => status).sort(), [200, 412])
    assert.equal(await owner.managementAudit.count({ where: { targetId: eventId, operation: 'outbox.retry' } }), 1)
    const audit = await request('GET', characterPath(a) + '/audit?runId=' + runId)
    assert.equal(audit.status, 200, JSON.stringify(audit.body))
    assert.deepEqual(audit.body.items.map((item: { targetId: string; operation: string }) => [item.targetId, item.operation]),
      [[eventId, 'outbox.retry']])

    const [stale] = await runtime.$queryRaw<{ ticket: number | null }[]>`
      SELECT public.rica_begin_outbox_attempt(${eventId}::uuid, ${draftQueuedEvent}, 0) AS ticket
    `
    assert.equal(stale.ticket, null)
    const healthy = await startOutboxWorker(runtimeUrl, config.redisUrl, simulatedModelPlugin, simulationPlatforms.resolveAdapter)
    try {
      const processed = await wait(({ processedAt }) => processedAt !== null)
      assert.equal(processed.generation, 1)
      assert.equal(processed.attempts, 1)
      assert.equal(processed.quarantinedAt, null)
    } finally {
      await healthy.close()
    }
    assert.equal(await owner.actionProposal.count({ where: { runId } }), 1)
  } finally {
    await runtime.$disconnect()
  }
})

test('a crashed outbox attempt consumes its ticket and a late failure cannot release a replacement', async () => {
  const identityId = await reflectionIdentity()
  const target = await topicAccount(identityId, 'mock-a')
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const { eventId } = await prepareTopic(runtime, target, 'Outbox lease fixture')
    const claim = async () => {
      const [row] = await runtime.$queryRaw<{ ticket: number | null }[]>`
        SELECT public.rica_begin_outbox_attempt(${eventId}::uuid, ${draftQueuedEvent}, 0) AS ticket
      `
      return row.ticket
    }
    assert.deepEqual((await Promise.all([claim(), claim()])).sort(), [1, null])
    const expireLease = async () => owner.outboxEvent.update({
      where: { eventId }, data: { attemptUntil: new Date((await databaseNow()) - 1000) },
    })
    await expireLease()
    assert.equal(await claim(), 2)
    await runtime.$queryRaw`SELECT public.rica_fail_outbox_attempt(${eventId}::uuid, 0, 1)::text`
    assert.equal(await claim(), null)
    await processSimulatedDraft(runtime, eventId, simulationPlatforms.resolveAdapter, simulatedModelPlugin, { generation: 0, ticket: 1 })
    assert.equal((await owner.outboxEvent.findUniqueOrThrow({ where: { eventId } })).processedAt, null)
    for (const ticket of [3, 4]) {
      await expireLease()
      assert.equal(await claim(), ticket)
    }
    await expireLease()
    assert.equal(await claim(), null)
    assert.ok((await owner.outboxEvent.findUniqueOrThrow({ where: { eventId } })).quarantinedAt)
  } finally {
    await runtime.$disconnect()
  }
})

async function ageSimulationRun(runId: string, days: number) {
  const createdAt = new Date((await databaseNow()) - days * 86_400_000)
  const run = await owner.agentRun.update({ where: { id: runId }, data: { createdAt } })
  const inbound = await owner.inboundEvent.update({ where: { id: run.inboundEventId }, data: { receivedAt: createdAt } })
  await owner.simulatedDraft.updateMany({ where: { runId }, data: { createdAt } })
  return inbound
}

async function drainSimulationRetention(runtime: ReturnType<typeof createDatabase>) {
  while (await sweepSimulationRetention(runtime) > 0) { /* Drain the fixture batches. */ }
}

test('simulation retention removes bodies and references at separate cutoffs while preserving deduplication and receipts', async () => {
  const identityId = await reflectionIdentity()
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const archived = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const redacted = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const fresh = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    await executeSimulation(executor, archived.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: archived.id } }), 1)
    const inbound = await ageSimulationRun(archived.runId, 91)
    await ageSimulationRun(redacted.runId, 31)
    await ageSimulationRun(fresh.runId, 29)
    assert.ok(await owner.contextSnapshot.count({ where: { runId: archived.runId } }) > 0)
    await Promise.all([drainSimulationRetention(runtime), drainSimulationRetention(runtime)])
    assert.equal(await sweepSimulationRetention(runtime), 0)

    for (const { runId } of [archived, redacted, fresh]) {
      const run = await owner.agentRun.findUniqueOrThrow({ where: { id: runId }, include: { inboundEvent: true, draft: true } })
      const bodyRetained = runId === fresh.runId
      assert.equal(run.inboundEvent.messageText !== null, bodyRetained)
      assert.equal(run.draft?.content != null, bodyRetained)
      assert.equal(run.referencesExpiredAt !== null, runId === archived.runId)
    }
    assert.equal(await owner.contextSnapshot.count({ where: { runId: archived.runId } }), 0)
    assert.ok(await owner.contextSnapshot.count({ where: { runId: redacted.runId } }) > 0)
    const archivedDraft = await owner.simulatedDraft.findUniqueOrThrow({ where: {
      characterId_runId: { characterId: a, runId: archived.runId },
    } })
    assert.deepEqual(archivedDraft.writingEvidenceIds, [])
    assert.deepEqual(archivedDraft.decisionEvidenceIds, [])
    assert.deepEqual(archivedDraft.citationIds, [])
    const replay = await request('GET', characterPath(a) + '/runs/' + archived.runId + '/replay')
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.ok(replay.body.referencesExpiredAt)
    assert.deepEqual(replay.body.snapshots, [])
    assert.deepEqual(replay.body.beliefRefs, [])
    assert.deepEqual(replay.body.goalRefs, [])
    assert.equal(replay.body.proposal.attemptStatus, 'CONFIRMED')
    assert.ok(replay.body.proposal.receiptAt)
    assert.equal(await recordSimulationReceipt(executor, archived.id), true)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: archived.id } }), 1)

    const duplicate = await ingestSimulatedEvent(runtime, {
      accountId: inbound.accountId, conversationId: inbound.conversationId!, sourceKey: inbound.sourceKey,
      kind: inbound.kind, messageText: 'Retried original inbound', occurredAt: inbound.occurredAt,
    })
    assert.deepEqual(duplicate, { status: 'DUPLICATE', runId: archived.runId })
    const expired = await request('GET', actionPath(redacted.id), { actor: 'reviewer' })
    assert.equal(expired.body.content, null)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('retention preserves unknown-delivery reconciliation and stops an expired run from rebuilding drafts', async () => {
  const identityId = await reflectionIdentity()
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const unknown = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    await assert.rejects(executeSimulation(executor, unknown.id, simulationPlatforms.resolveAdapter, async () => { throw new Error('synthetic lost outcome') }))
    await owner.simulationAttempt.update({
      where: { actionId: unknown.id }, data: { permitUntil: new Date((await databaseNow()) - 16 * 60_000) },
    })
    await ageSimulationRun(unknown.runId, 91)
    const pending = await prepareTopic(runtime, await topicAccount(identityId, 'mock-b'), 'Retention of pending run')
    const inbound = await ageSimulationRun(pending.runId, 91)
    await drainSimulationRetention(runtime)
    const scrubbed = await owner.inboundEvent.findUniqueOrThrow({ where: { id: inbound.id } })
    assert.equal(scrubbed.messageText, null)
    assert.ok(scrubbed.bodyExpiredAt)
    assert.equal(scrubbed.adapterId, 'mock-b')

    const path = actionPath(unknown.id) + '/reconciliation'
    const proof = await request('GET', path)
    assert.equal(proof.status, 200)
    assert.equal(proof.body.outcome, 'DEFINITELY_NOT_SENT')
    assert.ok(proof.body.evidenceRef)
    const resolved = await request('POST', path, {
      key: 'retained-unknown-ledger', ifMatch: proof.headers.get('etag') ?? '',
      data: { outcome: proof.body.outcome, evidenceRef: proof.body.evidenceRef, reason: 'Checked retained ledger' },
    })
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body))
    assert.equal(resolved.body.status, 'BLOCKED')
    await processSimulatedDraft(runtime, pending.eventId, simulationPlatforms.resolveAdapter, {
      ...simulatedModelPlugin,
      implementation: {
        ...simulatedModelPlugin.implementation,
        async decide() { return assert.fail('Expired run reached the model') },
      },
    })
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: pending.runId } })).state, 'EXPIRED')
    assert.equal(await owner.contextSnapshot.count({ where: { runId: pending.runId } }), 0)
    assert.equal(await owner.actionProposal.count({ where: { runId: pending.runId } }), 0)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

const duplicateReview = { similarityPercent: 75, windowHours: 2 }

test('cross-platform near duplicates only flag opted-in public topics in the same identity', async () => {
  const identityId = await reflectionIdentity({ duplicateReview })
  const separate = await reflectionIdentity({ duplicateReview })
  const disabled = await reflectionIdentity()
  const first = await topicAccount(identityId, 'mock-a')
  const second = await topicAccount(identityId, 'mock-b')
  const privateTopic = await topicAccount(identityId, 'mock-a', true)
  const other = await topicAccount(separate, 'mock-b')
  const offA = await topicAccount(disabled, 'mock-a')
  const offB = await topicAccount(disabled, 'mock-b')
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const text = 'Regional railway maintenance begins this Friday evening.'
    const original = await topicProposal(runtime, first, text)
    assert.equal(original.crossPlatformDuplicate, false)
    const near = await topicProposal(runtime, second, 'Regional railway maintenance begins this Friday evening, soon.')
    assert.equal(near.crossPlatformDuplicate, true)
    const preview = await request('GET', actionPath(near.id), { actor: 'reviewer' })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.ok(preview.body.riskCodes.includes('CROSS_PLATFORM_NEAR_DUPLICATE'))
    assert.equal(preview.body.target.accountId, second.account.id)
    assert.equal(JSON.stringify(preview.body).includes(first.account.id), false)
    assert.equal((await topicProposal(runtime, other, text)).crossPlatformDuplicate, false)
    assert.equal((await topicProposal(runtime, offA, text)).crossPlatformDuplicate, false)
    assert.equal((await topicProposal(runtime, offB, text)).crossPlatformDuplicate, false)

    const secret = 'Private autumn gardening notes for the community workshop.'
    assert.equal((await topicProposal(runtime, privateTopic, secret)).crossPlatformDuplicate, false)
    assert.equal((await topicProposal(runtime, second, secret)).crossPlatformDuplicate, false)
  } finally {
    await runtime.$disconnect()
  }
})

function metricsPath(characterId: string, from: string, through: string) {
  return characterPath(characterId) + '/monitoring/daily?from=' + from + '&through=' + through
}

async function reviewTopic(characterId: string, action: { id: string; reviewDigest: string }, decision: 'APPROVE' | 'REJECT') {
  const response = await request('POST', characterPath(characterId) + '/actions/' + action.id + '/decisions', {
    actor: 'reviewer', key: 'm4-' + action.id, ifMatch: '"run-v3"',
    data: { decision, reviewDigest: action.reviewDigest, reason: 'M4 simulation evaluation' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
}

test('M4 evaluates fourteen simulated days of scope, duplicate reviews, frequency and intervention', { timeout: 90_000 }, async () => {
  const created = await request('POST', '/characters', { key: 'm4-history', data: characterData('-history') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const role = await request('POST', characterPath(characterId) + '/memberships', {
    key: 'history-reviewer', data: { subject: 'reviewer', role: 'REVIEWER', action: 'GRANT', reason: 'History fixture' },
  })
  assert.equal(role.status, 200, JSON.stringify(role.body))
  const identityId = await reflectionIdentity({ duplicateReview }, characterId)
  const restrictedIdentity = await reflectionIdentity({}, characterId)
  await owner.character.update({ where: { id: characterId }, data: { timezone: simulationZone(12) } })
  const first = await topicAccount(identityId, 'mock-a', false, characterId)
  const second = await topicAccount(identityId, 'mock-b', false, characterId)
  const marker = 'M4_FORBIDDEN_' + randomUUID()
  const memory = await owner.memory.create({
    data: {
      characterId, identityId: restrictedIdentity, scope: 'IDENTITY', visibility: 'CONFIDENTIAL', importance: 1,
      content: 'Regional railway maintenance begins this Friday evening ' + marker,
    },
  })
  const source = await owner.sourceRecord.create({
    data: { characterId, identityId: restrictedIdentity, kind: 'fixture', sourceKey: randomUUID(), classification: 'CONFIDENTIAL' },
  })
  await owner.memorySource.create({ data: { characterId, memoryId: memory.id, sourceId: source.id } })

  let modelInputs = 0
  const model: typeof simulatedModelPlugin = {
    ...simulatedModelPlugin,
    implementation: {
      async decide(input, signal) {
        modelInputs++
        assert.equal(JSON.stringify(input).includes(marker), false)
        return simulatedModelPlugin.implementation.decide(input, signal)
      },
      async write(input, signal) {
        modelInputs++
        assert.equal(JSON.stringify(input).includes(marker), false)
        return simulatedModelPlugin.implementation.write(input, signal)
      },
    },
  }
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  const lastDay = new Date((await databaseNow()) - 2 * 86_400_000)
  lastDay.setUTCHours(12, 0, 0, 0)
  const firstDay = new Date(lastDay.getTime() - 13 * 86_400_000)
  const utc = (value: Date) => value.toISOString().slice(0, 10)
  try {
    for (let day = 0; day < 14; day++) {
      const date = new Date(firstDay.getTime() + day * 86_400_000)
      const topic = 'Regional railway maintenance begins this Friday evening for district ' + (day + 1)
      const action = await topicProposal(runtime, first, topic, model)
      const duplicate = await topicProposal(runtime, second, topic + ', soon.', model)
      assert.equal(action.crossPlatformDuplicate, false)
      assert.equal(duplicate.crossPlatformDuplicate, true)
      for (const proposal of [action, duplicate]) {
        const review = await request('GET', characterPath(characterId) + '/actions/' + proposal.id, { actor: 'reviewer' })
        assert.equal(review.status, 200)
        assert.ok(review.body.content)
        assert.equal(review.body.content.includes(marker), false)
      }
      await reviewTopic(characterId, action, 'APPROVE')
      if (day >= 7) await reviewTopic(characterId, duplicate, 'REJECT')
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      await executeSimulation(executor, duplicate.id, simulationPlatforms.resolveAdapter)
      assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 1)
      assert.equal(await owner.simulationReceipt.count({ where: { actionId: duplicate.id } }), 0)

      // The real simulation pipeline runs above. Only the fixture's observed times are shifted into the virtual day.
      await owner.$transaction(async (tx) => {
        const ids = [action.runId, duplicate.runId]
        const runs = await tx.agentRun.findMany({ where: { id: { in: ids } }, select: { inboundEventId: true } })
        await tx.inboundEvent.updateMany({
          where: { id: { in: runs.map(({ inboundEventId }) => inboundEventId) } }, data: { receivedAt: date },
        })
        await tx.agentRun.updateMany({ where: { id: { in: ids } }, data: { createdAt: date } })
        await tx.actionProposal.updateMany({
          where: { id: { in: [action.id, duplicate.id] } }, data: { createdAt: new Date(date.getTime() + 500) },
        })
        await tx.simulationReceipt.update({ where: { actionId: action.id }, data: { createdAt: date } })
        await tx.simulationAttempt.update({ where: { actionId: action.id }, data: { windowStart: date } })
      })
    }
    assert.equal(modelInputs, 56)
    assert.equal(await owner.contextSnapshotEvidence.count({ where: { characterId, memoryId: memory.id } }), 0)
    const path = metricsPath(characterId, utc(firstDay), utc(lastDay))
    const report = await request('GET', path)
    assert.equal(report.status, 200, JSON.stringify(report.body))
    assert.equal(report.body.days.length, 14)
    assert.deepEqual(report.body.alerts, ['REVIEW_RATE_DRIFT'])
    for (const [index, row] of report.body.days.entries()) {
      assert.equal(row.utcDay, utc(new Date(firstDay.getTime() + index * 86_400_000)))
      assert.equal(row.proposals, 2)
      assert.equal(row.approvals, 1)
      assert.equal(row.rejections, Number(index >= 7))
      assert.equal(row.duplicateFlags, 1)
      assert.equal(row.receipts, 1)
      assert.equal(row.peakAccountReceipts, 1)
      assert.equal(row.flaggedReceipts, 0)
      assert.equal(row.receiptsWithoutApproval, 0)
    }
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    assert.equal(JSON.stringify(report.body).includes(marker), false)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('concurrent model calls share one enforced character budget and report the denial', async () => {
  const budget = 21_000
  const created = await request('POST', '/characters', {
    key: 'm4-budget', data: { ...characterData('-budget'), coreProfile: { aiDisclosure: 'AI role', dailyModelBudget: budget } },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const identityId = await reflectionIdentity({}, characterId)
  const target = await topicAccount(identityId, 'mock-a', false, characterId)
  const runtime = createDatabase(scheduleRuntimeUrl())
  let decisions = 0
  let writes = 0
  const model: typeof simulatedModelPlugin = {
    ...simulatedModelPlugin,
    implementation: {
      async decide(input, signal) {
        decisions++
        return simulatedModelPlugin.implementation.decide(input, signal)
      },
      async write(input, signal) {
        writes++
        return simulatedModelPlugin.implementation.write(input, signal)
      },
    },
  }
  try {
    const runs = await Promise.all(['first budget input', 'second budget input'].map((text) => prepareTopic(runtime, target, text)))
    await Promise.all(runs.map(({ eventId }) => processSimulatedDraft(runtime, eventId, simulationPlatforms.resolveAdapter, model)))
    assert.equal(decisions, 2)
    assert.equal(writes, 1)
    assert.equal(await owner.actionProposal.count({ where: { characterId } }), 1)
    const day = new Date(await databaseNow()).toISOString().slice(0, 10)
    const report = await request('GET', metricsPath(characterId, day, day))
    assert.equal(report.status, 200, JSON.stringify(report.body))
    assert.deepEqual(report.body.alerts, ['MODEL_BUDGET_EXHAUSTED'])
    assert.equal(report.body.days[0].modelCalls, 3)
    assert.equal(report.body.days[0].budgetDenials, 1)
    assert.ok(report.body.days[0].reservedUnits <= budget)
  } finally {
    await runtime.$disconnect()
  }
})

test('Newbi pilot binds an agent, enforces independent approval and recovers the original remote receipt', { timeout: 30_000 }, async () => {
  const agentId = randomUUID()
  let currentAgent = agentId
  const postId = randomUUID()
  const secret = 'nbi_agent_' + 'x'.repeat(43)
  const sent = new Map<string, { id: string; content: string }>()
  let writes = 0
  let reads = 0
  let dropResponse = false
  let preflightLimit = false
  let writeFailure: 'LIMIT' | 'LOCKED' | 'DROP' | undefined
  let locked = false
  const server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0]
    const reply = (data: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ code: 0, data }))
    if (path === '/agent-api/v1/status') return reply({ state: 'OPEN', protocolVersion: 1 })
    if (req.headers.authorization !== 'Bearer ' + secret) return res.writeHead(401).end()
    if (path === '/agent-api/v1/me') {
      if (preflightLimit) return res.writeHead(429, { 'Retry-After': '30' }).end()
      return reply({ id: currentAgent, username: 'fixture-agent', accessStatus: 'ACTIVE' })
    }
    if (path === '/agent-api/v1/rules') return reply({ idempotencyDays: 7 })
    if (path === '/agent-api/v1/quota') return reply({ comments: [{ remaining: 5 }] })
    if (path === '/agent-api/v1/posts/' + postId) {
      reads++
      return reply({ id: postId, title: 'Fixture discussion', content: 'Original context', isHidden: false, isLocked: locked })
    }
    if (path === '/agent-api/v1/posts/' + postId + '/comments') {
      if (req.method === 'GET') {
        reads++
        return reply({ items: [], nextCursor: null, hasMore: false })
      }
      writes++
      if (writeFailure === 'LIMIT') return res.writeHead(429, { 'Retry-After': '30' }).end()
      if (writeFailure === 'LOCKED') return res.writeHead(409).end(JSON.stringify({ errorCode: 'POST_LOCKED' }))
      const key = req.headers['idempotency-key']
      if (typeof key !== 'string') return res.writeHead(400).end()
      let body = ''
      for await (const chunk of req) body += chunk
      const { content } = JSON.parse(body) as { content: string }
      const previous = sent.get(key)
      if (previous && previous.content !== content) return res.writeHead(409).end()
      const id = previous?.id ?? randomUUID()
      sent.set(key, { id, content })
      if (writeFailure === 'DROP' || (dropResponse && !previous)) return res.destroy()
      return reply({ id, postId, replayed: !!previous }, 201)
    }
    return res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const endpoint = 'http://localhost:' + port + '/agent-api/v1'
  const executorUrl = new URL(config.databaseUrl)
  executorUrl.searchParams.set('options', '-c role=rica_newbi_executor')
  const executor = createDatabase(executorUrl.toString())
  try {
    const identityId = await reflectionIdentity()
    const prefix = characterPath(a) + '/newbi'
    const binding = await request('POST', prefix + '/accounts', { key: 'newbi-test-bind', data: { identityId, agentId, endpoint } })
    assert.equal(binding.status, 201, JSON.stringify(binding.body))
    const accountId = binding.body.id
    assert.equal(binding.body.status, 'PAUSED')
    const resume = (key: string, actor = 'admin-a') => request('POST', characterPath(a) + '/controls', { actor, key,
      data: { scope: 'ACCOUNT', scopeId: accountId, operation: 'RESUME', reason: 'Local protocol fixture' } })
    connectorEnv = { RICA_NEWBI_LOCAL_API_URL: endpoint, NEWBI_AGENT_KEY: secret }
    assert.equal((await resume('newbi-reviewer-resume', 'reviewer')).status, 403)
    currentAgent = randomUUID()
    const unverified = await resume('newbi-test-resume')
    assert.equal(unverified.status, 409, JSON.stringify(unverified.body))
    assert.equal(unverified.body.error.code, 'CONNECTOR_VERIFICATION_FAILED')
    assert.equal((await owner.platformAccount.findUniqueOrThrow({ where: { id: accountId } })).status, 'PAUSED')
    currentAgent = agentId
    const resumed = await resume('newbi-test-resume')
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    connectorEnv = {}
    assert.equal((await resume('newbi-test-resume')).status, 200)
    assert.equal(writes, 0)
    const client = createNewbiReplyExecutor(endpoint, secret)
    const executorKey = newbiExecutorKey(newbiExecutorIdentity)
    const inspector = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/newbi-pilot.ts', 'inspect', postId], {
      env: { ...process.env, RICA_NEWBI_LOCAL_API_URL: endpoint, NEWBI_AGENT_KEY: secret },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let inspected = ''
    let diagnostics = ''
    inspector.stdout.setEncoding('utf8').on('data', (chunk: string) => { inspected += chunk })
    inspector.stderr.setEncoding('utf8').on('data', (chunk: string) => { diagnostics += chunk })
    const [inspectionExit] = await once(inspector, 'close')
    assert.equal(inspectionExit, 0, diagnostics)
    assert.match(diagnostics, /"kind":"platform-reader".*"code":"READY"/)
    assert.equal(JSON.parse(inspected).post.content, 'Original context')
    assert.equal(writes, 0)

    const propose = async (text: string, key: string) => {
      const created = await request('POST', prefix + '/replies', { key, data: { accountId, postId, content: text } })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const id: string = created.body.id
      const path = prefix + '/replies/' + id
      const preview = await request('GET', path, { actor: 'reviewer' })
      assert.equal(preview.status, 200, JSON.stringify(preview.body))
      assert.equal(preview.body.agentId, agentId)
      assert.equal(preview.body.identity, (await owner.identity.findUniqueOrThrow({ where: { id: identityId } })).slug)
      assert.equal(preview.body.postId, postId)
      assert.equal(preview.body.accountId, accountId)
      assert.equal(preview.body.content.split('\n\nAI 披露：')[0], text)
      const decide = (decision: 'APPROVE' | 'REJECT', actor = 'reviewer') => request('POST', path + '/decision', {
        actor, key: randomUUID(), data: { decision, reviewDigest: preview.body.reviewDigest, reason: 'Checked bound reply' },
      })
      return { id, path, decide, content: preview.body.content }
    }
    const denied = await propose('Rejected fixture text', 'newbi-denied')
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, denied.id), { status: 'UNAVAILABLE' })
    assert.equal((await denied.decide('REJECT')).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, denied.id), { status: 'UNAVAILABLE' })
    assert.equal(writes, 0)
    await assert.rejects(executor.newbiReply.count(), /permission denied/i)

    const approved = await propose('Ordinary fixture reply', 'newbi-success')
    const queuePath = prefix + '/replies'
    const waitingQueue = await request('GET', queuePath + '?status=WAITING', { actor: 'reviewer' })
    assert.equal(waitingQueue.status, 200, JSON.stringify(waitingQueue.body))
    assert.deepEqual((await request('GET', queuePath + '?status=WAITING&accountId=' + accountId)).body, waitingQueue.body)
    assert.deepEqual((await request('GET', queuePath + '?accountId=' + accountA)).body, { items: [], nextCursor: null })
    assert.deepEqual(waitingQueue.body.items.map((item: { id: string }) => item.id), [approved.id])
    assert.deepEqual(Object.keys(waitingQueue.body.items[0]).sort(), ['agentId', 'createdAt', 'id', 'identity', 'postId', 'status'])
    assert.equal((await request('GET', queuePath, { actor: 'admin-b' })).status, 404)
    assert.equal((await request('GET', queuePath + '?status=WAITING&cursor=' + denied.id)).status, 422)
    const firstPage = await request('GET', queuePath + '?limit=1')
    assert.equal(firstPage.body.items.length, 1)
    assert.equal(firstPage.body.nextCursor, firstPage.body.items[0].id)
    const secondPage = await request('GET', queuePath + '?limit=1&cursor=' + firstPage.body.nextCursor)
    assert.deepEqual([...firstPage.body.items, ...secondPage.body.items].map((item: { id: string }) => item.id).sort(),
      [approved.id, denied.id].sort())
    assert.equal(secondPage.body.nextCursor, null)
    assert.equal((await approved.decide('APPROVE', 'admin-a')).status, 403)
    await assert.rejects(management.$executeRaw`
      UPDATE public.newbi_replies SET status = 'READY', reviewer_id = 'unbound-reviewer' WHERE id = ${approved.id}::uuid
    `, /Approval must bind the reply executor/)
    assert.equal((await approved.decide('APPROVE')).status, 200)
    const nextExecutor = newbiExecutorKey({ ...newbiExecutorIdentity, version: '2.0.0' })
    const readCount = reads
    assert.deepEqual(await executeNewbiReply(executor, client, nextExecutor, approved.id), { status: 'UNAVAILABLE' })
    assert.equal(reads, readCount)
    const [foreignClaim] = await executor.$queryRaw<{ claim: unknown }[]>`
      SELECT public.rica_claim_newbi_reply(${approved.id}::uuid,false,${agentId}::uuid,${endpoint},${nextExecutor}) AS claim
    `
    assert.equal(foreignClaim.claim, null)
    currentAgent = randomUUID()
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, approved.id), { status: 'UNAVAILABLE' })
    assert.equal(writes, 0)
    currentAgent = agentId
    const send = async (id: string, key: string, ...args: string[]) => {
      const processResult = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/newbi-pilot.ts', 'send', id, ...args], {
        env: { ...process.env, RICA_NEWBI_LOCAL_API_URL: endpoint, NEWBI_AGENT_KEY: key,
          RICA_NEWBI_EXECUTION_DATABASE_URL: executorUrl.toString() },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      processResult.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      processResult.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      const [code] = await once(processResult, 'close')
      return { code, stdout, stderr }
    }
    const missing = await send(approved.id, '')
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /"kind":"platform-reply-executor".*"code":"MISSING_SERVICE"/)
    assert.equal(missing.stdout, '')
    assert.equal(writes, 0)
    assert.equal((await request('GET', approved.path)).body.attempts, 0)

    const normal = await send(approved.id, secret)
    assert.equal(normal.code, 0, normal.stderr)
    assert.match(normal.stderr, /"kind":"platform-reply-executor".*"code":"READY"/)
    assert.ok(!normal.stderr.includes(secret))
    assert.deepEqual(JSON.parse(normal.stdout), { status: 'SENT', commentId: sent.get(approved.id)?.id })
    assert.equal((await request('GET', approved.path)).body.remoteCommentId, sent.get(approved.id)?.id)
    assert.equal(writes, 1)

    const lost = await propose('Lost response fixture reply', 'newbi-unknown')
    assert.equal((await lost.decide('APPROVE')).status, 200)
    dropResponse = true
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, lost.id), { status: 'UNKNOWN' })
    assert.equal((await request('GET', lost.path)).body.status, 'UNKNOWN')
    assert.equal(sent.get(lost.id)?.content, lost.content)
    const waiting = await propose('Fixture queued behind unknown result', 'newbi-waiting')
    assert.equal((await waiting.decide('APPROVE')).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, waiting.id), { status: 'UNAVAILABLE' })
    assert.equal(writes, 2)
    assert.deepEqual(await executeNewbiReply(executor, client, nextExecutor, lost.id, true), { status: 'UNAVAILABLE' })
    const withoutRetry = await send(lost.id, secret)
    assert.equal(withoutRetry.code, 1, withoutRetry.stderr)
    assert.deepEqual(JSON.parse(withoutRetry.stdout), { status: 'UNAVAILABLE' })
    assert.equal(writes, 2)
    const recovered = await send(lost.id.toUpperCase(), secret, '--retry')
    assert.equal(recovered.code, 0, recovered.stderr)
    assert.deepEqual(JSON.parse(recovered.stdout), { status: 'SENT', commentId: sent.get(lost.id)?.id })
    const receipt = await request('GET', lost.path)
    assert.equal(receipt.body.remoteCommentId, sent.get(lost.id)?.id)
    assert.equal(receipt.body.attempts, 2)
    assert.equal(sent.size, 2)
    assert.equal(writes, 3)
    assert.ok(reads >= 8)

    // Invalid credentials and locked threads never reach the comment endpoint.
    const invalidClient = createNewbiReplyExecutor(endpoint, 'nbi_agent_' + 'y'.repeat(43))
    assert.deepEqual(await executeNewbiReply(executor, invalidClient, executorKey, waiting.id),
      { status: 'UNAVAILABLE', reason: 'CREDENTIAL_INVALID' })
    assert.equal((await request('GET', waiting.path)).body.attempts, 0)
    locked = true
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, waiting.id), { status: 'CLOSED', reason: 'POST_LOCKED' })
    assert.equal((await request('GET', waiting.path)).body.status, 'CLOSED')
    assert.equal(writes, 3)
    locked = false

    // A 429 during preflight costs no write, and both kinds of 429 block early calls across the account.
    const limited = await propose('Rate-limited fixture reply', 'newbi-limited')
    assert.equal((await limited.decide('APPROVE')).status, 200)
    preflightLimit = true
    const limitTime = Date.now()
    const preflight = await executeNewbiReply(executor, client, executorKey, limited.id)
    assert.equal(preflight.status, 'UNAVAILABLE')
    assert.ok('reason' in preflight && preflight.reason === 'RATE_LIMITED')
    let preview = (await request('GET', limited.path)).body
    assert.equal(preview.attempts, 0)
    assert.ok(Date.parse(preview.retryNotBefore) >= limitTime + 30_000)
    const unrelated = await propose('Fixture reply behind a cooldown', 'newbi-cooldown')
    assert.equal((await unrelated.decide('APPROVE')).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, unrelated.id),
      { status: 'UNAVAILABLE', retryNotBefore: preview.retryNotBefore })
    assert.equal(writes, 3)
    preflightLimit = false
    const passCooldown = () => owner.newbiReply.update({ where: { id: limited.id }, data: { retryNotBefore: new Date(0) } })
    await passCooldown()
    writeFailure = 'LIMIT'
    const rateLimited = await executeNewbiReply(executor, client, executorKey, limited.id)
    assert.equal(rateLimited.status, 'UNKNOWN')
    assert.ok('reason' in rateLimited && rateLimited.reason === 'RATE_LIMITED')
    preview = (await request('GET', limited.path)).body
    assert.equal(preview.attempts, 1)
    assert.ok(Date.parse(preview.retryNotBefore) > Date.now() + 29_000)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true),
      { status: 'UNAVAILABLE', retryNotBefore: preview.retryNotBefore })
    assert.equal(writes, 4)

    // A lost response followed by a lock conflict cannot be treated as a confirmed failure.
    await passCooldown()
    writeFailure = 'DROP'
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNKNOWN' })
    writeFailure = 'LOCKED'
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNKNOWN', reason: 'POST_LOCKED' })
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNAVAILABLE' })
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, unrelated.id), { status: 'UNAVAILABLE' })
    assert.equal(sent.get(limited.id)?.content, limited.content)
    assert.equal(writes, 6)

    const closeReason = 'Checked the discussion and ended delivery attempts'
    const close = (actor: string, key: string, path = limited.path) => request('POST', path + '/close',
      { actor, key, data: { reason: closeReason } })
    assert.equal((await close('reviewer', 'newbi-close-reviewer')).status, 403)
    assert.equal((await close('admin-a', 'newbi-close-ready', unrelated.path)).status, 409)
    assert.equal((await close('admin-a', 'newbi-close')).status, 200)
    assert.equal((await close('admin-a', 'newbi-close')).status, 200)
    preview = (await request('GET', limited.path)).body
    assert.equal(preview.status, 'CLOSED')
    assert.equal(preview.attempts, 3)
    assert.equal(preview.closureReason, closeReason)
    assert.equal(preview.remoteCommentId, null)
    assert.equal(await owner.managementAudit.count({ where: { targetId: limited.id, operation: 'newbi.reply.close' } }), 1)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNAVAILABLE' })
    dropResponse = false
    writeFailure = 'LOCKED'
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, unrelated.id), { status: 'CLOSED', reason: 'POST_LOCKED' })
    assert.equal((await request('GET', unrelated.path)).body.status, 'CLOSED')
    assert.equal(writes, 7)
    const paused = await propose('Pause blocks new permits', 'newbi-pause-fixture')
    assert.equal((await paused.decide('APPROVE')).status, 200)
    assert.equal((await request('POST', characterPath(a) + '/controls', { key: 'newbi-test-pause',
      data: { scope: 'ACCOUNT', scopeId: accountId, operation: 'PAUSE', reason: 'Check claim boundary' } })).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, paused.id), { status: 'UNAVAILABLE' })
    assert.equal((await request('GET', paused.path)).body.attempts, 0)
    assert.equal(writes, 7)
  } finally {
    connectorEnv = {}
    await executor.$disconnect()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('Newbi event polling checkpoints empty and replayed pages, backs off, and fences revoked work', { timeout: 30_000 }, async () => {
  const agentId = randomUUID()
  const postId = randomUUID()
  const commentId = randomUUID()
  const secret = 'nbi_agent_' + 'z'.repeat(43)
  const cursors: (string | null)[] = []
  const opaque = 'cursor/? +&=汉'
  let verifiedAgent = agentId
  const seq = '9007199254740993'
  const event = { seq, type: 'COMMENT_REPLIED', postId, commentId, createdAt: new Date().toISOString() }
  let mode: 'PAGES' | 'LIMIT' | 'EXPIRED' | 'RESUME' | 'PAUSE' = 'PAGES'
  let releasePage!: () => void
  const holdPage = new Promise<void>((resolve) => { releasePage = resolve })
  let confirmRequest!: () => void
  const requestEntered = new Promise<void>((resolve) => { confirmRequest = resolve })
  let calls = 0
  let writes = 0
  const server = createServer(async (req, res) => {
    calls++
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (data: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
    const reply = (data: unknown) => json({ code: 0, data })
    if (req.method !== 'GET') { writes++; return res.writeHead(405).end() }
    if (url.pathname.endsWith('/status')) return reply({ state: 'READ_ONLY', protocolVersion: 1 })
    if (req.headers.authorization !== 'Bearer ' + secret) return res.writeHead(401).end()
    if (url.pathname.endsWith('/me')) return reply({ id: verifiedAgent, username: 'fixture-events', accessStatus: 'ACTIVE' })
    if (url.pathname.endsWith('/rules')) return reply({ idempotencyDays: 7, pollIntervalSeconds: 30 })
    if (url.pathname.endsWith('/quota')) return reply({ comments: [{ remaining: 0 }] })
    if (!url.pathname.endsWith('/events')) return res.writeHead(404).end()
    const cursor = url.searchParams.get('cursor')
    cursors.push(cursor)
    if (mode === 'LIMIT') return res.writeHead(429, { 'Retry-After': '30' }).end()
    if (mode === 'EXPIRED') return json({ errorCode: 'EVENT_CURSOR_EXPIRED', data: { historyLost: true, resetCursor: 'reset' } }, 410)
    if (mode === 'RESUME') return reply({ items: [], nextCursor: 'after-reset', hasMore: false })
    if (mode === 'PAUSE') {
      confirmRequest()
      await holdPage
      return reply({ items: [{ ...event, seq: '9007199254740999' }], nextCursor: 'discarded', hasMore: false })
    }
    if (cursor === null) return reply({ items: [], nextCursor: opaque, hasMore: true })
    if (cursor === opaque) return reply({ items: [event], nextCursor: 'next-page', hasMore: true })
    if (cursor === 'next-page') return reply({ items: [event, { ...event, seq: '9007199254740995' }], nextCursor: 'tail', hasMore: false })
    return res.writeHead(400).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const endpoint = 'http://localhost:' + port + '/agent-api/v1'
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_newbi_poller')
  const db = createDatabase(url.toString())
  const runtime = createDatabase(scheduleRuntimeUrl())
  let worker: ReturnType<typeof spawn> | undefined
  const readerEnv = { RICA_NEWBI_LOCAL_API_URL: endpoint, NEWBI_AGENT_KEY: secret }
  const host = await startNewbiReader(readerEnv)
  try {
    const identityId = await reflectionIdentity()
    const character = characterPath(a)
    const bind = await request('POST', character + '/newbi/accounts', { key: 'newbi-events-bind', data: { identityId, agentId, endpoint } })
    assert.equal(bind.status, 201, JSON.stringify(bind.body))
    const accountId: string = bind.body.id
    const reader = host.plugin.implementation
    assert.equal('comment' in reader, false)
    const poll = () => pollNewbiEvents(db, reader, accountId)
    const account = () => owner.newbiEventCheckpoint.findUniqueOrThrow({ where: { accountId } })
    const dueNow = () => owner.newbiEventCheckpoint.update({ where: { accountId }, data: { nextPollAt: new Date(0) } })
    const control = (operation: 'PAUSE' | 'RESUME') => request('POST', character + '/controls', { key: randomUUID(),
      data: { scope: 'ACCOUNT', scopeId: accountId, operation, reason: 'Event polling fixture' } })
    const inbox = '/newbi/accounts/' + accountId + '/events'

    assert.deepEqual(await poll(), { status: 'STOPPED' })
    assert.equal(calls, 0)
    connectorEnv = readerEnv
    assert.equal((await control('RESUME')).status, 200)
    connectorEnv = {}
    await assert.rejects(startNewbiReader({ RICA_NEWBI_LOCAL_API_URL: endpoint }), /MISSING_SERVICE/)
    await assert.rejects(startNewbiReader({ ...readerEnv, RICA_NEWBI_LOCAL_API_URL: 'https://fixture.example/agent-api/v1' }),
      /INVALID_CONFIG/)
    verifiedAgent = randomUUID()
    assert.deepEqual(await poll(), { status: 'STOPPED' })
    assert.deepEqual(cursors, [])
    assert.equal((await request('GET', character + inbox)).body.readError, 'AGENT_MISMATCH')
    verifiedAgent = agentId
    const badHost = await startNewbiReader({ ...readerEnv, NEWBI_AGENT_KEY: 'nbi_agent_' + 'x'.repeat(43) })
    try {
      await assert.rejects(pollNewbiEvents(db, badHost.plugin.implementation, accountId), /CREDENTIAL_INVALID/)
    } finally {
      await badHost.stop()
    }
    assert.equal((await account()).cursor, null)
    assert.equal((await request('GET', character + inbox)).body.readError, 'CREDENTIAL_INVALID')
    assert.deepEqual(cursors, [])
    assert.equal((await poll()).status, 'READ')
    assert.equal((await account()).cursor, opaque)
    assert.deepEqual(cursors, [null])

    worker = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/newbi-pilot.ts', 'events', accountId, '--for-seconds', '5'], {
      env: { ...process.env, ...readerEnv, RICA_NEWBI_POLL_DATABASE_URL: url.toString() },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    worker.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    worker.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    const [exit] = await once(worker, 'close')
    assert.equal(exit, 0, output)
    assert.match(output, /"kind":"platform-reader".*"code":"READY"/)
    assert.deepEqual(cursors, [null, opaque, 'next-page'])
    const caughtUp = await account()
    assert.equal(caughtUp.cursor, 'tail')
    assert.ok(caughtUp.nextPollAt.getTime() > Date.now() + 20_000)
    const firstInbox = await request('GET', character + inbox)
    assert.equal(firstInbox.status, 200, JSON.stringify(firstInbox.body))
    assert.deepEqual(firstInbox.body.items.map((item: { seq: string }) => item.seq).sort(), [seq, '9007199254740995'])
    assert.equal(firstInbox.body.cursor, undefined)
    assert.equal(firstInbox.body.readError, null)
    assert.equal(firstInbox.body.agentId, agentId)
    assert.equal(Date.parse(firstInbox.body.lastSucceededAt), caughtUp.lastSucceededAt?.getTime())
    const auditorInbox = await request('GET', character + inbox, { actor: 'auditor' })
    assert.equal(auditorInbox.status, 200, JSON.stringify(auditorInbox.body))
    assert.equal(auditorInbox.body.lastSucceededAt, firstInbox.body.lastSucceededAt)
    assert.equal(auditorInbox.body.items, null)
    assert.equal(JSON.stringify(firstInbox.body).includes(secret), false)
    await assert.rejects(management.$queryRaw`SELECT cursor FROM public.newbi_event_checkpoints`, /permission denied/i)
    assert.equal((await request('GET', character + inbox, { actor: 'reviewer' })).status, 403)
    assert.equal((await request('GET', characterPath(b) + inbox, { actor: 'admin-b' })).status, 404)
    await assert.rejects(db.newbiEvent.count(), /permission denied/i)
    await assert.rejects(db.$queryRaw`SELECT public.rica_claim_newbi_reply(null,false,null,null,null)`, /permission denied/i)

    await dueNow()
    mode = 'LIMIT'
    const atLimit = Date.now()
    const limited = await poll()
    assert.equal(limited.status, 'WAITING')
    assert.ok('reason' in limited && limited.reason === 'RATE_LIMITED')
    const checkpoint = await account()
    assert.equal(checkpoint.cursor, 'tail')
    const failedInbox = await request('GET', character + inbox)
    assert.equal(failedInbox.body.readError, 'RATE_LIMITED')
    assert.equal(failedInbox.body.lastSucceededAt, firstInbox.body.lastSucceededAt)
    assert.ok(checkpoint.nextPollAt.getTime() >= atLimit + 30_000)
    const requestsAtLimit = calls
    assert.deepEqual(await poll(), { status: 'WAITING', nextAt: checkpoint.nextPollAt.toISOString() })
    assert.equal(calls, requestsAtLimit)

    await dueNow()
    mode = 'EXPIRED'
    const reset = await poll()
    assert.ok(reset.status === 'READ' && reset.historyLost && reset.saved === 0)
    assert.equal((await account()).cursor, 'reset')
    const gap = await request('GET', character + inbox)
    assert.equal(gap.body.readError, null)
    assert.equal(gap.body.historyLostCount, 1)
    assert.ok(gap.body.lastHistoryLostAt)
    assert.equal(gap.body.items.length, 2)

    await dueNow()
    mode = 'RESUME'
    assert.equal((await poll()).status, 'READ')
    assert.equal(cursors.at(-1), 'reset')
    assert.equal((await account()).cursor, 'after-reset')

    await dueNow()
    mode = 'PAUSE'
    const pending = poll()
    await Promise.race([requestEntered, pending.then(() => { throw new Error('No event read reached the fixture') })])
    assert.equal((await poll()).status, 'WAITING')
    assert.equal((await control('PAUSE')).status, 200)
    releasePage()
    assert.deepEqual(await pending, { status: 'STOPPED' })
    assert.equal((await account()).cursor, 'after-reset')
    assert.equal(await owner.newbiEvent.count({ where: { accountId } }), 2)
    assert.equal(writes, 0)

    await owner.newbiEvent.updateMany({ where: { accountId }, data: { occurredAt: new Date(0) } })
    await sweepSimulationRetention(runtime)
    assert.equal(await owner.newbiEvent.count({ where: { accountId } }), 0)
    assert.equal((await account()).historyLostCount, 1)
    const callsBeforeStop = calls
    await host.stop()
    await assert.rejects(reader.verify(), { name: 'AbortError' })
    assert.equal(calls, callsBeforeStop)
  } finally {
    releasePage()
    if (worker && worker.exitCode === null) worker.kill()
    await Promise.all([host.stop(), db.$disconnect(), runtime.$disconnect()])
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('three identities on two platforms reach separate approved simulation receipts', async () => {
  const runtimeUrl = scheduleRuntimeUrl()
  const runtime = createDatabase(runtimeUrl)
  const executor = simulationDatabase()
  try {
    await owner.character.update({
      where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) },
    })
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    const occurredAt = new Date()
    const runs = []
    const memoryCount = await owner.memory.count({ where: { characterId: a } })
    const prompts = new Map([
      ['formal', '先说明结论，再列步骤。'],
      ['casual', '用轻松的语气回复。\n请对方补充背景。'],
    ])
    for (const [style, platform, expected] of [
      ['formal', 'mock-a', '感谢您的来信，我会认真考虑。'],
      ['casual', 'mock-b', '收到啦，我会看看。'],
      ['concise', 'mock-a', '收到。'],
    ] as const) {
      const identity = await request('POST', characterPath(a) + '/identities', {
        key: 'e2e-' + style, data: {
          slug: 'e2e-' + style, roleProfile: { writingStyle: style, writingPrompt: prompts.get(style) },
        },
      })
      assert.equal(identity.status, 201)
      const account = await request('POST', characterPath(a) + '/accounts', {
        key: 'e2e-account-' + style,
        data: { identityId: identity.body.id, platform, instanceKey: 'integration', remoteAccountId: randomUUID() },
      })
      assert.equal(account.status, 201)
      const identityId: string = identity.body.id
      const accountId: string = account.body.id
      await owner.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } })
      const bound = await owner.platformAccount.update({ where: { id: accountId }, data: { status: 'ACTIVE' } })
      const conversation = await owner.conversation.create({
        data: { characterId: a, identityId, accountId, channel: 'PUBLIC', remoteKey: 'e2e-thread' },
      })
      const text = 'same topic across simulation platforms'
      const payload = platform === 'mock-a' ? {
        id: 'e2e-delivery', account: bound.remoteAccountId, thread: conversation.remoteKey,
        kind: 'MENTION', occurredAt: occurredAt.toISOString(), text,
      } : {
        delivery: 'e2e-delivery', recipient: bound.remoteAccountId, action: 'mention',
        timeMs: occurredAt.getTime(), message: { conversation: conversation.remoteKey, body: text },
      }
      const source = { accountId, platform, instanceKey: bound.instanceKey, verifiedRemoteAccountId: bound.remoteAccountId }
      const deliveries = await Promise.all(Array.from({ length: 100 }, () => ingest(source, payload)))
      const accepted = deliveries.filter((delivery) => delivery.status === 'ACCEPTED')
      assert.equal(accepted.length, 1)
      const [result] = accepted
      assert.ok(deliveries.every((delivery) => 'runId' in delivery && delivery.runId === result.runId))
      assert.equal(await owner.inboundEvent.count({ where: { accountId, sourceKey: 'e2e-delivery' } }), 1)
      runs.push({ id: result.runId, accountId, identityId, expected, conversationId: conversation.id })
    }

    const identitiesPath = characterPath(a) + '/identities?limit=100'
    const adminProfiles = await request('GET', identitiesPath)
    assert.equal(adminProfiles.status, 200)
    for (const [style, prompt] of prompts) {
      assert.equal(adminProfiles.body.items.find(({ slug }: { slug: string }) => slug === 'e2e-' + style).profile.writingPrompt, prompt)
    }
    for (const actor of ['auditor', 'reviewer']) {
      const view = await request('GET', identitiesPath, { actor })
      assert.equal(view.status, 200)
      assert.ok(view.body.items.some(({ slug }: { slug: string }) => slug === 'e2e-formal'))
      assert.ok(!view.body.items.some(({ profile }: { profile?: { writingPrompt?: string } }) => profile?.writingPrompt !== undefined))
    }

    const ids = runs.map(({ id }) => id)
    const observedPrompts = new Map<string, string | undefined>()
    const provider = simulatedModelPlugin.implementation
    const recordingModel = {
      ...simulatedModelPlugin,
      implementation: {
        async decide(input: Parameters<typeof provider.decide>[0], signal: AbortSignal) {
          assert.ok(!JSON.stringify(input).includes('writingPrompt'))
          return provider.decide(input, signal)
        },
        async write(input: Parameters<typeof provider.write>[0], signal: AbortSignal) {
          if (input.text === 'same topic across simulation platforms') observedPrompts.set(input.style, input.identityPrompt)
          return provider.write(input, signal)
        },
      },
    }
    const worker = await startOutboxWorker(runtimeUrl, config.redisUrl, recordingModel, simulationPlatforms.resolveAdapter)
    try {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (await owner.actionProposal.count({ where: { runId: { in: ids } } }) === runs.length) break
        await sleep(50)
      }
      assert.equal(await owner.actionProposal.count({ where: { runId: { in: ids } } }), runs.length)
      assert.deepEqual(observedPrompts, new Map([...prompts, ['concise', undefined]]))
    } finally {
      await worker.close()
    }

    const character = await owner.character.findUniqueOrThrow({ where: { id: a } })
    await Promise.all(runs.map(async ({ id, accountId, identityId, expected, conversationId }) => {
      const action = await owner.actionProposal.findUniqueOrThrow({ where: { runId: id } })
      const path = actionPath(action.id)
      const preview = await request('GET', path, { actor: 'reviewer' })
      assert.equal(preview.status, 200)
      assert.equal(preview.body.target.accountId, accountId)
      assert.equal(preview.body.target.identityId, identityId)
      assert.equal(preview.body.target.conversationId, conversationId)
      assert.equal(preview.body.content.split('\n\nAI 披露：')[0], expected)
      assert.match(preview.body.content, /\n\nAI 披露：\S/)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
      const decision = await request('POST', path + '/decisions', {
        actor: 'reviewer', key: 'e2e-approve-' + id, ifMatch: preview.headers.get('etag') ?? '',
        data: { decision: 'APPROVE', reviewDigest: action.reviewDigest, reason: 'Approve bound simulation' },
      })
      assert.equal(decision.status, 200, JSON.stringify(decision.body))
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      const receipts = await owner.simulationReceipt.findMany({
        where: { actionId: action.id }, select: { attempt: { select: { accountId: true, reviewDigest: true } } },
      })
      assert.equal(receipts.length, 1)
      assert.equal(receipts[0].attempt.accountId, accountId)
      assert.equal(receipts[0].attempt.reviewDigest, action.reviewDigest)
      const replay = await request('GET', characterPath(a) + '/runs/' + id + '/replay')
      assert.equal(replay.status, 200)
      assert.equal(replay.body.state, 'SIMULATED')
      await assert.rejects(runtime.$executeRaw`
        UPDATE public.agent_runs SET mode = mode WHERE id = ${id}::uuid
      `, /permission denied/i)
      assert.equal(replay.body.coreVersion, character.activeCoreVersion)
      assert.equal(replay.body.accountId, accountId)
      assert.equal(replay.body.identityId, identityId)
      assert.equal(replay.body.proposal.adapterId, preview.body.target.platform)
      assert.equal(replay.body.proposal.adapterVersion, '1.0.0')
      assert.equal(replay.body.proposal.adapterContractVersion, 1)
    }))
    assert.deepEqual(await owner.$queryRaw`SELECT unnest(enum_range(NULL::"RunMode"))::text AS mode`,
      [{ mode: 'SIMULATION' }])
    assert.equal(await owner.memory.count({ where: { characterId: a } }), memoryCount)
  } finally {
    await Promise.all([executor.$disconnect(), runtime.$disconnect()])
  }
})

test('console simulation runs use an isolated conversation, one approval and one receipt', { timeout: 30_000 }, async (t) => {
  const created = await request('POST', '/characters', { key: randomUUID(), data: characterData('-console') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const character = characterPath(characterId)
  const identity = await request('POST', character + '/identities', {
    key: randomUUID(), data: { slug: 'console-persona', roleProfile: {} },
  })
  assert.equal(identity.status, 201, JSON.stringify(identity.body))
  const identityId: string = identity.body.id
  assert.equal((await request('POST', character + '/memberships', {
    key: randomUUID(), data: { subject: 'reviewer', role: 'REVIEWER', action: 'GRANT', reason: 'Console fixture' },
  })).status, 200)
  const path = character + '/runs'
  const input = { accountId: accountA, message: 'Console simulation fixture for an isolated public discussion' }
  const denied = await request('POST', path, { actor: 'reviewer', key: randomUUID(), data: input })
  assert.equal(denied.status, 403)
  assert.equal((await request('GET', path, { actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', characterPath(b) + '/runs')).status, 404)
  const foreign = await request('POST', characterPath(b) + '/runs', { actor: 'admin-b', key: randomUUID(), data: input })
  assert.equal(foreign.status, 404)

  const account = await owner.platformAccount.create({ data: {
    characterId, identityId, platform: 'mock-a', instanceKey: 'console-fixture',
    remoteAccountId: randomUUID(), status: 'PAUSED',
  } })
  const inactive = await request('POST', path, { key: randomUUID(), data: { ...input, accountId: account.id } })
  assert.equal(inactive.status, 409)
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: account.id }, data: { status: 'ACTIVE' } })
  const data = { ...input, accountId: account.id }
  const key = randomUUID()
  const [first, duplicate] = await Promise.all([
    request('POST', path, { key, data }), request('POST', path, { key, data }),
  ])
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(duplicate.status, 201)
  assert.equal(first.body.id, duplicate.body.id)
  const id = first.body.id
  const run = await owner.agentRun.findUniqueOrThrow({ where: { id }, include: { inboundEvent: { include: { conversation: true } } } })
  assert.equal(run.accountId, account.id)
  assert.equal(run.inboundEvent.conversation?.channel, 'PUBLIC')
  assert.equal(run.inboundEvent.conversation?.privateContactId, null)
  assert.equal(run.inboundEvent.adapterId, 'mock-a')
  assert.equal(await owner.conversation.count({ where: { accountId: account.id } }), 1)
  assert.equal(await owner.outboxEvent.count({ where: { runId: id, type: runQueuedEvent } }), 1)
  const listing = await request('GET', path + '?limit=1')
  assert.equal(listing.status, 200)
  assert.deepEqual(listing.body.items.map(({ id: itemId }: { id: string }) => itemId), [id])
  assert.equal('message' in listing.body.items[0], false)
  assert.equal((await request('GET', path + '?limit=1&cursor=' + id)).body.items.some((item: { id: string }) => item.id === id), false)

  const replayPath = path + '/' + id + '/replay'
  const initial = await request('GET', replayPath)
  assert.equal(initial.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.inbound.kind, run.inboundEvent.kind)
  assert.equal(Date.parse(initial.body.inbound.receivedAt), run.inboundEvent.receivedAt.getTime())
  assert.deepEqual(Object.keys(initial.body.inbound).sort(), ['kind', 'receivedAt'])
  assert.equal(initial.body.draft, null)
  assert.equal(initial.body.proposal, null)
  assert.equal(JSON.stringify(initial.body).includes(input.message), false)

  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const queued = await owner.outboxEvent.findFirstOrThrow({ where: { runId: id, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, queued.eventId)
    const draft = await owner.outboxEvent.findFirstOrThrow({ where: { runId: id, type: draftQueuedEvent } })
    const generatedReply = 'Welcome to the discussion. What would you like to know?'
    const plugins = await startCognitionPlugins({
      RICA_MODEL_PROVIDER: 'openai', RICA_MODEL_NAME: 'fixture-model', OPENAI_API_KEY: 'fixture-key',
    })
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { content: generatedReply } }],
    }))
    try {
      await processSimulatedDraft(runtime, draft.eventId, simulationPlatforms.resolveAdapter, plugins.model)
      assert.equal(fetch.mock.callCount(), 1)
    } finally {
      fetch.mock.restore()
      await plugins.stop()
    }
    const action = await owner.actionProposal.findUniqueOrThrow({ where: { runId: id } })
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
    const actionPath = character + '/actions/' + action.id
    const preview = await request('GET', actionPath, { actor: 'reviewer' })
    assert.equal(preview.status, 200)
    assert.ok(preview.body.content.startsWith(generatedReply + '\n\nAI 披露：'))
    const decision = await request('POST', actionPath + '/decisions', {
      actor: 'reviewer', key: randomUUID(), ifMatch: preview.headers.get('ETag')!,
      data: { decision: 'APPROVE', reviewDigest: preview.body.reviewDigest, reason: 'Console fixture checked' },
    })
    assert.equal(decision.status, 200, JSON.stringify(decision.body))
    const approved = await request('GET', replayPath)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    assert.deepEqual(Object.keys(approved.body.draft).sort(), ['createdAt', 'modelId', 'modelVersion'])
    assert.equal(approved.body.draft.modelId, 'openai')
    assert.equal(approved.body.draft.modelVersion, 'fixture-model')
    assert.equal(Date.parse(approved.body.proposal.createdAt), action.createdAt.getTime())
    assert.equal(approved.body.proposal.reviewDecision, 'APPROVE')
    assert.ok(approved.body.proposal.reviewedAt)
    assert.equal(approved.body.proposal.permittedAt, null)
    assert.equal(approved.body.proposal.receiptAt, null)
    assert.equal(JSON.stringify(approved.body).includes(preview.body.content), false)

    await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
    const replay = await request('GET', replayPath)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.state, 'SIMULATED')
    assert.ok(replay.body.proposal.permittedAt)
    assert.ok(replay.body.proposal.receiptAt)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 1)
    const second = await request('POST', path, { key: randomUUID(), data })
    assert.equal(second.status, 201)
    const recent = await request('GET', path + '?limit=1')
    assert.equal(recent.body.items.length, 1)
    assert.equal(recent.body.nextCursor, recent.body.items[0].id)
    const older = await request('GET', path + '?limit=1&cursor=' + recent.body.nextCursor)
    assert.deepEqual([...recent.body.items, ...older.body.items].map((item: { id: string }) => item.id).sort(),
      [id, second.body.id].sort())
    assert.equal(older.body.nextCursor, null)

    const filters = new URLSearchParams({ identityId, accountId: account.id, limit: '1' })
    const matchingPage = await request('GET', path + '?' + filters)
    assert.equal(matchingPage.status, 200, JSON.stringify(matchingPage.body))
    assert.equal(matchingPage.body.nextCursor, recent.body.nextCursor)
    filters.set('cursor', matchingPage.body.nextCursor)
    const matchingOlder = await request('GET', path + '?' + filters)
    assert.deepEqual(matchingOlder.body, older.body)
    filters.delete('cursor')
    filters.set('state', 'SIMULATED')
    const utcDay = run.createdAt.toISOString().slice(0, 10)
    filters.set('from', utcDay)
    filters.set('through', utcDay)
    const filtered = await request('GET', path + '?' + filters)
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body))
    assert.deepEqual(filtered.body.items.map((item: { id: string }) => item.id), [id])
    assert.equal(filtered.body.nextCursor, null)
    const previousDay = new Date(Date.parse(utcDay) - 86_400_000).toISOString().slice(0, 10)
    for (const replacement of [
      { from: previousDay, through: previousDay }, { identityId: randomUUID() }, { accountId: accountA },
    ]) {
      const unmatched = new URLSearchParams(filters)
      for (const [key, value] of Object.entries(replacement)) unmatched.set(key, value)
      assert.deepEqual((await request('GET', path + '?' + unmatched)).body, { items: [], nextCursor: null })
    }
    assert.equal((await request('GET', path + '?from=' + utcDay + '&through=' + previousDay)).status, 422)
    assert.deepEqual((await request('GET', characterPath(a) + '/runs?' + filters)).body, { items: [], nextCursor: null })

    const audit = character + '/audit?runId=' + id
    assert.equal((await request('GET', audit, { actor: 'reviewer' })).status, 403)
    assert.equal((await request('GET', characterPath(a) + '/audit?runId=' + id)).status, 404)
    const newestAudit = await request('GET', audit + '&order=desc&limit=1')
    assert.equal(newestAudit.status, 200, JSON.stringify(newestAudit.body))
    assert.equal(newestAudit.body.items.length, 1)
    assert.equal(newestAudit.body.nextCursor, newestAudit.body.items[0].id)
    assert.deepEqual(Object.keys(newestAudit.body.items[0]).sort(),
      ['actorId', 'createdAt', 'digest', 'id', 'operation', 'requestId', 'targetId'])
    const olderAudit = await request('GET', audit + '&order=desc&limit=1&cursor=' + newestAudit.body.nextCursor)
    const entries = [...newestAudit.body.items, ...olderAudit.body.items]
    assert.deepEqual(entries.map((item: { operation: string }) => item.operation).sort(), ['action.review', 'simulation.start'])
    assert.deepEqual(entries.map((item: { targetId: string }) => item.targetId).sort(), [id, action.id].sort())
    assert.ok(Date.parse(entries[0].createdAt) >= Date.parse(entries[1].createdAt))
    assert.equal(olderAudit.body.nextCursor, null)
    const foreignCursor = await request('GET', character + '/audit?runId=' + second.body.id)
    assert.equal((await request('GET', audit + '&cursor=' + foreignCursor.body.items[0].id)).status, 422)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('a role can register an account before its identities and associate it only once', async () => {
  const created = await request('POST', '/characters', { key: 'pool-character', data: characterData('-pool') })
  assert.equal(created.status, 201)
  characterIds.push(created.body.id)
  const path = characterPath(created.body.id)
  const pool = path + '/account-pool'
  const data = { platform: 'mock-a', instanceKey: 'integration', remoteAccountId: prefix + '-pool' }
  assert.deepEqual((await request('GET', path + '/identities')).body.items, [])
  const registered = await request('POST', pool, { key: 'register-first', data })
  assert.equal(registered.status, 201, JSON.stringify(registered.body))
  const registrationId = registered.body.id
  assert.equal((await request('POST', pool, { key: 'register-first', data })).body.id, registrationId)
  assert.deepEqual((await request('GET', pool)).body.items, [{ id: registrationId, ...data }])
  assert.deepEqual((await request('GET', path + '/accounts')).body.items, [])
  assert.equal((await request('GET', pool, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('POST', characterPath(b) + '/account-pool', {
    actor: 'admin-b', key: 'duplicate-platform-account', data,
  })).status, 409)
  assert.equal((await request('POST', characterPath(b) + '/account-pool/associations', {
    actor: 'admin-b', key: 'foreign-registration', data: { registrationId, identityId: identityB },
  })).status, 404)
  assert.equal((await request('POST', pool + '/associations', {
    key: 'foreign-identity', data: { registrationId, identityId: identityB },
  })).status, 404)
  const identity = await request('POST', path + '/identities', { key: 'pool-identity', data: { slug: 'pool-identity', roleProfile: {} } })
  assert.equal(identity.status, 201, JSON.stringify(identity.body))
  const identityId = identity.body.id
  const attempts = await Promise.all(['associate-first', 'associate-second'].map((key) => request('POST', pool + '/associations', {
    key, data: { registrationId, identityId },
  })))
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [201, 409])
  assert.deepEqual((await request('GET', pool)).body.items, [])
  const { items } = (await request('GET', path + '/accounts')).body
  assert.deepEqual(items.map(({ id, identityId, status }: { id: string; identityId: string; status: string }) =>
    ({ id, identityId, status })), [{ id: registrationId, identityId, status: 'PAUSED' }])
})
