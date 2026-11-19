import { z } from '@hono/zod-openapi'
import { glossaryCandidate, glossaryReference } from '@ricajs/contracts/glossary'
import type { Prisma } from '@ricajs/persistence/prisma'

const glossaryContext = z.object({
  terms: z.array(glossaryReference.extend({ sourceRuns: z.array(z.uuid()).length(3) })),
  examples: z.array(z.object({ id: z.uuid(), speaker: z.string(), member: z.string(), message: z.string() })),
})
type ChatGlossary = z.infer<typeof glossaryContext>
export type GlossarySnapshot = ChatGlossary['terms']

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')

function mentions(message: string, term: string) {
  const text = normalize(message)
  if (!/^[a-z0-9][a-z0-9 _-]*$/iu.test(term)) return text.includes(term)
  return new RegExp(`(?<![a-z0-9_])${term}(?![a-z0-9_])`, 'iu').test(text)
}

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
  const examples = [...new Map(context.examples.map((example) => [normalize(example.message), example])).values()]
  if (examples.length < 3 || new Set(examples.map(({ member }) => member)).size < 2) return
  return examples.map(({ speaker, message }) => ({ speaker, message }))
}

export const glossaryReferences = (terms: GlossarySnapshot) => terms.map(({ sourceRuns: _, ...term }) => term)

export function sourcesForTerms(context: ChatGlossary, output: unknown) {
  if (!Array.isArray(output) || output.length > 2) return []
  return output.flatMap((item: unknown) => {
    const result = glossaryCandidate.safeParse(item)
    if (!result.success) return []
    const candidate = result.data
    const termKey = normalize(candidate.term)
    if (context.terms.some(({ term }) => normalize(term) === termKey)) return []
    const matching = context.examples.filter(({ message }) => mentions(message, termKey))
    const distinct = [...new Map(matching.map((example) => [normalize(example.message), example])).values()]
    const first = distinct[0]
    const second = distinct.find(({ member }) => member !== first?.member)
    const third = distinct.find((example) => example !== first && example !== second)
    if (!first || !second || !third) return []
    return [{ ...candidate, termKey, sourceRuns: [first.id, second.id, third.id] }]
  })
}

export async function saveChatTerms(tx: Prisma.TransactionClient, runId: string, terms: ReturnType<typeof sourcesForTerms>) {
  if (terms.length) await tx.$executeRaw`SELECT public.rica_save_chat_terms(${runId}::uuid, ${JSON.stringify(terms)}::jsonb)`
}
