import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { startOutboxWorker, smokeEvent } from '../apps/worker/outbox.js'
import { createDatabase } from '../packages/persistence/client.js'
import { loadConfig } from '../packages/runtime/config.js'

const config = loadConfig()
const db = createDatabase(config.databaseUrl)
const redis = new Redis(config.redisUrl, {
  commandTimeout: 2000,
  connectTimeout: 1500,
  maxRetriesPerRequest: 0,
})
redis.on('error', () => {})
try {
  await redis.ping()
  const { eventId } = await db.outboxEvent.create({ data: { type: smokeEvent } })
  const worker = startOutboxWorker(config.databaseUrl, config.redisUrl)
  try {
    const deadline = Date.now() + 15_000
    let event = await db.outboxEvent.findUniqueOrThrow({ where: { eventId } })
    while ((!event.processedAt || !event.enqueuedAt) && Date.now() < deadline) {
      await sleep(150)
      event = await db.outboxEvent.findUniqueOrThrow({ where: { eventId } })
    }
    assert.ok(event.enqueuedAt && event.processedAt, 'Expected the outbox event to be delivered and processed')
    console.info('Outbox smoke passed')
  } finally {
    await worker.close()
  }
} finally {
  redis.disconnect()
  await db.$disconnect()
}
