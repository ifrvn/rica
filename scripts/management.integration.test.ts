import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { startOutboxWorker } from '../apps/worker/outbox.js'
import { dailyScheduleSlot, scanSimulationSchedules } from '../packages/persistence/simulation-schedules.js'
import { after, before, test } from 'node:test'
import { introspectionAuthenticator } from '../apps/api/admin-auth.js'
import { createApp } from '../apps/api/app.js'
import { createManagementApp } from '../apps/api/management.js'
import { deriveMemory, revokeMemoryAccess } from '../packages/persistence/memory.js'
import { reviewTarget } from '../packages/contracts/action-review.js'
import { loadRunContinuity } from '../packages/persistence/run-continuity.js'
import { createDatabase } from '../packages/persistence/client.js'
import { createSimulatedPlatformIngress, ingestSimulatedEvent } from '../packages/persistence/inbound.js'
import { draftQueuedEvent, prepareSimulatedRun, runQueuedEvent } from '../packages/persistence/run-context.js'
import { processSimulatedDraft } from '../packages/persistence/simulated-draft.js'
import { executeSimulation, recordSimulationReceipt, reserveSimulation, runSimulationBatch } from '../packages/persistence/simulation-execution.js'
import { loadConfig } from '../packages/runtime/config.js'

const config = loadConfig()
const owner = createDatabase(config.databaseUrl)
const adminUrl = new URL(config.databaseUrl)
adminUrl.searchParams.set('options', '-c role=rica_admin_api')
const management = createDatabase(adminUrl.toString())
const issuer = 'https://identity.example.test'
const audience = 'rica-management'
const subjects = new Set(['admin-a', 'admin-b', 'reviewer', 'auditor'])
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
      await tx.beliefEvidence.deleteMany({ where })
      await tx.beliefVersion.deleteMany({ where })
      await tx.memorySource.deleteMany({ where })
      await tx.memoryCorrection.deleteMany({ where })
      await tx.memory.deleteMany({ where })
      await tx.sourceRecord.deleteMany({ where })
      await tx.conversation.deleteMany({ where })
      await tx.contact.deleteMany({ where })
      await tx.platformAccount.deleteMany({ where })
      await tx.identity.updateMany({ where, data: { status: 'PAUSED', activeVersion: null } })
      await tx.identityVersion.deleteMany({ where })
      await tx.goalVersion.deleteMany({ where })
      await tx.identity.deleteMany({ where })
      await tx.character.updateMany({ where: { id: { in: characterIds } }, data: { status: 'PAUSED', activeCoreVersion: null } })
      await tx.coreVersion.deleteMany({ where })
      await tx.dailyEnergyProjection.deleteMany({ where })
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


async function databaseNow() {
  const [clock] = await owner.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS now`
  return clock.now.getTime()
}

async function proposeReview(accountId = accountA, contactId?: string) {
  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    const audience = await owner.conversation.create({
      data: {
        characterId: a, identityId: identityA, accountId, remoteKey: randomUUID(),
        channel: contactId ? 'PRIVATE' : 'PUBLIC', privateContactId: contactId,
      },
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
        characterId: a, memoryId: memory.id, recipientIdentityId: identityA, recipientAccountId: accountId,
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

async function approveSimulation(accountId = accountA, contactId?: string) {
  const proposal = await proposeReview(accountId, contactId)
  const response = await request('POST', actionPath(proposal.action.id) + '/decisions', {
    actor: 'reviewer', key: 'approve-' + proposal.action.id, ifMatch: '"run-v3"',
    data: { reviewDigest: proposal.action.reviewDigest, decision: 'APPROVE', reason: 'Approved simulation fixture' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return proposal
}

async function newSimulationAccount() {
  const account = await owner.platformAccount.create({
    data: {
      characterId: a, identityId: identityA, status: 'ACTIVE',
      platform: 'mock-a', instanceKey: 'integration', remoteAccountId: randomUUID(),
    },
  })
  return account.id
}

function simulationZone(hour: number) {
  const shift = (hour - new Date().getUTCHours() + 35) % 24 - 11
  return shift === 0 ? 'UTC' : 'Etc/GMT' + (shift > 0 ? '-' : '+') + Math.abs(shift)
}

test('simulation defers quiet hours and rejects stale evidence or a paused binding', async () => {
  const executor = simulationDatabase()
  try {
    const quiet = await approveSimulation()
    await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(1) } })
    assert.equal(await reserveSimulation(executor, quiet.action.id), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: quiet.action.runId } })).state, 'READY')
    await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })

    const stale = await approveSimulation()
    const now = await databaseNow()
    await owner.memoryGrant.update({
      where: { id: stale.grant.id }, data: { validFrom: new Date(now - 60_000), validUntil: new Date(now - 1000) },
    })
    assert.equal(await reserveSimulation(executor, stale.action.id), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: stale.action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: stale.action.id } }), 0)

    const revoked = await approveSimulation(await newSimulationAccount())
    const revokedGrant = await request('POST', characterPath(a) + '/memory-grants/' + revoked.grant.id + '/revoke', {
      key: 'revoke-before-permit', data: { reason: 'Withdraw evidence after approval' },
    })
    assert.equal(revokedGrant.status, 200)
    await executeSimulation(executor, revoked.action.id, async () => assert.fail('Revoked proposal reached the adapter'))
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
    assert.equal(await reserveSimulation(executor, undisclosed.action.id), false)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: undisclosed.action.id } }), 0)

    const paused = await approveSimulation(await newSimulationAccount())
    await executeSimulation(executor, paused.action.id, async (db, id) => {
      await owner.character.update({ where: { id: a }, data: { status: 'PAUSED', authEpoch: { increment: 1 } } })
      return recordSimulationReceipt(db, id)
    })
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: paused.action.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: paused.action.id } })).status, 'NOT_SENT')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: paused.action.runId } })).state, 'BLOCKED')
    assert.equal(await reserveSimulation(executor, quiet.action.id), false)
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
    await Promise.all(Array.from({ length: 6 }, () => executeSimulation(executor, first.id, async (db, id) => {
      calls++
      return recordSimulationReceipt(db, id)
    })))
    assert.equal(calls, 1)
    for (let round = 0; round < 5; round++) {
      await Promise.all(proposals.slice(1).map(({ id }) => executeSimulation(executor, id)))
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
    await executeSimulation(executor, first.id)
    await executeSimulation(executor, second.id)
    await executeSimulation(executor, other.id)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: [first.id, other.id] } } }), 2)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: second.id } }), 0)

    await owner.simulationReceipt.update({
      where: { actionId: first.id }, data: { createdAt: new Date((await databaseNow()) - 3_601_000) },
    })
    await executeSimulation(executor, second.id)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: second.id } }), 1)
  } finally {
    await executor.$disconnect()
  }
})

async function crashSimulationProcess(actionId: string, checkpoint: 'permit' | 'receipt') {
  const program = `
    import { createDatabase } from './packages/persistence/client.ts'
    import { reserveSimulation, recordSimulationReceipt } from './packages/persistence/simulation-execution.ts'
    const [id, phase] = process.argv.slice(1)
    const db = createDatabase(process.env.RICA_TEST_SIMULATION_URL)
    if (!await reserveSimulation(db, id)) throw new Error('Permit was not issued')
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
    await executeSimulation(executor, notSent.id, async () => assert.fail('Old approval reached the replacement adapter'))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: notSent.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: notSent.id } }), 0)

    const expired = new Date((await databaseNow()) - 1000)
    await owner.simulationAttempt.updateMany({
      where: { actionId: { in: [lost.id, recorded.id] } }, data: { permitUntil: expired },
    })
    await runSimulationBatch(executor, null)
    await runSimulationBatch(executor, null)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: lost.runId } })).state, 'RECONCILING')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: recorded.runId } })).state, 'SIMULATED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: waiting.runId } })).state, 'READY')
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: [lost.id, waiting.id] } } }), 0)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: recorded.id } }), 1)

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
    await assert.rejects(executor.simulationAttempt.findMany({ select: { resolutionReason: true } }), /permission denied/i)

    await runSimulationBatch(executor, null)
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
    const worker = await startOutboxWorker(scheduleRuntimeUrl(), config.redisUrl)
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
    await executeSimulation(executor, actionId)
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
    await assert.rejects(executeSimulation(executor, action.id, async () => {
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
  const grants = await request('GET', path + '/memory-grants?limit=100')
  const savedGrant = grants.body.items.find(({ id }: { id: string }) => id === grant.body.id)
  assert.ok(savedGrant)
  assert.ok(savedGrant.revokedAt)
  const memories = await request('GET', path + '/memories?limit=100')
  assert.equal(memories.status, 200)
  const savedMemory = memories.body.items.find(({ id }: { id: string }) => id === memory.id)
  assert.ok(savedMemory)
  assert.ok(!('content' in savedMemory))
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
    const ingest = createSimulatedPlatformIngress(runtime)
    const payload = {
      id: 'revoked-simulated-subject', account: bound.remoteAccountId, thread: audience.remoteKey,
      kind: 'REPLY', occurredAt: new Date().toISOString(), text: 'Reply after revocation',
    }
    assert.deepEqual(await ingest({ accountId: bound.id, platform: bound.platform, instanceKey: bound.instanceKey, verifiedRemoteAccountId: bound.remoteAccountId }, payload),
      { status: 'ACCOUNT_UNAVAILABLE' })
    assert.equal(await owner.inboundEvent.count({ where: { accountId: bound.id, sourceKey: payload.id } }), 0)
    await executeSimulation(executor, approved.id, async () => assert.fail('Revoked account reached the adapter'))
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
    const ingest = createSimulatedPlatformIngress(runtime)
    let stopRunId: string | undefined
    await executeSimulation(executor, inFlight.id, async (database, id) => {
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
    await processSimulatedDraft(runtime, stopDraft.eventId)
    assert.equal(await owner.actionProposal.count({ where: { runId: stopRunId } }), 0)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: inFlight.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: inFlight.id } })).status, 'NOT_SENT')
    const path = characterPath(a) + '/contacts/' + contact.id + '/boundary'
    const boundary = await request('GET', path)
    assert.equal(boundary.status, 200)
    assert.equal(boundary.body.blocked, true)
    assert.equal(boundary.body.version, 1)
    assert.equal((await owner.contact.findUniqueOrThrow({ where: { id: otherContact.id } })).noContactAt, null)
    assert.equal(await owner.managementAudit.count({ where: { targetId: contact.id, operation: 'contact.opt_out' } }), 1)

    const options = { ifMatch: '"1"', data: { blocked: false, reason: 'Verified renewed consent' } }
    assert.equal((await request('PUT', path, { ...options, actor: 'reviewer' })).status, 403)
    assert.equal((await request('PUT', path, { ...options, ifMatch: '"0"' })).status, 412)
    assert.equal((await request('PUT', path, options)).status, 200)
    await executeSimulation(executor, old.id, async () => assert.fail('Old approval was revived'))
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: old.id } }), 0)
    await executeSimulation(executor, independent.id)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: independent.id } }), 1)
    const fresh = (await approveSimulation(accountId, contact.id)).action
    const released = await owner.contact.findUniqueOrThrow({ where: { id: contact.id } })
    assert.ok(released.boundaryChangedAt)
    const backdated = await owner.agentRun.update({
      where: { id: fresh.runId }, data: { createdAt: new Date(released.boundaryChangedAt.getTime() - 1000) },
    })
    assert.equal(backdated.contactBoundaryVersion, 2)
    await executeSimulation(executor, fresh.id)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: fresh.id } }), 1)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

async function beliefEvidence(sourceId?: string, accountId?: string) {
  const source = sourceId ? { id: sourceId } : await owner.sourceRecord.create({
    data: { characterId: a, identityId: identityA, accountId, kind: 'fixture', sourceKey: randomUUID(), classification: 'PERSONAL' },
  })
  const memory = await owner.memory.create({
    data: {
      characterId: a, identityId: identityA, accountId, scope: accountId ? 'ACCOUNT' : 'IDENTITY',
      visibility: 'PERSONAL', content: 'Belief fixture',
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

  assert.equal(await revokeMemoryAccess(owner, { kind: 'SOURCE', characterId: a, id: first.sourceId }), true)
  for (const url of [path, path + '?revision=1']) {
    const view = await request('GET', url)
    assert.equal(view.body.status, 'INVALIDATED')
    assert.equal(view.body.statement, null)
    assert.equal(view.body.confidence, null)
    assert.deepEqual(view.body.evidence, [])
  }
  assert.equal((await request('POST', path + '/restore', { ifMatch: '"3"', data })).status, 409)
  const replacement = await request('PUT', path, {
    ifMatch: '"3"', data: beliefData([second.citation, third.citation], 'I prefer to work outside'),
  })
  assert.equal(replacement.body.status, 'ACTIVE')
  assert.equal((await request('GET', path)).body.version, 4)
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
    const ingest = createSimulatedPlatformIngress(runtime)
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

test('three identities on two platforms reach separate approved simulation receipts', async () => {
  const runtimeUrl = scheduleRuntimeUrl()
  const runtime = createDatabase(runtimeUrl)
  const executor = simulationDatabase()
  try {
    await owner.character.update({
      where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) },
    })
    const ingest = createSimulatedPlatformIngress(runtime)
    const occurredAt = new Date()
    const runs = []
    const memoryCount = await owner.memory.count({ where: { characterId: a } })
    for (const [style, platform, expected] of [
      ['formal', 'mock-a', '感谢您的来信，我会认真考虑。'],
      ['casual', 'mock-b', '收到啦，我会看看。'],
      ['concise', 'mock-a', '收到。'],
    ] as const) {
      const identity = await request('POST', characterPath(a) + '/identities', {
        key: 'e2e-' + style, data: { slug: 'e2e-' + style, roleProfile: { writingStyle: style } },
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

    const ids = runs.map(({ id }) => id)
    const worker = await startOutboxWorker(runtimeUrl, config.redisUrl)
    try {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (await owner.actionProposal.count({ where: { runId: { in: ids } } }) === runs.length) break
        await sleep(50)
      }
      assert.equal(await owner.actionProposal.count({ where: { runId: { in: ids } } }), runs.length)
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
      await executeSimulation(executor, action.id)
      assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
      const decision = await request('POST', path + '/decisions', {
        actor: 'reviewer', key: 'e2e-approve-' + id, ifMatch: preview.headers.get('etag') ?? '',
        data: { decision: 'APPROVE', reviewDigest: action.reviewDigest, reason: 'Approve bound simulation' },
      })
      assert.equal(decision.status, 200, JSON.stringify(decision.body))
      await executeSimulation(executor, action.id)
      await executeSimulation(executor, action.id)
      const receipts = await owner.simulationReceipt.findMany({
        where: { actionId: action.id }, select: { attempt: { select: { accountId: true } } },
      })
      assert.equal(receipts.length, 1)
      assert.equal(receipts[0].attempt.accountId, accountId)
      const replay = await request('GET', characterPath(a) + '/runs/' + id + '/replay')
      assert.equal(replay.status, 200)
      assert.equal(replay.body.state, 'SIMULATED')
      await assert.rejects(runtime.$executeRaw`
        UPDATE public.agent_runs SET mode = mode WHERE id = ${id}::uuid
      `, /permission denied/i)
      assert.equal(replay.body.coreVersion, character.activeCoreVersion)
      assert.equal(replay.body.accountId, accountId)
      assert.equal(replay.body.identityId, identityId)
    }))
    assert.deepEqual(await owner.$queryRaw`SELECT unnest(enum_range(NULL::"RunMode"))::text AS mode`,
      [{ mode: 'SIMULATION' }])
    assert.equal(await owner.memory.count({ where: { characterId: a } }), memoryCount)
  } finally {
    await Promise.all([executor.$disconnect(), runtime.$disconnect()])
  }
})
