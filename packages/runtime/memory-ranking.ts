import { Buffer } from 'node:buffer'
import type { MemoryCandidate, RankedMemory } from '../contracts/memory.js'

export const memoryRankingVersion = 1

const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const halfLifeDays: Record<MemoryCandidate['scope'], number> = {
  CORE: 365,
  IDENTITY: 90,
  ACCOUNT: 30,
  CONVERSATION: 7,
}
const dayMs = 86_400_000

function words(text: string) {
  const normalized = text.normalize('NFKC').toLowerCase()
  return [...wordSegmenter.segment(normalized)]
    .filter(({ isWordLike }) => isWordLike)
    .map(({ segment }) => segment)
}

export function rankMemoryCandidates(candidates: readonly MemoryCandidate[], query: string, now: Date): RankedMemory[] {
  const keywords = [...new Set(words(query))]
  const ranked: RankedMemory[] = []

  for (const candidate of candidates) {
    // Without a model tokenizer, UTF-8 bytes conservatively bound byte-based token counts.
    const estimatedTokens = Buffer.byteLength(candidate.content, 'utf8')
    if (estimatedTokens === 0 || estimatedTokens > 1500) continue

    const contentWords = new Set(words(candidate.content))
    const matches = keywords.filter((word) => contentWords.has(word)).length
    if (matches === 0 && !candidate.sameConversation) continue

    const keywordRelevance = keywords.length ? matches / keywords.length : 0
    const conversationRelevance = candidate.sameConversation ? 1 : 0
    const ageDays = Math.max(0, (now.getTime() - candidate.createdAt.getTime()) / dayMs)
    const freshness = 2 ** (-ageDays / halfLifeDays[candidate.scope])
    const score = 0.4 * keywordRelevance + 0.25 * conversationRelevance
      + 0.2 * candidate.importance + 0.15 * freshness
    if (score >= 0.45) ranked.push({ ...candidate, score, estimatedTokens })
  }

  ranked.sort((a, b) => b.score - a.score
    || b.createdAt.getTime() - a.createdAt.getTime()
    || a.id.localeCompare(b.id, 'en'))

  const selected: RankedMemory[] = []
  let remaining = 1500
  for (const candidate of ranked) {
    if (selected.length === 8) break
    if (candidate.estimatedTokens > remaining) continue
    remaining -= candidate.estimatedTokens
    selected.push(candidate)
  }
  return selected
}
