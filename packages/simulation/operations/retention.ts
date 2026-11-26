import { Prisma, type PrismaClient } from '@ricajs/persistence/prisma'

export async function sweepSimulationRetention(db: PrismaClient, additionalSweep = Prisma.sql`0`) {
  const [row] = await db.$queryRaw<{ changed: number }[]>`
    SELECT public.rica_sweep_simulation_retention() + public.rica_sweep_model_prompts()
      + public.rica_sweep_obsolete_chat_replies() + public.rica_close_unapproved_im_reply() + (${additionalSweep}) AS changed
  `
  return row.changed
}
