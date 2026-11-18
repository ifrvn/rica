import 'dotenv/config'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDatabase } from '@ricajs/persistence/client'
import { runtimeDatabaseUrl } from '@ricajs/runtime/config'
import { runSimulationBatch } from '@ricajs/persistence/simulation-execution'
import { startSimulationPlatforms } from '../runtime-plugins.js'
import { observationError, reportPluginResult, startPluginHeartbeat } from '../plugin-observation.js'

const redisUrl = process.env.REDIS_URL
let url: string
try {
  url = runtimeDatabaseUrl()
} catch (error) {
  await reportPluginResult(redisUrl, 'simulation-executor', 'INVALID_CONFIG')
  throw error
}
const platforms = await startSimulationPlatforms(process.env, 'simulation-executor').catch(async (error: unknown) => {
  await reportPluginResult(redisUrl, 'simulation-executor', observationError(error, 'START_FAILED'))
  throw error
})
const db = createDatabase(url, 'rica_simulation_executor')
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
