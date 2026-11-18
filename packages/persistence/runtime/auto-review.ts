import { defaultAutoReviewPrompt } from '@ricajs/contracts/auto-review'
import type { AutoReviewSettings } from '@ricajs/contracts/auto-review'
import type { Prisma } from '../generated/client.js'

export async function readAutoReviewSettings(db: Pick<Prisma.TransactionClient, 'character'>, characterId: string) {
  const row = await db.character.findUnique({ where: { id: characterId },
    select: { autoReviewEnabled: true, autoReviewPrompt: true, autoReviewVersion: true },
  })
  return row && {
    enabled: row.autoReviewEnabled, prompt: row.autoReviewPrompt ?? defaultAutoReviewPrompt, version: row.autoReviewVersion,
  } satisfies AutoReviewSettings
}

// Serialize approval with admin policy changes and account/character controls.
export async function lockAutoReview(tx: Prisma.TransactionClient, characterId: string, version: number) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public.characters WHERE id = ${characterId}::uuid AND status = 'ACTIVE'
      AND auto_review_enabled AND auto_review_version = ${version} FOR UPDATE
  `
  return Boolean(row)
}
