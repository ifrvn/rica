import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { scanIdentityReflections } from '../../packages/persistence/identity-reflection.js'
import { createDatabase } from '../../packages/persistence/client.js'
import { draftQueuedEvent, outboxAttemptFence, prepareSimulatedRun, runQueuedEvent } from '../../packages/persistence/run-context.js'
import { processSimulatedDraft } from '../../packages/persistence/simulated-draft.js'
import { sweepSimulationRetention } from '../../packages/persistence/simulation-retention.js'
import { scanSimulationSchedules } from '../../packages/persistence/simulation-schedules.js'
import type { ModelProvider } from '../../packages/runtime/model-provider.js'
import type { ResolveSimulationAdapter } from '../../packages/contracts/simulation-platform.js'
import type { Plugin } from '../../packages/runtime/plugin-registry.js'

export const smokeEvent = 'BootstrapSmoke.v1'
export const outboxQueueName = 'character-bootstrap'

type OutboxJob = { eventId: string; generation?: number }

export class WorkerDependencyUnavailable extends Error {
  constructor(readonly dependencies: ('postgres' | 'redis')[]) {
    super('Outbox worker dependencies unavailable')
  }
}

export async function startOutboxWorker(
  databaseUrl: string, redisUrl: string, model: Plugin<ModelProvider>, resolveAdapter: ResolveSimulationAdapter,
) {
  const db = createDatabase(databaseUrl)
  const producer = new Redis(redisUrl, {
    lazyConnect: true, connectTimeout: 1500, commandTimeout: 2000, maxRetriesPerRequest: 1,
  })
  const logError = () => console.warn(JSON.stringify({ service: 'worker', event: 'dependency_error' }))
  producer.on('error', logError)
  const [postgres, redis] = await Promise.allSettled([
    db.$queryRaw`SELECT event_id FROM public.outbox LIMIT 0`,
    producer.connect().then(() => producer.ping()),
  ])
  if (postgres.status === 'rejected' || redis.status === 'rejected') {
    producer.disconnect()
    await db.$disconnect()
    const dependencies: WorkerDependencyUnavailable['dependencies'] = []
    if (postgres.status === 'rejected') dependencies.push('postgres')
    if (redis.status === 'rejected') dependencies.push('redis')
    throw new WorkerDependencyUnavailable(dependencies)
  }
  const consumer = new Redis(redisUrl, { maxRetriesPerRequest: null })
  const queue = new Queue<OutboxJob>(outboxQueueName, { connection: producer })
  const worker = new Worker<OutboxJob>(outboxQueueName, async ({ name, data }) => {
    const { eventId, generation = 0 } = data
    let ticket: number | null = null
    try {
      if (name !== runQueuedEvent && name !== draftQueuedEvent && name !== smokeEvent) throw new Error('Unknown outbox job')
      const [claim] = await db.$queryRaw<{ ticket: number | null }[]>`
        SELECT public.rica_begin_outbox_attempt(${eventId}::uuid, ${name}, ${generation}::int) AS ticket
      `
      ticket = claim.ticket
      if (ticket === null) return
      const attempt = { generation, ticket }
      if (name === runQueuedEvent) {
        await prepareSimulatedRun(db, eventId, attempt)
      } else if (name === draftQueuedEvent) {
        await processSimulatedDraft(db, eventId, resolveAdapter, model, attempt)
      } else {
        await db.$executeRaw`
          UPDATE public.outbox SET processed_at = clock_timestamp()
          WHERE event_id = ${eventId}::uuid AND type = ${smokeEvent}
            AND processed_at IS NULL AND quarantined_at IS NULL ${outboxAttemptFence(attempt)}
        `
      }
    } catch {
      try {
        if (ticket !== null) await db.$queryRaw`
          SELECT public.rica_fail_outbox_attempt(${eventId}::uuid, ${generation}::int, ${ticket}::int)::text
        `
      } finally {
        // BullMQ records failure details in Redis. Keep plugin and payload data out of them.
        throw new Error('Outbox job failed')
      }
    }
  }, { connection: consumer, autorun: false })
  const stop = new AbortController()

  worker.on('error', logError)
  worker.on('failed', () => console.warn(JSON.stringify({ service: 'worker', event: 'job_failed' })))
  queue.on('error', logError)

  async function closeConnections(force = false) {
    try {
      await Promise.all([worker.close(force), queue.close()])
    } finally {
      producer.disconnect()
      consumer.disconnect()
      await db.$disconnect()
    }
  }

  try {
    await Promise.all([
      queue.waitUntilReady(),
      once(worker, 'ready', { signal: AbortSignal.timeout(4000) }),
    ])
  } catch {
    await closeConnections(true)
    throw new WorkerDependencyUnavailable(['redis'])
  }
  void worker.run().catch(logError)

  async function relay() {
    while (!stop.signal.aborted) {
      try {
        // Re-publish unconsumed events after a restart or Redis data loss.
        const pending = await db.outboxEvent.findMany({
          where: {
            type: { in: [smokeEvent, runQueuedEvent, draftQueuedEvent] },
            processedAt: null,
            quarantinedAt: null,
            OR: [{ enqueuedAt: null }, { enqueuedAt: { lt: new Date(Date.now() - 10_000) } }],
          },
          orderBy: { createdAt: 'asc' },
          take: 25,
        })
        for (const { eventId, type, generation } of pending) {
          if (stop.signal.aborted) break
          await queue.add(type, { eventId, generation }, {
            jobId: generation === 0 ? eventId : eventId + '-' + generation,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: true,
          })
          await db.outboxEvent.updateMany({
            where: { eventId, generation, quarantinedAt: null },
            data: { enqueuedAt: new Date() },
          })
        }
      } catch {
        logError()
      }
      await sleep(1000, undefined, { signal: stop.signal }).catch(() => {})
    }
  }

  async function scheduleLoop() {
    let cursor: string | null = null
    while (!stop.signal.aborted) {
      try {
        cursor = await scanSimulationSchedules(db, cursor)
      } catch {
        logError()
      }
      await sleep(1000, undefined, { signal: stop.signal }).catch(() => {})
    }
  }

  async function reflectionLoop() {
    let cursor: string | null = null
    while (!stop.signal.aborted) {
      try {
        cursor = await scanIdentityReflections(db, cursor)
      } catch {
        cursor = null
        logError()
      }
      await sleep(cursor ? 1000 : 60_000, undefined, { signal: stop.signal }).catch(() => {})
    }
  }

  async function retentionLoop() {
    while (!stop.signal.aborted) {
      let changed = 0
      try {
        changed = await sweepSimulationRetention(db)
      } catch {
        logError()
      }
      await sleep(changed > 0 ? 1000 : 60_000, undefined, { signal: stop.signal }).catch(() => {})
    }
  }

  const loops = [relay(), scheduleLoop(), reflectionLoop(), retentionLoop()]
  return {
    async close() {
      stop.abort()
      await Promise.all(loops)
      await closeConnections()
    },
  }
}
