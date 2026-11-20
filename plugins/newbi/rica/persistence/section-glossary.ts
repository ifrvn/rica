import { normalizeGlossaryText, type supportedGlossaryCandidates } from '@ricajs/contracts/glossary'
import { Prisma, type PrismaClient } from '@ricajs/persistence/prisma'
import { newbiGlossaryReference } from '../management/contracts.js'

const maxSectionSamples = 120
type SectionSample = {
  id: string; term: string; termKey: string; meaning: string; meaningKey: string; tone: string; authorKey: string; postId: string
}

function activeSectionSamples(accountId: string, sectionId: number, cutoff: Date) {
  return Prisma.sql`
    FROM rica_plugin_newbi.section_glossary_samples s
    JOIN rica_plugin_newbi.discussion_assessments a ON (a.account_id, a.id) = (s.account_id, s.source_assessment_id)
    WHERE s.account_id = ${accountId}::uuid AND s.section_id = ${sectionId} AND a.created_at > ${cutoff}`
}

export async function readSectionGlossary(db: PrismaClient, accountId: string, sectionId: number, cutoff: Date) {
  const samples = await db.$queryRaw<SectionSample[]>`
    SELECT s.id, s.term, s.term_key AS "termKey", s.meaning, s.meaning_key AS "meaningKey", s.tone,
      s.author_key AS "authorKey", a.post_id AS "postId"
    ${activeSectionSamples(accountId, sectionId, cutoff)}
    ORDER BY s.id LIMIT ${maxSectionSamples}`
  const terms = new Map<string, Map<string, typeof samples>>()
  for (const sample of samples) {
    const meanings = terms.get(sample.termKey) ?? new Map<string, typeof samples>()
    const examples = meanings.get(sample.meaningKey) ?? []
    examples.push(sample)
    meanings.set(sample.meaningKey, examples)
    terms.set(sample.termKey, meanings)
  }

  const confirmed = [...terms.values()].flatMap((meanings) => {
    const corroborated = [...meanings.values()].filter((examples) => new Set(examples.map(({ postId }) => postId)).size >= 2)
    if (corroborated.length !== 1) return []
    const { id, term, termKey, meaning, tone } = corroborated[0]![0]!
    return [{ termKey, reference: newbiGlossaryReference.parse({ id, term, meaning, tone, sectionId, version: 1 }) }]
  })
  return {
    confirmed, full: samples.length >= maxSectionSamples,
    observedBy: (authorKey: string) => new Set(samples.filter((sample) => sample.authorKey === authorKey).map(({ termKey }) => termKey)),
  }
}

export async function saveSectionSamples(tx: Prisma.TransactionClient, scope: { accountId: string; sectionId: number; authorKey: string; sourceAssessmentId: string },
  candidates: ReturnType<typeof supportedGlossaryCandidates>, cutoff: Date) {
  if (!candidates.length) return
  const { accountId, sectionId, authorKey, sourceAssessmentId } = scope
  const activeSamples = activeSectionSamples(accountId, sectionId, cutoff)
  const [{ count }] = await tx.$queryRaw<[{ count: number }]>`SELECT count(*)::integer AS count ${activeSamples}`
  if (count >= maxSectionSamples) return
  const recorded = await tx.$queryRaw<{ termKey: string }[]>`
    SELECT s.term_key AS "termKey" ${activeSamples}
      AND s.author_key = ${authorKey} AND s.term_key IN (${Prisma.join(candidates.map(({ termKey }) => termKey))})`
  const known = new Set(recorded.map(({ termKey }) => termKey))
  const fresh = candidates.filter(({ termKey }) => !known.has(termKey)).slice(0, maxSectionSamples - count)
  if (!fresh.length) return
  const rows = fresh.map(({ termKey, term, meaning, tone, sources }) => {
    const meaningKey = JSON.stringify([normalizeGlossaryText(meaning).replace(/[。.!！]+$/u, ''), tone])
    return Prisma.sql`(${accountId}::uuid, ${sectionId}, ${authorKey}, ${termKey}, ${meaningKey}, ${term}, ${meaning}, ${tone},
      ${sourceAssessmentId}::uuid, ARRAY[${Prisma.join(sources)}]::uuid[])`
  })
  await tx.$executeRaw`
    INSERT INTO rica_plugin_newbi.section_glossary_samples
      (account_id, section_id, author_key, term_key, meaning_key, term, meaning, tone, source_assessment_id, source_comments)
    VALUES ${Prisma.join(rows)} ON CONFLICT DO NOTHING`
}
