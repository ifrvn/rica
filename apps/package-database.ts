import { Prisma } from '@ricajs/persistence/prisma'

export function packageObject(schema: string, object: string) {
  // PostgreSQL binds values, so identifiers must be quoted individually.
  return Prisma.raw([schema, object].map(name => '"' + name.replaceAll('"', '""') + '"').join('.'))
}
