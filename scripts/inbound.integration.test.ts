import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startOutboxWorker } from '../apps/worker/outbox.js'
import { createDatabase } from '../packages/persistence/client.js'
import type { MemoryPurpose, MemoryScope, MemoryVisibility } from '../packages/persistence/generated/client.js'
import { listAuthorizedMemoryCandidates, revokeMemoryAccess } from '../packages/persistence/memory.js'
import { ingestSimulatedEvent } from '../packages/persistence/inbound.js'
import { loadConfig } from '../packages/runtime/config.js'

import { prepareSimulatedRun, runQueuedEvent } from '../packages/persistence/run-context.js'

const config = loadConfig()
const db = createDatabase(config.databaseUrl)
const fixtureKey = `integration-${randomUUID()}`
const occurredAt = new Date('2026-11-06T00:00:00.000Z')

async function createFixture() {
  return db.$transaction(async (tx) => {
    const character = await tx.character.create({ data: { slug: fixtureKey } })
    await tx.coreVersion.create({
      data: {
        characterId: character.id,
        version: 1,
        hardProfile: { aiDisclosure: 'Simulated AI character' },
        actorId: fixtureKey,
        reason: 'Integration fixture',
      },
    })
    await tx.character.update({
      where: { id: character.id },
      data: { activeCoreVersion: 1, status: 'ACTIVE' },
    })

    const accounts = []
    for (const [slug, platform] of [
      ['company', 'mock-a'],
      ['public', 'mock-b'],
      ['private', 'mock-a'],
    ] as const) {
      const identity = await tx.identity.create({ data: { characterId: character.id, slug } })
      await tx.identityVersion.create({
        data: {
          characterId: character.id,
          identityId: identity.id,
          version: 1,
          roleProfile: { slug },
          actorId: fixtureKey,
          reason: 'Integration fixture',
        },
      })
      await tx.identity.update({
        where: { id: identity.id },
        data: { activeVersion: 1, status: 'ACTIVE' },
      })
      const account = await tx.platformAccount.create({
        data: {
          characterId: character.id,
          identityId: identity.id,
          platform,
          instanceKey: 'integration',
          remoteAccountId: `${fixtureKey}-${slug}`,
          status: 'ACTIVE',
        },
      })
      accounts.push(account)
    }
    return { characterId: character.id, accounts }
  })
}

let fixture: Awaited<ReturnType<typeof createFixture>> | undefined
before(async () => { fixture = await createFixture() })
after(async () => {
  try {
    if (fixture) {
      const { characterId } = fixture
      await db.$transaction(async (tx) => {
        await tx.outboxEvent.deleteMany({ where: { run: { characterId } } })
        await tx.agentRun.deleteMany({ where: { characterId } })
        await tx.inboundEvent.deleteMany({ where: { characterId } })
        await tx.memoryGrant.deleteMany({ where: { characterId } })
        await tx.memorySource.deleteMany({ where: { characterId } })
        await tx.memory.deleteMany({ where: { characterId } })
        await tx.sourceRecord.deleteMany({ where: { characterId } })
        await tx.conversation.deleteMany({ where: { characterId } })
        await tx.contact.deleteMany({ where: { characterId } })
        await tx.platformAccount.deleteMany({ where: { characterId } })
        await tx.identity.updateMany({
          where: { characterId },
          data: { status: 'PAUSED', activeVersion: null },
        })
        await tx.identityVersion.deleteMany({ where: { characterId } })
        await tx.identity.deleteMany({ where: { characterId } })
        await tx.character.update({
          where: { id: characterId },
          data: { status: 'PAUSED', activeCoreVersion: null },
        })
        await tx.coreVersion.deleteMany({ where: { characterId } })
        await tx.character.delete({ where: { id: characterId } })
      })
    }
  } finally {
    await db.$disconnect()
  }
})

async function consumeRuns(runIds: string[]) {
  const worker = startOutboxWorker(config.databaseUrl, config.redisUrl)
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const processed = await db.outboxEvent.findMany({
        where: { runId: { in: runIds }, type: runQueuedEvent, processedAt: { not: null } },
        select: { eventId: true },
      })
      if (processed.length === runIds.length) return processed
      await sleep(100)
    }
    assert.fail('Timed out waiting for simulated runs to be consumed')
  } finally {
    await worker.close()
  }
}

test('concurrent retries keep one run per account and source event', async () => {
  assert.ok(fixture)
  const { characterId, accounts: [company, publicAccount] } = fixture
  const event = { sourceKey: 'message-1', kind: 'MENTION', occurredAt } as const
  const retries = Array.from({ length: 100 }, () =>
    ingestSimulatedEvent(db, { ...event, accountId: company.id }),
  )
  const [sameAccount, otherAccount] = await Promise.all([
    Promise.all(retries),
    ingestSimulatedEvent(db, { ...event, accountId: publicAccount.id }),
  ])
  assert.equal(sameAccount.filter(({ status }) => status === 'ACCEPTED').length, 1)
  assert.equal(sameAccount.filter(({ status }) => status === 'DUPLICATE').length, 99)
  const accepted = sameAccount.find(({ status }) => status === 'ACCEPTED')
  assert.ok(accepted && accepted.status === 'ACCEPTED')
  assert.ok(sameAccount.every((result) => 'runId' in result && result.runId === accepted.runId))
  assert.equal(otherAccount.status, 'ACCEPTED')
  assert.equal(await db.inboundEvent.count({ where: { characterId, sourceKey: event.sourceKey } }), 2)

  const runs = await db.agentRun.findMany({ where: { characterId } })
  assert.equal(runs.length, 2)
  for (const account of [company, publicAccount]) {
    const run = runs.find(({ accountId }) => accountId === account.id)
    assert.ok(run)
    assert.equal(run.identityId, account.identityId)
    assert.equal(run.coreVersion, 1)
    assert.equal(run.identityVersion, 1)
    assert.equal(run.bindingVersion, account.bindingVersion)
    assert.equal(run.mode, 'SIMULATION')
    assert.equal(run.state, 'QUEUED')
  }
  const runIds = runs.map(({ id }) => id)
  const queued = await db.outboxEvent.count({ where: { runId: { in: runIds }, type: runQueuedEvent } })
  assert.equal(queued, 2)

  const processed = await consumeRuns(runIds)
  await prepareSimulatedRun(db, processed[0].eventId)
  const prepared = await db.agentRun.findMany({ where: { id: { in: runIds } } })
  assert.equal(prepared.length, 2)
  assert.ok(prepared.every((run) =>
    run.state === 'CONTEXT_READY' && run.stateVersion === 2 && run.stateReason === null,
  ))
})

test('the worker cancels paused or stale runs without changing their bound account', async () => {
  assert.ok(fixture)
  const account = fixture.accounts[2]
  const beforePause = await ingestSimulatedEvent(db, {
    accountId: account.id, sourceKey: 'before-pause', kind: 'POST', occurredAt,
  })
  const beforeRevocation = await ingestSimulatedEvent(db, {
    accountId: fixture.accounts[0].id, sourceKey: 'before-revocation', kind: 'POST', occurredAt,
  })
  assert.equal(beforePause.status, 'ACCEPTED')
  assert.equal(beforeRevocation.status, 'ACCEPTED')
  await db.character.update({
    where: { id: fixture.characterId },
    data: { authEpoch: { increment: 1 } },
  })
  await db.platformAccount.update({ where: { id: account.id }, data: { status: 'PAUSED' } })
  const result = await ingestSimulatedEvent(db, {
    accountId: account.id, sourceKey: 'paused', kind: 'POST', occurredAt,
  })
  assert.equal(result.status, 'ACCOUNT_UNAVAILABLE')
  assert.equal(await db.inboundEvent.count({ where: { characterId: fixture.characterId, sourceKey: 'paused' } }), 0)
  await consumeRuns([beforePause.runId, beforeRevocation.runId])
  const paused = await db.agentRun.findUniqueOrThrow({ where: { id: beforePause.runId } })
  const stale = await db.agentRun.findUniqueOrThrow({ where: { id: beforeRevocation.runId } })
  assert.equal(paused.state, 'CANCELED')
  assert.equal(paused.stateReason, 'ACCOUNT_UNAVAILABLE')
  assert.equal(paused.accountId, account.id)
  assert.equal(stale.state, 'CANCELED')
  assert.equal(stale.stateReason, 'BINDING_CHANGED')
  assert.equal(stale.accountId, fixture.accounts[0].id)
})

test('PostgreSQL rejects an inbound event with a mismatched identity binding', async () => {
  assert.ok(fixture)
  const [company, publicAccount] = fixture.accounts
  await assert.rejects(db.inboundEvent.create({
    data: {
      accountId: company.id,
      characterId: fixture.characterId,
      identityId: publicAccount.identityId,
      sourceKey: 'mismatched-identity',
      kind: 'REPLY',
      occurredAt,
    },
  }), { code: 'P2003' })
})

async function preparedMemoryRun(accountId: string, scope: { conversationId?: string; contactId?: string } = {}) {
  const result = await ingestSimulatedEvent(db, {
    ...scope, accountId, sourceKey: randomUUID(), kind: 'MENTION', occurredAt,
  })
  assert.equal(result.status, 'ACCEPTED')
  const queued = await db.outboxEvent.findFirstOrThrow({
    where: { runId: result.runId, type: runQueuedEvent },
  })
  await prepareSimulatedRun(db, queued.eventId)
  return result.runId
}

async function testMemory(
  scope: MemoryScope,
  visibility: MemoryVisibility,
  owner: { identityId?: string; accountId?: string; conversationId?: string } = {},
  classification = visibility,
) {
  assert.ok(fixture)
  const { characterId } = fixture
  return db.$transaction(async (tx) => {
    const source = await tx.sourceRecord.create({
      data: { ...owner, characterId, kind: 'fixture', sourceKey: randomUUID(), classification },
    })
    const memory = await tx.memory.create({
      data: {
        ...owner, characterId, scope, visibility, content: 'fixture memory',
        coreApprovedAt: scope === 'CORE' ? occurredAt : null,
      },
    })
    await tx.memorySource.create({ data: { characterId, memoryId: memory.id, sourceId: source.id } })
    return { memory, source }
  })
}

async function testGrant(
  memoryId: string,
  recipient: { id: string; identityId: string },
  purpose: MemoryPurpose,
  audience: string | null = null,
  expired = false,
  privateTarget?: { recipientConversationId: string; recipientContactId: string },
) {
  assert.ok(fixture)
  return db.memoryGrant.create({
    data: {
      ...privateTarget, characterId: fixture.characterId, memoryId, purpose, audience,
      recipientIdentityId: recipient.identityId, recipientAccountId: recipient.id,
      validFrom: new Date('2000-01-01T00:00:00Z'),
      validUntil: new Date(expired ? '2001-01-01T00:00:00Z' : '2999-01-01T00:00:00Z'),
      approvedBy: fixtureKey, reason: 'Integration fixture',
    },
  })
}

test('memory retrieval respects native scope and rejects confidential provenance across identities', async () => {
  assert.ok(fixture)
  const [company, personal] = fixture.accounts
  const { memory: core } = await testMemory('CORE', 'PUBLIC')
  const { memory: own } = await testMemory('IDENTITY', 'PERSONAL', { identityId: personal.identityId })
  const { memory: account } = await testMemory('ACCOUNT', 'PERSONAL', {
    identityId: personal.identityId, accountId: personal.id,
  })
  const { memory: companySecret } = await testMemory('IDENTITY', 'PUBLIC', {
    identityId: company.identityId,
  }, 'CONFIDENTIAL')
  await testGrant(companySecret.id, personal, 'DECISION_SUPPORT')

  const runId = await preparedMemoryRun(personal.id)
  const candidates = await listAuthorizedMemoryCandidates(db, runId, { purpose: 'DECISION_SUPPORT' })
  assert.deepEqual(new Set(candidates.map(({ id }) => id)), new Set([core.id, own.id, account.id]))
  await assert.rejects(db.memory.create({
    data: {
      characterId: fixture.characterId, identityId: company.identityId, accountId: personal.id,
      scope: 'ACCOUNT', visibility: 'PERSONAL', content: 'invalid binding',
    },
  }), { code: 'P2003' })
})

test('cross-identity grants are limited to purpose, recipient account, audience and validity', async () => {
  assert.ok(fixture)
  const [company, personal] = fixture.accounts
  const anotherAccount = await db.platformAccount.create({
    data: {
      characterId: fixture.characterId, identityId: personal.identityId, platform: 'mock-b',
      instanceKey: 'integration', remoteAccountId: fixtureKey + '-extra', status: 'ACTIVE',
    },
  })
  const { memory } = await testMemory('IDENTITY', 'PUBLIC', { identityId: company.identityId })
  const { memory: expired } = await testMemory('IDENTITY', 'PUBLIC', { identityId: company.identityId })
  await testGrant(memory.id, personal, 'DECISION_SUPPORT')
  await testGrant(memory.id, personal, 'PUBLIC_REFERENCE', 'public-feed')
  await testGrant(expired.id, personal, 'DECISION_SUPPORT', null, true)

  const personalRun = await preparedMemoryRun(personal.id)
  const otherRun = await preparedMemoryRun(anotherAccount.id)
  const decision = await listAuthorizedMemoryCandidates(db, personalRun, { purpose: 'DECISION_SUPPORT' })
  assert.ok(decision.some(({ id }) => id === memory.id))
  assert.ok(!decision.some(({ id }) => id === expired.id))
  assert.ok(!(await listAuthorizedMemoryCandidates(db, personalRun, { purpose: 'INTERNAL_CONTEXT' }))
    .some(({ id }) => id === memory.id))
  assert.ok(!(await listAuthorizedMemoryCandidates(db, otherRun, { purpose: 'DECISION_SUPPORT' }))
    .some(({ id }) => id === memory.id))
  const publicRead = await listAuthorizedMemoryCandidates(db, personalRun, {
    purpose: 'PUBLIC_REFERENCE', audience: 'public-feed',
  })
  assert.deepEqual(publicRead.map(({ id }) => id), [memory.id])
  const mismatchedAudience = await listAuthorizedMemoryCandidates(db, personalRun, {
    purpose: 'PUBLIC_REFERENCE', audience: 'different-feed',
  })
  assert.deepEqual(mismatchedAudience, [])
})

test('grant and source revocation invalidate old runs and remove candidates for new runs', async () => {
  assert.ok(fixture)
  const { characterId, accounts: [company, personal] } = fixture
  const { memory: shared } = await testMemory('IDENTITY', 'PUBLIC', { identityId: company.identityId })
  const { memory: native, source } = await testMemory('IDENTITY', 'PERSONAL', { identityId: personal.identityId })
  const grant = await testGrant(shared.id, personal, 'DECISION_SUPPORT')
  const runId = await preparedMemoryRun(personal.id)
  const purpose = { purpose: 'DECISION_SUPPORT' } as const
  const before = await db.character.findUniqueOrThrow({ where: { id: characterId } })
  const candidates = await listAuthorizedMemoryCandidates(db, runId, purpose)
  assert.ok(candidates.some(({ id }) => id === shared.id))
  assert.ok(candidates.some(({ id }) => id === native.id))

  assert.equal(await revokeMemoryAccess(db, { kind: 'GRANT', characterId, id: grant.id }), true)
  assert.equal(await revokeMemoryAccess(db, { kind: 'GRANT', characterId, id: grant.id }), false)
  assert.equal(await revokeMemoryAccess(db, { kind: 'SOURCE', characterId, id: source.id }), true)
  assert.deepEqual(await listAuthorizedMemoryCandidates(db, runId, purpose), [])
  const after = await db.character.findUniqueOrThrow({ where: { id: characterId } })
  assert.equal(after.authEpoch, before.authEpoch + 2)
  const newRun = await preparedMemoryRun(personal.id)
  const remaining = await listAuthorizedMemoryCandidates(db, newRun, purpose)
  assert.ok(!remaining.some(({ id }) => id === shared.id || id === native.id))
})

async function privateThread(
  account: { characterId: string; identityId: string; id: string },
  privateContactId?: string,
) {
  const binding = {
    characterId: account.characterId, identityId: account.identityId, accountId: account.id,
  }
  const contactId = privateContactId ?? (await db.contact.create({
    data: { ...binding, remoteKey: randomUUID() },
  })).id
  const conversation = await db.conversation.create({
    data: { ...binding, channel: 'PRIVATE', privateContactId: contactId, remoteKey: randomUUID() },
  })
  return { conversationId: conversation.id, contactId }
}

test('private ingress rejects a different account or contact without creating a run', async () => {
  assert.ok(fixture)
  const [company, personal] = fixture.accounts
  const scope = await privateThread(personal)
  const another = await privateThread(personal)
  const event = { sourceKey: 'mismatched-private-ingress', kind: 'REPLY', occurredAt } as const
  for (const input of [
    { ...scope, accountId: company.id },
    { ...scope, accountId: personal.id, contactId: another.contactId },
    { conversationId: scope.conversationId, accountId: personal.id },
  ]) {
    const result = await ingestSimulatedEvent(db, { ...event, ...input })
    assert.equal(result.status, 'CONVERSATION_UNAVAILABLE')
  }
  assert.equal(await db.inboundEvent.count({
    where: { characterId: fixture.characterId, sourceKey: event.sourceKey },
  }), 0)
})

test('private reply requires an exact recipient grant and private provenance never becomes public', async () => {
  assert.ok(fixture)
  const account = fixture.accounts[1]
  const scope = await privateThread(account)
  const other = await privateThread(account, scope.contactId)
  const wrongRecipient = await privateThread(account)
  const run = await preparedMemoryRun(account.id, scope)
  const otherRun = await preparedMemoryRun(account.id, other)
  const publicRun = await preparedMemoryRun(account.id)
  const { memory, source } = await testMemory('CONVERSATION', 'PUBLIC', {
    identityId: account.identityId, accountId: account.id, conversationId: scope.conversationId,
  })
  const derived = await db.memory.create({
    data: {
      characterId: account.characterId, identityId: account.identityId,
      scope: 'IDENTITY', visibility: 'PUBLIC', content: 'Derived from a private conversation',
    },
  })
  await db.memorySource.create({
    data: { characterId: account.characterId, memoryId: derived.id, sourceId: source.id },
  })
  const purpose = { purpose: 'PRIVATE_REPLY' } as const
  assert.deepEqual(await listAuthorizedMemoryCandidates(db, run, purpose), [])
  await assert.rejects(testGrant(memory.id, account, 'PRIVATE_REPLY', null, false, {
    recipientConversationId: scope.conversationId, recipientContactId: wrongRecipient.contactId,
  }), { code: 'P2003' })
  await testGrant(memory.id, account, 'PRIVATE_REPLY', null, false, {
    recipientConversationId: scope.conversationId, recipientContactId: scope.contactId,
  })
  await testGrant(memory.id, account, 'PUBLIC_REFERENCE', 'private-provenance')
  await testGrant(derived.id, account, 'PUBLIC_REFERENCE', 'private-provenance')

  assert.deepEqual((await listAuthorizedMemoryCandidates(db, run, purpose)).map(({ id }) => id), [memory.id])
  assert.deepEqual(await listAuthorizedMemoryCandidates(db, otherRun, purpose), [])
  assert.deepEqual(await listAuthorizedMemoryCandidates(db, publicRun, purpose), [])
  assert.deepEqual(await listAuthorizedMemoryCandidates(db, publicRun, {
    purpose: 'PUBLIC_REFERENCE', audience: 'private-provenance',
  }), [])
  const outside = await listAuthorizedMemoryCandidates(db, otherRun, { purpose: 'INTERNAL_CONTEXT' })
  assert.ok(!outside.some(({ id }) => id === memory.id || id === derived.id))
})

test('conversation recipients cannot be rebound and duplicate ingress preserves the original scope', async () => {
  assert.ok(fixture)
  const account = fixture.accounts[1]
  const scope = await privateThread(account)
  const other = await privateThread(account)
  const event = { accountId: account.id, sourceKey: 'recipient-stays-bound', kind: 'REPLY', occurredAt } as const
  const result = await ingestSimulatedEvent(db, { ...event, ...scope })
  assert.equal(result.status, 'ACCEPTED')
  await assert.rejects(db.$executeRaw`
    UPDATE conversations SET private_contact_id = ${other.contactId}::uuid
    WHERE id = ${scope.conversationId}::uuid
  `, /Conversation binding cannot change/)
  const replay = await ingestSimulatedEvent(db, { ...event, ...other })
  assert.deepEqual(replay, { status: 'DUPLICATE', runId: result.runId })
  await consumeRuns([result.runId])
  const run = await db.agentRun.findUniqueOrThrow({
    where: { id: result.runId },
    include: { inboundEvent: true },
  })
  assert.equal(run.state, 'CONTEXT_READY')
  assert.equal(run.inboundEvent.conversationId, scope.conversationId)
  assert.equal(run.inboundEvent.contactId, scope.contactId)
})

function testDatabaseRole(role: 'rica_runtime' | 'rica_memory_reader' | 'rica_memory_admin') {
  const url = new URL(config.databaseUrl)
  const options = url.searchParams.get('options')
  url.searchParams.set('options', [options, '-c role=' + role].filter(Boolean).join(' '))
  return createDatabase(url.toString())
}

test('runtime role can prepare and read a run through policy but cannot read raw memory', async () => {
  assert.ok(fixture)
  const personal = fixture.accounts[1]
  const { memory } = await testMemory('IDENTITY', 'PERSONAL', { identityId: personal.identityId })
  const runtime = testDatabaseRole('rica_runtime')
  try {
    const [permission] = await runtime.$queryRaw<{ canSetReader: boolean; canSetAdmin: boolean }[]>`
      SELECT pg_has_role(current_user, 'rica_memory_reader', 'SET') AS "canSetReader",
             pg_has_role(current_user, 'rica_memory_admin', 'SET') AS "canSetAdmin"
    `
    assert.deepEqual(permission, { canSetReader: true, canSetAdmin: false })
    const result = await ingestSimulatedEvent(runtime, {
      accountId: personal.id, sourceKey: randomUUID(), kind: 'MENTION', occurredAt,
    })
    assert.equal(result.status, 'ACCEPTED')
    const event = await runtime.outboxEvent.findFirstOrThrow({
      where: { runId: result.runId, type: runQueuedEvent },
    })
    await prepareSimulatedRun(runtime, event.eventId)
    const candidates = await listAuthorizedMemoryCandidates(runtime, result.runId, { purpose: 'INTERNAL_CONTEXT' })
    assert.ok(candidates.some(({ id }) => id === memory.id))
    await assert.rejects(runtime.$queryRaw`SELECT content FROM public.memories`, /permission denied/)
  } finally {
    await runtime.$disconnect()
  }
})

test('direct memory reads enforce identity and character scope and a reused connection loses context', async () => {
  assert.ok(fixture)
  const { characterId, accounts: [company, personal] } = fixture
  const { memory: own } = await testMemory('IDENTITY', 'PERSONAL', { identityId: personal.identityId })
  const { memory: secret } = await testMemory('IDENTITY', 'CONFIDENTIAL', { identityId: company.identityId })
  const foreign = await db.character.create({ data: { slug: fixtureKey + '-foreign' } })
  const reader = testDatabaseRole('rica_memory_reader')
  try {
    const foreignMemory = await db.memory.create({
      data: {
        characterId: foreign.id, scope: 'CORE', visibility: 'PUBLIC', coreApprovedAt: occurredAt,
        content: 'another character',
      },
    })
    const source = await db.sourceRecord.create({
      data: { characterId: foreign.id, kind: 'fixture', sourceKey: fixtureKey, classification: 'PUBLIC' },
    })
    await db.memorySource.create({
      data: { characterId: foreign.id, memoryId: foreignMemory.id, sourceId: source.id },
    })
    const pid = await reader.$transaction(async (tx) => {
      const scope = JSON.stringify({
        character_id: characterId, identity_id: personal.identityId, account_id: personal.id,
        purpose: 'INTERNAL_CONTEXT',
      })
      await tx.$queryRaw`SELECT set_config('rica.memory_scope', ${scope}, true)`
      const rows = await tx.$queryRaw<{ id: string; pid: number }[]>`
        SELECT id, pg_backend_pid() AS pid FROM public.memories
        WHERE id IN (${own.id}::uuid, ${secret.id}::uuid, ${foreignMemory.id}::uuid)
      `
      assert.deepEqual(rows.map(({ id }) => id), [own.id])
      return rows[0].pid
    })
    const [after] = await reader.$queryRaw<{ pid: number; visible: number }[]>`
      SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM public.memories) AS visible
    `
    assert.deepEqual(after, { pid, visible: 0 })
  } finally {
    await reader.$disconnect()
    await db.$transaction(async (tx) => {
      await tx.memorySource.deleteMany({ where: { characterId: foreign.id } })
      await tx.sourceRecord.deleteMany({ where: { characterId: foreign.id } })
      await tx.memory.deleteMany({ where: { characterId: foreign.id } })
      await tx.character.delete({ where: { id: foreign.id } })
    })
  }
})

test('memory administration can revoke a source without gaining account write access', async () => {
  assert.ok(fixture)
  const account = fixture.accounts[1]
  const { source } = await testMemory('IDENTITY', 'PERSONAL', { identityId: account.identityId })
  const admin = testDatabaseRole('rica_memory_admin')
  try {
    assert.equal(await revokeMemoryAccess(admin, {
      kind: 'SOURCE', characterId: account.characterId, id: source.id,
    }), true)
    await assert.rejects(admin.$executeRaw`
      UPDATE public.platform_accounts SET status = 'PAUSED' WHERE id = ${account.id}::uuid
    `, /permission denied/)
  } finally {
    await admin.$disconnect()
  }
})
