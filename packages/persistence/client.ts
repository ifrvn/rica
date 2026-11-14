import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from './generated/client.js'

export type RawQueryClient = {
  $queryRaw<T>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>
}

export function createDatabase(connectionString: string) {
  const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: 2000, statement_timeout: 2000 })
  return new PrismaClient({ adapter })
}
