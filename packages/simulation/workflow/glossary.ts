import { z } from '@hono/zod-openapi'
import { glossaryReference, independentGlossaryExamples, mentionsGlossaryTerm as mentions,
  normalizeGlossaryText as normalize, supportedGlossaryCandidates } from '@ricajs/contracts/glossary'
import type { Prisma } from '@ricajs/persistence/prisma'

const glossaryContext = z.object({
  terms: z.array(glossaryReference.extend({ sourceRuns: z.array(z.uuid()).length(3) })),
  examples: z.array(z.object({ id: z.uuid(), speaker: z.string(), member: z.string(), message: z.string() })),
})
type ChatGlossary = z.infer<typeof glossaryContext>
export type GlossarySnapshot = ChatGlossary['terms']

export async function readChatGlossary(tx: Prisma.TransactionClient, runId: string) {
  const [row] = await tx.$queryRaw<{ glossary: unknown }[]>`
    SELECT public.rica_chat_glossary_context(${runId}::uuid) AS glossary
  `
  return row?.glossary == null ? undefined : glossaryContext.parse(row.glossary)
}

export function matchChatGlossary(context: ChatGlossary, text: string, recent: readonly string[]) {
  const current = context.terms.filter(({ term }) => mentions(text, normalize(term)))
  const nearby = context.terms.filter(({ term }) => !current.some((item) => item.term === term)
    && recent.some((message) => mentions(message, normalize(term))))
  return [...current, ...nearby].slice(0, 4)
}

export function learningExamples(context: ChatGlossary) {
  return independentGlossaryExamples(context.examples)?.map(({ speaker, message }) => ({ speaker, message }))
}

export const glossaryReferences = (terms: GlossarySnapshot) => terms.map(({ sourceRuns: _, ...term }) => term)

export function sourcesForTerms(context: ChatGlossary, output: unknown) {
  const known = new Set(context.terms.map(({ term }) => normalize(term)))
  return supportedGlossaryCandidates(known, context.examples, output).map(({ sources, ...term }) => ({ ...term, sourceRuns: sources }))
}

export async function saveChatTerms(tx: Prisma.TransactionClient, runId: string, terms: ReturnType<typeof sourcesForTerms>) {
  if (terms.length) await tx.$executeRaw`SELECT public.rica_save_chat_terms(${runId}::uuid, ${JSON.stringify(terms)}::jsonb)`
}
