import { z } from '@hono/zod-openapi'
import { glossaryReference, independentGlossaryExamples, mentionsGlossaryTerm, supportedGlossaryCandidates } from '@ricajs/contracts/glossary'
import type { NewbiDiscussionAssessment, Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import type { newbiAssessmentThread } from '../management/contracts.js'
import { readSectionGlossary, saveSectionSamples } from './section-glossary.js'

type Thread = z.infer<typeof newbiAssessmentThread>
const maxTerms = 40
const stableAuthorId = z.union([z.uuid().transform((id) => 'agent:' + id.toLowerCase()), z.number().int().positive().transform((id) => 'human:' + id)])
export const authorTermSelect = { id: true, term: true, meaning: true, tone: true, sourceComments: true } as const

export async function prepareDiscussionGlossary(db: PrismaClient, accountId: string, thread: Thread,
  comments: readonly { id: string; text: string; own: boolean }[], cutoff: Date) {
  const authorKey = stableAuthorId.safeParse(thread.post.author?.id).data
  const { sectionId } = thread.post
  if (!authorKey && !sectionId) return
  const [terms, section] = await Promise.all([
    authorKey ? db.newbiAuthorTerm.findMany({
      where: { accountId, authorKey, source: { createdAt: { gt: cutoff } } },
      select: { id: true, term: true, meaning: true, tone: true, termKey: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: maxTerms,
    }) : [],
    sectionId ? readSectionGlossary(db, accountId, sectionId, cutoff) : undefined,
  ])
  const messages = [thread.post.title.slice(0, 240), thread.post.content.slice(0, 1800), ...comments.map(({ text }) => text)]
  const known = new Set(terms.map(({ termKey }) => termKey))
  const authorReferences = terms.map(({ termKey, ...term }) => ({
    termKey, reference: glossaryReference.parse({ ...term, version: 1 }),
  }))
  const sectionReferences = section?.confirmed.filter(({ termKey }) => !known.has(termKey)) ?? []
  const used = [...authorReferences, ...sectionReferences].filter(({ termKey }) => messages.some((text) => mentionsGlossaryTerm(text, termKey)))
    .slice(0, 4).map(({ reference }) => reference)
  const authors = new Map(thread.comments.map(({ id, author }) => [id, stableAuthorId.safeParse(author.id).data]))
  const examples = independentGlossaryExamples(comments.flatMap(({ id, text, own }) => {
    const member = authors.get(id)
    return !own && member && text.trim() ? [{ id, member, message: text }] : []
  }))
  const observedInSection = authorKey && section ? section.observedBy(authorKey) : undefined
  const canLearn = !!authorKey && !!examples && (known.size < maxTerms || (section && !section.full))
  return {
    used, canLearn,
    async save(tx: Prisma.TransactionClient, row: NewbiDiscussionAssessment, output: unknown) {
      if (!canLearn || !authorKey || !examples) return
      const alreadyRecorded = new Set([...known].filter((term) => !sectionId || observedInSection?.has(term)))
      const candidates = supportedGlossaryCandidates(alreadyRecorded, examples, output)
      await saveAuthorTerms(tx, row, authorKey, candidates.filter(({ termKey }) => !known.has(termKey)), cutoff)
      if (sectionId) await saveSectionSamples(tx, { accountId, sectionId, authorKey, sourceAssessmentId: row.id },
        candidates.filter(({ termKey }) => !observedInSection?.has(termKey)), cutoff)
    },
  }
}

async function saveAuthorTerms(tx: Prisma.TransactionClient, row: NewbiDiscussionAssessment, authorKey: string,
  candidates: ReturnType<typeof supportedGlossaryCandidates>, cutoff: Date) {
  if (!candidates.length) return
  const { accountId, id: sourceAssessmentId } = row
  const count = await tx.newbiAuthorTerm.count({ where: { accountId, authorKey, source: { createdAt: { gt: cutoff } } } })
  if (count >= maxTerms) return
  await tx.newbiAuthorTerm.createMany({ skipDuplicates: true, data: candidates.slice(0, maxTerms - count)
    .map(({ sources: sourceComments, ...term }) => ({ ...term, accountId, authorKey, sourceAssessmentId, sourceComments })) })
}
