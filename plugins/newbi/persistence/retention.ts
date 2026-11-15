import { Prisma } from '../../../packages/persistence/generated/client.js'

export const newbiRetentionSweep = Prisma.sql`public.rica_sweep_newbi_retention() + public.rica_sweep_newbi_events()`
