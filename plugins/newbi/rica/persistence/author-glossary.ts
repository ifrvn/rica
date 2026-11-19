import { z } from '@hono/zod-openapi'
import { glossaryReference, independentGlossaryExamples, mentionsGlossaryTerm, supportedGlossaryCandidates } from '@ricajs/contracts/glossary'
import type { NewbiDiscussionAssessment, Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import type { newbiAssessmentThread } from '../management/contracts.js'

type Thread = z.infer<typeof newbiAssessmentThread>
const maxTerms = 40
const stableAuthorId = z.union([z.uuid().transform((id) => 'agent:' + id.toLowerCase()), z.number().int().positive().transform((id) => 'human:' + id)])
export const authorTermSelect = { id: true, term: true, meaning: true, tone: true, sourceComments: true } as const

export async function prepareAuthorGlossary(db: PrismaClient, accountId: string, thread: Thread,
  comments: readonly { id: string; text: string; own: boolean }[], cutoff: Date) {
  const authorKey = stableAuthorId.safeParse(thread.post.author?.id).data
  if (!authorKey) return
  const where = { accountId, authorKey, source: { createdAt: { gt: cutoff } } }
  const terms = await db.newbiAuthorTerm.findMany({
    where, select: { ...authorTermSelect, termKey: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: maxTerms,
  })
  const messages = [thread.post.title.slice(0, 240), thread.post.content.slice(0, 1800), ...comments.map(({ text }) => text)]
  const used = terms.filter(({ termKey }) => messages.some((text) => mentionsGlossaryTerm(text, termKey)))
    .slice(0, 4).map(({ id, term, meaning, tone }) => glossaryReference.parse({ id, term, meaning, tone, version: 1 }))
  const authors = new Map(thread.comments.map(({ id, author }) => [id, stableAuthorId.safeParse(author.id).data]))
  const examples = independentGlossaryExamples(comments.flatMap(({ id, text, own }) => {
    const member = authors.get(id)
    return !own && member && text.trim() ? [{ id, member, message: text }] : []
  }))
  const known = new Set(terms.map(({ termKey }) => termKey))
  return {
    authorKey, used, canLearn: known.size < maxTerms && !!examples,
    candidates: (output: unknown) => examples ? supportedGlossaryCandidates(known, examples, output) : [],
  }
}

export async function saveAuthorTerms(tx: Prisma.TransactionClient, row: NewbiDiscussionAssessment, authorKey: string,
  candidates: ReturnType<typeof supportedGlossaryCandidates>, cutoff: Date) {
  if (!candidates.length) return
  const { accountId, id: sourceAssessmentId } = row
  const count = await tx.newbiAuthorTerm.count({ where: { accountId, authorKey, source: { createdAt: { gt: cutoff } } } })
  if (count >= maxTerms) return
  await tx.newbiAuthorTerm.createMany({ skipDuplicates: true, data: candidates.slice(0, maxTerms - count)
    .map(({ sources: sourceComments, ...term }) => ({ ...term, accountId, authorKey, sourceAssessmentId, sourceComments })) })
}
