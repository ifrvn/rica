import { defaultAutoReviewPrompt } from '@ricajs/contracts/auto-review'
import type { AutoReviewSettings } from '@ricajs/contracts/auto-review'
import type { Prisma } from '../generated/client.js'

export async function readAutoReviewSettings(db: Prisma.TransactionClient, characterId: string, identityId: string) {
  const [row] = await db.$queryRaw<(Omit<AutoReviewSettings, 'prompt'> & { prompt: string | null })[]>`
    SELECT i.auto_review_enabled AS enabled, i.im_manual_review_enabled AS "imManualReviewEnabled",
      i.auto_review_template_id AS "templateId", i.auto_review_version AS version, t.prompt
    FROM public.identities i
    LEFT JOIN public.auto_review_templates t ON (t.character_id, t.id) = (i.character_id, i.auto_review_template_id)
    WHERE (i.character_id, i.id) = (${characterId}::uuid, ${identityId}::uuid)
  `
  return row && { ...row, prompt: row.prompt ?? defaultAutoReviewPrompt } satisfies AutoReviewSettings
}

// Serialize approval with admin policy changes and account/character controls.
export async function lockAutoReview(tx: Prisma.TransactionClient, characterId: string, identityId: string, version: number) {
  const [character] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public.characters WHERE id = ${characterId}::uuid AND status = 'ACTIVE' FOR UPDATE
  `
  if (!character) return false
  const [identity] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public.identities WHERE (character_id, id) = (${characterId}::uuid, ${identityId}::uuid)
      AND status = 'ACTIVE' AND auto_review_enabled AND auto_review_version = ${version} FOR UPDATE
  `
  return Boolean(identity)
}
