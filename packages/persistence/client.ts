import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from './generated/client.js'

export type RawQueryClient = {
  $queryRaw<T>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>
}

export function createDatabase(connectionString: string, role?: 'rica_admin_api' | 'rica_simulation_executor') {
  if (role) {
    const url = new URL(connectionString)
    const options = url.searchParams.get('options')
    url.searchParams.set('options', [options, '-c role=' + role].filter(Boolean).join(' '))
    connectionString = url.href
  }
  const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: 2000, statement_timeout: 2000 })
  return new PrismaClient({ adapter })
}
