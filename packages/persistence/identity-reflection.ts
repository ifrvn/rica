import type { PrismaClient } from './generated/client.js'

type IdentityScope = { id: string; characterId: string }

export async function scanIdentityReflections(db: PrismaClient, after: string | null) {
  const due = await db.$queryRaw<IdentityScope[]>`
    SELECT * FROM public.rica_due_reflections(${after}::uuid)
  `
  for (const { id, characterId } of due) {
    await db.$queryRaw`SELECT public.rica_reflect_identity(${characterId}::uuid, ${id}::uuid)`
  }
  return due.length === 16 ? due.at(-1)?.id ?? null : null
}
