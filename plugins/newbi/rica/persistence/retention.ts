import { Prisma } from '@ricajs/persistence/prisma'

export const newbiRetentionSweep = Prisma.sql`rica_plugin_newbi.sweep_retention()`
