import { normalizeGlossaryText, type supportedGlossaryCandidates } from '@ricajs/contracts/glossary'
import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import { newbiGlossaryReference } from '../management/contracts.js'

const maxSectionSamples = 120
export const sectionSampleSelect = { id: true, term: true, meaning: true, tone: true, sourceComments: true, sectionId: true } as const

export async function readSectionGlossary(db: PrismaClient, accountId: string, sectionId: number, cutoff: Date) {
  const samples = await db.newbiSectionGlossarySample.findMany({
    where: { accountId, sectionId, source: { createdAt: { gt: cutoff } } },
    select: { id: true, term: true, termKey: true, meaning: true, meaningKey: true, tone: true, authorKey: true,
      source: { select: { postId: true } } },
    orderBy: { id: 'asc' }, take: maxSectionSamples,
  })
  const terms = new Map<string, Map<string, typeof samples>>()
  for (const sample of samples) {
    const meanings = terms.get(sample.termKey) ?? new Map<string, typeof samples>()
    const examples = meanings.get(sample.meaningKey) ?? []
    examples.push(sample)
    meanings.set(sample.meaningKey, examples)
    terms.set(sample.termKey, meanings)
  }

  const confirmed = [...terms.values()].flatMap((meanings) => {
    const corroborated = [...meanings.values()].filter((examples) => new Set(examples.map(({ source }) => source.postId)).size >= 2)
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
  const where = { accountId: scope.accountId, sectionId: scope.sectionId, source: { createdAt: { gt: cutoff } } }
  const count = await tx.newbiSectionGlossarySample.count({ where })
  if (count >= maxSectionSamples) return
  const recorded = await tx.newbiSectionGlossarySample.findMany({
    where: { ...where, authorKey: scope.authorKey, termKey: { in: candidates.map(({ termKey }) => termKey) } },
    select: { termKey: true },
  })
  const known = new Set(recorded.map(({ termKey }) => termKey))
  const fresh = candidates.filter(({ termKey }) => !known.has(termKey)).slice(0, maxSectionSamples - count)
  if (!fresh.length) return
  await tx.newbiSectionGlossarySample.createMany({ skipDuplicates: true, data: fresh
    .map(({ sources: sourceComments, ...term }) => ({ ...scope, ...term, sourceComments,
      meaningKey: JSON.stringify([normalizeGlossaryText(term.meaning).replace(/[。.!！]+$/u, ''), term.tone]),
    })) })
}
