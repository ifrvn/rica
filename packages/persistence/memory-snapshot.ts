import { createHash } from 'node:crypto'
import { memoryRankingVersion, rankMemoryCandidates } from '../runtime/memory-ranking.js'
import type { Prisma, PrismaClient } from './generated/client.js'
import { loadMemoryReadScope, readMemoryCandidates, type MemoryRequest } from './memory.js'

async function bindSnapshotRun(tx: Prisma.TransactionClient, runId: string) {
  await tx.$queryRaw`SELECT set_config('rica.snapshot_run', ${runId}, true)`
}

function snapshotKey(runId: string, request: MemoryRequest) {
  return { runId, purpose: request.purpose, audienceKey: request.audience ?? '' }
}

async function findSnapshot(tx: Prisma.TransactionClient, key: ReturnType<typeof snapshotKey>) {
  return tx.contextSnapshot.findUnique({
    where: { runId_purpose_audienceKey: key },
    include: { evidence: { orderBy: { rank: 'asc' } } },
  })
}

async function persistSnapshot(
  tx: Prisma.TransactionClient, key: ReturnType<typeof snapshotKey>, characterId: string,
  queryDigest: string, ranked: readonly {
    id: string; revision: number; score: number; estimatedTokens: number
  }[],
) {
  const { count } = await tx.contextSnapshot.createMany({
    data: { ...key, characterId, queryDigest, rankingVersion: memoryRankingVersion },
    skipDuplicates: true,
  })
  const snapshot = await findSnapshot(tx, key)
  if (!snapshot) throw new Error('Memory snapshot was not persisted')
  if (!count || !ranked.length) return snapshot
  await tx.contextSnapshotEvidence.createMany({
    data: ranked.map((candidate, index) => ({
      characterId, snapshotId: snapshot.id, memoryId: candidate.id, memoryRevision: candidate.revision,
      rank: index + 1, score: candidate.score, estimatedTokens: candidate.estimatedTokens,
    })),
  })
  return findSnapshot(tx, key)
}

const selfModelSnapshot = 'self-model.v1'
const selfModelDigest = createHash('sha256').update(selfModelSnapshot).digest('hex')

export async function captureSelfModelSnapshot(tx: Prisma.TransactionClient, runId: string, characterId: string,
  facts: readonly { id: string; revision: number; content: string }[]) {
  await bindSnapshotRun(tx, runId)
  const key = { runId, purpose: 'INTERNAL_CONTEXT', audienceKey: selfModelSnapshot } as const
  let snapshot = await findSnapshot(tx, key)
  if (!snapshot && facts.length) {
    snapshot = await persistSnapshot(tx, key, characterId, selfModelDigest, facts.map((fact) => ({
      ...fact, score: 1, estimatedTokens: Buffer.byteLength(fact.content, 'utf8'),
    })))
  }
  const evidence = snapshot?.evidence ?? []
  return facts.length === evidence.length && facts.every(({ id, revision }, index) =>
    evidence[index].memoryId === id && evidence[index].memoryRevision === revision)
}

export async function captureMemorySnapshot(
  db: PrismaClient, runId: string, request: MemoryRequest, query: string,
) {
  const key = snapshotKey(runId, request)
  const queryDigest = createHash('sha256').update(query).digest('hex')

  return db.$transaction(async (tx) => {
    const scope = await loadMemoryReadScope(tx, runId, request)
    if (!scope) return null
    await bindSnapshotRun(tx, runId)

    let snapshot = await findSnapshot(tx, key)
    if (!snapshot) {
      const candidates = await readMemoryCandidates(tx, scope, { query })
      const ranked = rankMemoryCandidates(candidates, query, new Date())
      snapshot = await persistSnapshot(tx, key, scope.character_id, queryDigest, ranked)
      if (!snapshot) throw new Error('Memory snapshot was not persisted')
    }
    if (snapshot.queryDigest !== queryDigest) throw new Error('Memory snapshot already exists for a different query')
    return snapshot
  }, { isolationLevel: 'ReadCommitted' })
}

export async function replayMemorySnapshot(db: PrismaClient, runId: string, request: MemoryRequest) {
  return db.$transaction((tx) => replayMemorySnapshotInTransaction(tx, runId, request),
    { isolationLevel: 'ReadCommitted' })
}

export async function replayMemorySnapshotInTransaction(
  tx: Prisma.TransactionClient, runId: string, request: MemoryRequest,
) {
  const scope = await loadMemoryReadScope(tx, runId, request)
  if (!scope) return null
  await bindSnapshotRun(tx, runId)

  const snapshot = await findSnapshot(tx, snapshotKey(runId, request))
  if (!snapshot) return null
  if (snapshot.evidence.length === 0) return []

  const candidates = await readMemoryCandidates(tx, scope, {
    memoryIds: snapshot.evidence.map(({ memoryId }) => memoryId),
  })
  const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  return snapshot.evidence.map((evidence) => {
    const candidate = allowed.get(evidence.memoryId)
    return {
      rank: evidence.rank,
      candidate: candidate?.revision === evidence.memoryRevision ? candidate : null,
    }
  })
}
