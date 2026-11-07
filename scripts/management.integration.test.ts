import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { introspectionAuthenticator } from '../apps/api/admin-auth.js'
import { createApp } from '../apps/api/app.js'
import { createManagementApp } from '../apps/api/management.js'
import { createDatabase } from '../packages/persistence/client.js'
import { ingestSimulatedEvent } from '../packages/persistence/inbound.js'
import { draftQueuedEvent, prepareSimulatedRun, runQueuedEvent } from '../packages/persistence/run-context.js'
import { processSimulatedDraft } from '../packages/persistence/simulated-draft.js'
import { loadConfig } from '../packages/runtime/config.js'

const config = loadConfig()
const owner = createDatabase(config.databaseUrl)
const adminUrl = new URL(config.databaseUrl)
adminUrl.searchParams.set('options', '-c role=rica_admin_api')
const management = createDatabase(adminUrl.toString())
const issuer = 'https://identity.example.test'
const audience = 'rica-management'
const subjects = new Set(['admin-a', 'admin-b', 'reviewer'])
const app = createApp({ postgres: async () => true, redis: async () => true }, createManagementApp({
  db: management,
  creatorSubjects: ['admin-a', 'admin-b'],
  authenticate: introspectionAuthenticator({
    endpoint: issuer + '/introspect', issuer, audience, clientId: 'rica', clientSecret: 'test-secret',
  }, async (_url, init) => {
    const token = new URLSearchParams(String(init?.body)).get('token') ?? ''
    return Response.json({
      active: subjects.has(token), iss: issuer, aud: audience, sub: token,
      exp: Math.floor(Date.now() / 1000) + 60, roles: ['ADMIN'],
    })
  }),
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
  if (actor) headers.set('Authorization', 'Bearer ' + actor)
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
        OR: [{ routeScope: { contains: a ?? 'missing-fixture' } }, { routeScope: { contains: b ?? 'missing-fixture' } },
          ...characterIds.map((id) => ({ response: { path: ['id'], equals: id } }))],
      } })
      await tx.outboxEvent.deleteMany({ where: { run: where } })
      await tx.actionApproval.deleteMany({ where })
      await tx.actionProposal.deleteMany({ where })
      await tx.simulatedDraft.deleteMany({ where })
      await tx.contextSnapshotEvidence.deleteMany({ where })
      await tx.contextSnapshot.deleteMany({ where })
      await tx.agentRun.deleteMany({ where })
      await tx.inboundEvent.deleteMany({ where })
      await tx.managementAudit.deleteMany({ where })
      await tx.managementMembership.deleteMany({ where })
      await tx.memoryGrant.deleteMany({ where })
      await tx.memorySource.deleteMany({ where })
      await tx.memory.deleteMany({ where })
      await tx.sourceRecord.deleteMany({ where })
      await tx.conversation.deleteMany({ where })
      await tx.platformAccount.deleteMany({ where })
      await tx.identity.updateMany({ where, data: { status: 'PAUSED', activeVersion: null } })
      await tx.identityVersion.deleteMany({ where })
      await tx.identity.deleteMany({ where })
      await tx.character.updateMany({ where: { id: { in: characterIds } }, data: { status: 'PAUSED', activeCoreVersion: null } })
      await tx.coreVersion.deleteMany({ where })
      await tx.character.deleteMany({ where: { id: { in: characterIds } } })
    })
  } finally {
    await Promise.all([management.$disconnect(), owner.$disconnect()])
  }
})

test('authentication and membership distinguish unauthenticated, forbidden and foreign resources', async () => {
  const absent = await request('GET', characterPath(a), { actor: null })
  assert.equal(absent.status, 401)
  assert.equal(absent.headers.get('www-authenticate'), 'Bearer')
  assert.equal((await app.request('/v1' + characterPath(a) + '/identities', {
    method: 'POST', headers: { Cookie: 'session=admin-a' },
  })).status, 401)
  assert.equal(absent.body.error.requestId, absent.headers.get('x-request-id'))
  assert.equal((await request('GET', characterPath(b))).status, 404)
  assert.equal((await request('GET', characterPath(a), { actor: 'reviewer' })).status, 200)
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
  const core = { coreProfile: { aiDisclosure: 'AI role, version two' }, reason: 'Update policy' }
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
  const legacy = await owner.identity.create({ data: { characterId: a, slug: 'legacy-without-version' } })
  const legacyUpdate = await request('PUT', path + '/identities/' + legacy.id, {
    ifMatch: '"0"', data: { roleProfile: { writingStyle: 'formal' }, reason: 'Configure legacy identity' },
  })
  assert.equal(legacyUpdate.status, 200)
  assert.equal(legacyUpdate.body.version, 1)
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


async function proposeReview() {
  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    const audience = await owner.conversation.create({
      data: { characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID(), channel: 'PUBLIC' },
    })
    const proposalText = 'unique review ' + randomUUID()
    const memory = await owner.memory.create({
      data: { characterId: a, identityId: identityA, scope: 'IDENTITY', visibility: 'PUBLIC', content: proposalText },
    })
    const source = await owner.sourceRecord.create({
      data: { characterId: a, identityId: identityA, kind: 'fixture', sourceKey: randomUUID(), classification: 'PUBLIC' },
    })
    await owner.memorySource.create({ data: { characterId: a, memoryId: memory.id, sourceId: source.id } })
    const grant = await owner.memoryGrant.create({
      data: {
        characterId: a, memoryId: memory.id, recipientIdentityId: identityA, recipientAccountId: accountA,
        audience: audience.id, purpose: 'PUBLIC_REFERENCE', validFrom: new Date(Date.now() - 1000),
        validUntil: new Date(Date.now() + 120_000), approvedBy: 'fixture', reason: 'Review fixture',
      },
    })
    const result = await ingestSimulatedEvent(runtime, {
      accountId: accountA, conversationId: audience.id, sourceKey: randomUUID(), kind: 'REPLY',
      occurredAt: new Date(), messageText: proposalText,
    })
    assert.equal(result.status, 'ACCEPTED')
    const runJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, runJob.eventId)
    const draftJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, draftJob.eventId)
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
  assert.equal(preview.body.content, '供您参考：' + proposalText)
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
    if (scenario === 'grant-expiry') {
      await owner.memoryGrant.update({
        where: { id: grant.id }, data: { validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() - 1000) },
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
        data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) },
      })
    }
    const path = actionPath(action.id)
    const preview = await request('GET', path, { actor: 'reviewer' })
    const rejected = scenario === 'reject'
    const expected = rejected ? 'WAITING_APPROVAL' : scenario === 'proposal-expiry' ? 'EXPIRED' : 'CANCELED'
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

test('grant and account management enforce bound references and revoke access with an epoch change', async () => {
  const path = characterPath(a)
  const memory = await owner.memory.create({
    data: { characterId: a, identityId: identityA, scope: 'IDENTITY', visibility: 'PUBLIC', content: 'Private persistence fixture' },
  })
  const audience = await owner.conversation.create({
    data: { characterId: a, identityId: identityA, accountId: accountA, remoteKey: prefix, channel: 'PUBLIC' },
  })
  const now = Date.now()
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
  const grants = await request('GET', path + '/memory-grants')
  const savedGrant = grants.body.items.find(({ id }: { id: string }) => id === grant.body.id)
  assert.ok(savedGrant)
  assert.ok(savedGrant.revokedAt)
  const memories = await request('GET', path + '/memories')
  assert.equal(memories.status, 200)
  const savedMemory = memories.body.items.find(({ id }: { id: string }) => id === memory.id)
  assert.ok(savedMemory)
  assert.ok(!('content' in savedMemory))
  await assert.rejects(management.memory.findMany({ select: { content: true } }), /permission denied/i)
  const account = await request('POST', path + '/controls', {
    key: 'revoke-account', data: { scope: 'ACCOUNT', scopeId: accountA, operation: 'REVOKE_ACCOUNT', reason: 'Unlink' },
  })
  assert.equal(account.status, 200)
  assert.equal(account.body.status, 'REVOKED')
  assert.equal((await request('POST', path + '/controls', {
    key: 'resume-revoked', data: { scope: 'ACCOUNT', scopeId: accountA, operation: 'RESUME', reason: 'Rejected transition' },
  })).status, 409)
})
