import { z } from '@hono/zod-openapi'

export const glossaryTone = z.enum(['neutral', 'playful', 'sarcastic', 'sensitive'])
export const glossaryMeaning = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u)
const glossaryTerm = z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]+$/u)
export const glossaryCandidate = z.strictObject({ term: glossaryTerm, meaning: glossaryMeaning, tone: glossaryTone })
export const glossaryReference = glossaryCandidate.extend({ id: z.uuid(), version: z.number().int().positive() })
export type GlossaryReference = z.infer<typeof glossaryReference>
