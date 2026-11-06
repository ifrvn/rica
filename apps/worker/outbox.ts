import { setTimeout as sleep } from 'node:timers/promises'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { createDatabase } from '../../packages/persistence/client.js'
import { draftQueuedEvent, prepareSimulatedRun, runQueuedEvent } from '../../packages/persistence/run-context.js'
import { processSimulatedDraft } from '../../packages/persistence/simulated-draft.js'

export const smokeEvent = 'BootstrapSmoke.v1'
const queueName = 'character-bootstrap'

export function startOutboxWorker(databaseUrl: string, redisUrl: string) {
  const db = createDatabase(databaseUrl)
  const producer = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  const consumer = new Redis(redisUrl, { maxRetriesPerRequest: null })
  const queue = new Queue<{ eventId: string }>(queueName, { connection: producer })
  const worker = new Worker<{ eventId: string }>(queueName, async ({ name, data }) => {
    if (name === runQueuedEvent) {
      await prepareSimulatedRun(db, data.eventId)
      return
    }
    if (name === draftQueuedEvent) {
      await processSimulatedDraft(db, data.eventId)
      return
    }
    if (name !== smokeEvent) throw new Error('Unknown outbox job')
    await db.outboxEvent.updateMany({
      where: { eventId: data.eventId, type: smokeEvent, processedAt: null },
      data: { processedAt: new Date() },
    })
  }, { connection: consumer })
  const stop = new AbortController()

  const logError = () => console.warn(JSON.stringify({ service: 'worker', event: 'dependency_error' }))
  worker.on('error', logError)
  queue.on('error', logError)

  async function relay() {
    while (!stop.signal.aborted) {
      try {
        // Re-publish unconsumed events after a restart or Redis data loss.
        const pending = await db.outboxEvent.findMany({
          where: {
            type: { in: [smokeEvent, runQueuedEvent, draftQueuedEvent] },
            processedAt: null,
            OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(Date.now() - 10_000) } }],
          },
          orderBy: { createdAt: 'asc' },
          take: 25,
        })
        for (const { eventId, type } of pending) {
          if (stop.signal.aborted) break
          await queue.add(type, { eventId }, {
            jobId: eventId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: true,
          })
          await db.outboxEvent.update({
            where: { eventId },
            data: { enqueuedAt: new Date() },
          })
        }
      } catch {
        logError()
      }
      await sleep(1000, undefined, { signal: stop.signal }).catch(() => {})
    }
  }

  const loop = relay()
  return {
    async close() {
      stop.abort()
      await loop
      try {
        await Promise.all([worker.close(), queue.close()])
      } finally {
        producer.disconnect()
        consumer.disconnect()
        await db.$disconnect()
      }
    },
  }
}
