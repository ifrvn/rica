import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { outboxQueueName, smokeEvent, startOutboxWorker } from '../apps/worker/outbox.js'
import { createDatabase } from '../packages/persistence/client.js'
import { loadConfig } from '../packages/runtime/config.js'
import { startCognitionPlugins } from '../apps/runtime-plugins.js'

const config = loadConfig()
const db = createDatabase(config.databaseUrl)
const runtimeUrl = new URL(config.databaseUrl)
runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
const redis = new Redis(config.redisUrl, {
  commandTimeout: 2000,
  connectTimeout: 1500,
  maxRetriesPerRequest: 0,
})
redis.on('error', () => {})
const queue = new Queue(outboxQueueName, { connection: redis })
queue.on('error', () => {})

function launchWorker(overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/main.ts'], {
    env: {
      ...process.env, DATABASE_URL: runtimeUrl.toString(), REDIS_URL: config.redisUrl,
      RICA_MODEL_PROVIDER: 'simulated', ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  const closed = once(child, 'close')
  return { child, closed, output: () => output }
}

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  assert.fail(message)
}

try {
  await redis.ping()
  const missingDatabase = new URL(runtimeUrl)
  missingDatabase.pathname = '/missing-' + randomUUID()
  const unavailable = launchWorker({ DATABASE_URL: missingDatabase.toString(), REDIS_URL: 'redis://127.0.0.1:1' })
  try {
    await waitFor(async () => unavailable.child.exitCode !== null, 'Worker did not exit after failed readiness')
    const [code] = await unavailable.closed
    assert.equal(code, 1)
    assert.match(unavailable.output(), /"event":"not_ready","modelId":"simulated","dependencies":\["postgres","redis"\]/)
    assert.doesNotMatch(unavailable.output(), /"event":"ready"|missing-|redis:\/\//)
  } finally {
    if (unavailable.child.exitCode === null) unavailable.child.kill('SIGKILL')
    await unavailable.closed
  }

  const pending = await Promise.all([1, 2].map(() => db.outboxEvent.create({ data: { type: smokeEvent } })))
  const ids = pending.map(({ eventId }) => eventId)
  await queue.pause()
  try {
    const relay = launchWorker()
    try {
      await waitFor(async () => {
        const persisted = await db.outboxEvent.count({
          where: { eventId: { in: ids }, enqueuedAt: { not: null }, processedAt: null },
        })
        return persisted === ids.length && (await Promise.all(ids.map((id) => queue.getJob(id)))).every(Boolean)
      }, 'Worker did not enqueue both outbox jobs before the crash')
      assert.match(relay.output(), /"event":"ready","modelId":"simulated"/)
    } finally {
      relay.child.kill('SIGKILL')
      const [, signal] = await relay.closed
      assert.equal(signal, 'SIGKILL')
    }
    assert.equal(await db.outboxEvent.count({ where: { eventId: { in: ids }, processedAt: null } }), ids.length)
    const lostJob = await queue.getJob(ids[1])
    assert.ok(lostJob)
    await lostJob.remove()
    await db.outboxEvent.update({
      where: { eventId: ids[1] }, data: { enqueuedAt: new Date(Date.now() - 11_000) },
    })
  } finally {
    await queue.resume()
  }

  const plugins = await startCognitionPlugins({})
  const worker = await startOutboxWorker(runtimeUrl.toString(), config.redisUrl, plugins.model, plugins.platformVersion)
  try {
    await waitFor(async () => await db.outboxEvent.count({
      where: { eventId: { in: ids }, enqueuedAt: { not: null }, processedAt: { not: null } },
    }) === ids.length, 'Expected the surviving and re-published jobs to be processed after restart')
    console.info('Outbox crash recovery and worker readiness passed')
  } finally {
    await worker.close()
    await plugins.stop()
  }
} finally {
  try {
    await queue.close()
  } finally {
    redis.disconnect()
    await db.$disconnect()
  }
}
