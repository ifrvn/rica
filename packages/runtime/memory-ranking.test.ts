import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MemoryCandidate } from '../contracts/memory.js'
import { rankMemoryCandidates } from './memory-ranking.js'

const now = new Date('2026-11-06T00:00:00Z')
function candidate(id: string, content: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id, content, importance: 1, confidence: 1, createdAt: now,
    revision: 1, scope: 'IDENTITY', sameConversation: false, ...overrides,
  }
}

test('ranks Chinese and normalized Latin terms and breaks ties deterministically', () => {
  const items = [
    candidate('b', '猫咪喜欢 ＲＩＣＡ'),
    candidate('a', '猫咪喜欢 Rica'),
    candidate('older', '猫咪喜欢 Rica', { createdAt: new Date('2026-08-08T00:00:00Z') }),
    candidate('unrelated', '数据库维护'),
  ]
  assert.deepEqual(rankMemoryCandidates(items, '猫咪 Rica', now).map(({ id }) => id), ['a', 'b', 'older'])
})

test('uses current conversation context and leaves unrelated requests empty', () => {
  const items = [
    candidate('thread', '话题已经结束', { scope: 'CONVERSATION', sameConversation: true }),
    candidate('unrelated', '数据库维护'),
  ]
  assert.deepEqual(rankMemoryCandidates(items, '', now).map(({ id }) => id), ['thread'])
  assert.deepEqual(rankMemoryCandidates(items.slice(1), 'cat', now), [])
})

test('enforces the count and text budget without discarding later affordable matches', () => {
  const items = [
    candidate('0', 'cat ' + '猫'.repeat(500)),
    candidate('1', 'cat ' + '猫'.repeat(330)),
    candidate('2', 'cat ' + '猫'.repeat(200)),
    ...Array.from({ length: 10 }, (_, index) => candidate('x' + index, 'cat')),
  ]
  const selected = rankMemoryCandidates(items, 'cat', now)
  assert.equal(selected.length, 8)
  assert.equal(selected[0].id, '1')
  assert.ok(selected.every(({ id }) => id !== '0' && id !== '2'))
  assert.ok(selected.reduce((sum, { estimatedTokens }) => sum + estimatedTokens, 0) <= 1500)
})
