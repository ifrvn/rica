import { Prisma, type PrismaClient } from './generated/client.js'

export async function sweepSimulationRetention(db: PrismaClient, additionalSweep = Prisma.sql`0`) {
  const [row] = await db.$queryRaw<{ changed: number }[]>`
    SELECT public.rica_sweep_simulation_retention() + (${additionalSweep}) AS changed
  `
  return row.changed
}
