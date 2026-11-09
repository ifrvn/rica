import 'dotenv/config'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDatabase } from '../../packages/persistence/client.js'
import { runSimulationBatch } from '../../packages/persistence/simulation-execution.js'
import { startSimulationPlatforms } from '../runtime-plugins.js'
import { observationError, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'

const redisUrl = process.env.REDIS_URL
const url = process.env.RICA_SIMULATION_EXECUTION_DATABASE_URL
if (!url || !URL.canParse(url) || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
  await reportPluginResult(redisUrl, 'simulation-executor', 'INVALID_CONFIG')
  throw new Error('Invalid or missing RICA_SIMULATION_EXECUTION_DATABASE_URL')
}
const platforms = await startSimulationPlatforms(process.env, 'simulation-executor').catch(async (error: unknown) => {
  await reportPluginResult(redisUrl, 'simulation-executor', observationError(error, 'START_FAILED'))
  throw error
})
const db = createDatabase(url)
const stop = new AbortController()
process.once('SIGINT', () => stop.abort())
process.once('SIGTERM', () => stop.abort())

let cursor: string | null = null
let observation: ReturnType<typeof startPluginHeartbeat> | undefined
let reportedUnavailable = false
try {
  while (!stop.signal.aborted) {
    try {
      cursor = await runSimulationBatch(db, cursor, platforms.resolveAdapter)
      if (redisUrl && URL.canParse(redisUrl) && ['redis:', 'rediss:'].includes(new URL(redisUrl).protocol)) {
        observation ??= startPluginHeartbeat(redisUrl, 'simulation-executor', platforms.plugins)
        observation.ready()
      }
    } catch {
      observation?.failed('OPERATION_FAILED')
      if (!observation && !reportedUnavailable) {
        reportedUnavailable = true
        await reportPluginResult(redisUrl, 'simulation-executor', 'OPERATION_FAILED')
      }
      console.warn(JSON.stringify({ service: 'simulation-executor', event: 'batch_failed' }))
    }
    await sleep(1000, undefined, { signal: stop.signal }).catch(() => {})
  }
} finally {
  observation?.stop()
  await Promise.all([platforms.stop(), db.$disconnect()])
}
