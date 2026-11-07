import { Buffer } from 'node:buffer'
import type { MemoryCandidate, RankedMemory } from '../contracts/memory.js'

export const memoryRankingVersion = 2

const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const halfLifeDays: Record<MemoryCandidate['scope'], number> = {
  CORE: 365,
  IDENTITY: 90,
  ACCOUNT: 30,
  CONVERSATION: 7,
}
const dayMs = 86_400_000

function words(text: string) {
  // For ASCII letters, digits, spaces and hyphens the segmenter has the same word boundaries.
  if (/^[A-Za-z0-9 -]+$/u.test(text)) return text.toLowerCase().match(/[a-z0-9]+/gu) ?? []
  const normalized = text.normalize('NFKC').toLowerCase()
  return [...wordSegmenter.segment(normalized)]
    .filter(({ isWordLike }) => isWordLike)
    .map(({ segment }) => segment)
}

// A small, versioned local vocabulary keeps concept expansion deterministic and offline.
const concepts = [
  ['猫咪', '家猫', 'cat', 'feline'],
  ['账号安全', '账户安全', 'account security', 'account protection'],
  ['双重验证', '两步验证', 'two-factor authentication', '2fa', 'mfa'],
  ['数据库备份', '数据库备援', 'database backup', 'database snapshot'],
  ['数据恢复', '数据还原', 'data recovery', 'data restoration'],
  ['性能压测', '负载测试', 'load testing', 'stress testing'],
  ['公共交通', '大众运输', 'public transit', 'public transport'],
  ['气象预报', '天气预报', 'weather forecast', 'weather prediction'],
].map((aliases) => aliases.map(words))

function conceptMatches(terms: readonly string[]) {
  const phrase = ' ' + terms.join(' ') + ' '
  return concepts.flatMap((aliases, index) =>
    aliases.some((alias) => phrase.includes(' ' + alias.join(' ') + ' ')) ? [index] : [])
}

// The SQL prefilter must admit candidates for either lexical or concept matching.
export function memoryPrefilterWords(query: string) {
  const terms = words(query)
  const expanded = conceptMatches(terms).flatMap((index) => concepts[index].flat())
  return [...new Set([...terms, ...expanded])]
}

export function rankMemoryCandidates(candidates: readonly MemoryCandidate[], query: string, now: Date): RankedMemory[] {
  const queryWords = words(query)
  const keywords = [...new Set(queryWords)]
  const queryConcepts = conceptMatches(queryWords)
  const ranked: RankedMemory[] = []

  for (const candidate of candidates) {
    // Without a model tokenizer, UTF-8 bytes conservatively bound byte-based token counts.
    const estimatedTokens = Buffer.byteLength(candidate.content, 'utf8')
    if (estimatedTokens === 0 || estimatedTokens > 1500) continue

    const contentTerms = words(candidate.content)
    const contentWords = new Set(contentTerms)
    const matches = keywords.filter((word) => contentWords.has(word)).length
    const keywordRelevance = keywords.length ? matches / keywords.length : 0
    const contentConcepts = queryConcepts.length ? conceptMatches(contentTerms) : []
    const commonConcepts = queryConcepts.filter((concept) => contentConcepts.includes(concept)).length
    const conceptRelevance = commonConcepts
      ? 0.75 * commonConcepts / Math.sqrt(queryConcepts.length * contentConcepts.length)
      : 0
    const relevance = Math.max(keywordRelevance, conceptRelevance)
    if (relevance === 0 && !candidate.sameConversation) continue
    const conversationRelevance = candidate.sameConversation ? 1 : 0
    const ageDays = Math.max(0, (now.getTime() - candidate.createdAt.getTime()) / dayMs)
    const freshness = 2 ** (-ageDays / halfLifeDays[candidate.scope])
    const score = 0.4 * relevance + 0.25 * conversationRelevance
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
