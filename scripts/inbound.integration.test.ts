import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createDatabase } from '../packages/persistence/client.js'
import { ingestSimulatedEvent } from '../packages/persistence/inbound.js'
import { loadConfig } from '../packages/runtime/config.js'

const db = createDatabase(loadConfig().databaseUrl)
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
})

test('paused accounts do not fall back to an active account', async () => {
  assert.ok(fixture)
  const account = fixture.accounts[2]
  await db.platformAccount.update({ where: { id: account.id }, data: { status: 'PAUSED' } })
  const result = await ingestSimulatedEvent(db, {
    accountId: account.id, sourceKey: 'paused', kind: 'POST', occurredAt,
  })
  assert.equal(result.status, 'ACCOUNT_UNAVAILABLE')
  assert.equal(await db.inboundEvent.count({ where: { characterId: fixture.characterId, sourceKey: 'paused' } }), 0)
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
