import { PrismaPg } from '@prisma/adapter-pg'
import type { PrismaClient as HostClient } from '@ricajs/persistence/prisma'
import { PrismaClient } from '../../generated/client.js'

export type NewbiPrismaClient = PrismaClient

export type NewbiManagementDatabase = {
  host: HostClient
  newbi: NewbiPrismaClient
}

export function createNewbiDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl)
  const options = url.searchParams.get('options')
  url.searchParams.set('options', [options, '-c role=rica_admin_api'].filter(Boolean).join(' '))
  const adapter = new PrismaPg(
    { connectionString: url.href, connectionTimeoutMillis: 2000, statement_timeout: 2000 },
    { schema: 'rica_plugin_newbi' },
  )
  return new PrismaClient({ adapter })
}
