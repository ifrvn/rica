import { Prisma, type PrismaClient } from '@ricajs/persistence/prisma'

export async function sweepSimulationRetention(db: PrismaClient, additionalSweep = Prisma.sql`0`) {
  const [row] = await db.$queryRaw<{ changed: number }[]>`
    SELECT public.rica_sweep_simulation_retention() + public.rica_sweep_model_prompts() + (${additionalSweep}) AS changed
  `
  return row.changed
}
