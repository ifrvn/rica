import { newbiRetentionSweep } from '@ricajs/plugin-newbi'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import { sweepSimulationRetention } from '@ricajs/persistence/simulation-retention'

export function sweepRuntimeRetention(db: PrismaClient) {
  return sweepSimulationRetention(db, newbiRetentionSweep)
}
