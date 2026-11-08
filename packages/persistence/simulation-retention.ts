import type { PrismaClient } from './generated/client.js'

export async function sweepSimulationRetention(db: PrismaClient) {
  const [row] = await db.$queryRaw<{ changed: number }[]>`
    SELECT public.rica_sweep_simulation_retention() AS changed
  `
  return row.changed
}
