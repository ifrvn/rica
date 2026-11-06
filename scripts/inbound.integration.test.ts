import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startOutboxWorker } from '../apps/worker/outbox.js'
import { createDatabase } from '../packages/persistence/client.js'
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
