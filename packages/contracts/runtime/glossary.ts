import { z } from '@hono/zod-openapi'

export const glossaryTone = z.enum(['neutral', 'playful', 'sarcastic', 'sensitive'])
export const glossaryMeaning = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u)
const glossaryTerm = z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]+$/u)
export const glossaryCandidate = z.strictObject({ term: glossaryTerm, meaning: glossaryMeaning, tone: glossaryTone })
export const glossaryReference = glossaryCandidate.extend({ id: z.uuid(), version: z.number().int().positive() })
export type GlossaryReference = z.infer<typeof glossaryReference>

export const normalizeGlossaryText = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')

export function mentionsGlossaryTerm(message: string, term: string) {
  const text = normalizeGlossaryText(message)
  if (!/^[a-z0-9][a-z0-9 _-]*$/iu.test(term)) return text.includes(term)
  return new RegExp(`(?<![a-z0-9_])${term}(?![a-z0-9_])`, 'iu').test(text)
}

type GlossaryExample = { id: string; member: string; message: string }

export function independentGlossaryExamples<T extends GlossaryExample>(examples: readonly T[]) {
  const distinct = [...new Map(examples.map((example) => [normalizeGlossaryText(example.message), example])).values()]
  if (distinct.length >= 3 && new Set(distinct.map(({ member }) => member)).size >= 2) return distinct
}

export function supportedGlossaryCandidates(known: ReadonlySet<string>, examples: readonly GlossaryExample[], output: unknown) {
  if (!Array.isArray(output) || output.length > 2) return []
  return output.flatMap((item: unknown) => {
    const candidate = glossaryCandidate.safeParse(item).data
    if (!candidate) return []
    const termKey = normalizeGlossaryText(candidate.term)
    if (known.has(termKey)) return []
    const distinct = independentGlossaryExamples(examples.filter(({ message }) => mentionsGlossaryTerm(message, termKey)))
    if (!distinct) return []
    const first = distinct[0]!
    const second = distinct.find(({ member }) => member !== first.member)!
    const third = distinct.find((example) => example !== first && example !== second)!
    return [{ ...candidate, termKey, sources: [first.id, second.id, third.id] }]
  })
}
