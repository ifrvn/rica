import 'dotenv/config'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDatabase } from '../../packages/persistence/client.js'
import { runSimulationBatch } from '../../packages/persistence/simulation-execution.js'
import { startSimulationPlatforms } from '../runtime-plugins.js'

const url = process.env.RICA_SIMULATION_EXECUTION_DATABASE_URL
if (!url || !URL.canParse(url) || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
  throw new Error('Invalid or missing RICA_SIMULATION_EXECUTION_DATABASE_URL')
}
const platforms = await startSimulationPlatforms(process.env, 'simulation-executor')
const db = createDatabase(url)
const stop = new AbortController()
process.once('SIGINT', () => stop.abort())
process.once('SIGTERM', () => stop.abort())

let cursor: string | null = null
try {
  while (!stop.signal.aborted) {
    try {
      cursor = await runSimulationBatch(db, cursor, platforms.version)
    } catch {
      console.warn(JSON.stringify({ service: 'simulation-executor', event: 'batch_failed' }))
    }
    await sleep(1000, undefined, { signal: stop.signal }).catch(() => {})
  }
} finally {
  await Promise.all([platforms.stop(), db.$disconnect()])
}
