import { logger } from '@ricajs/runtime/logging'
import { createDatabase } from '@ricajs/persistence/client'
import { checkPackageRetention, sweepRuntimeRetention } from './runtime-retention.js'
import { loadConfig } from '@ricajs/runtime/config'
import { loadPackageRetention } from '../package-plugins.js'

const config = loadConfig()
const sources = await loadPackageRetention(process.env.RICA_PLUGIN_MANIFEST)
const db = createDatabase(config.databaseUrl)
try {
  await checkPackageRetention(db, sources)
  let changed: number
  let total = 0
  do {
    changed = await sweepRuntimeRetention(db, sources)
    total += changed
  } while (changed > 0)
  logger.info({ service: 'retention', event: 'complete', changed: total })
} finally {
  await db.$disconnect()
}
