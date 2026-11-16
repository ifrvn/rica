import { newbiRetentionSweep } from '@rica/plugin-newbi'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { sweepSimulationRetention } from '../../packages/persistence/simulation-retention.js'

export function sweepRuntimeRetention(db: PrismaClient) {
  return sweepSimulationRetention(db, newbiRetentionSweep)
}
