import { Prisma } from '@ricajs/persistence/prisma'

export const newbiRetentionSweep = Prisma.sql`public.rica_sweep_newbi_retention() + public.rica_sweep_newbi_events() + public.rica_sweep_newbi_assessments()`
