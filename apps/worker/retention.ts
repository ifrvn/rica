import { createDatabase } from '../../packages/persistence/client.js'
import { sweepRuntimeRetention } from './runtime-retention.js'
import { loadConfig } from '../../packages/runtime/config.js'

const db = createDatabase(loadConfig().databaseUrl)
try {
  let changed: number
  let total = 0
  do {
    changed = await sweepRuntimeRetention(db)
    total += changed
  } while (changed > 0)
  console.info(JSON.stringify({ service: 'retention', event: 'complete', changed: total }))
} finally {
  await db.$disconnect()
}
