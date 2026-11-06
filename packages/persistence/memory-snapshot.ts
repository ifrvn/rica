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
      const candidates = await readMemoryCandidates(tx, scope)
      const ranked = rankMemoryCandidates(candidates, query, new Date())
      const { count } = await tx.contextSnapshot.createMany({
        data: {
          ...key, characterId: scope.character_id, queryDigest, rankingVersion: memoryRankingVersion,
        },
        skipDuplicates: true,
      })
      snapshot = await findSnapshot(tx, key)
      if (!snapshot) throw new Error('Memory snapshot was not persisted')
      if (count === 1 && ranked.length > 0) {
        const snapshotId = snapshot.id
        await tx.contextSnapshotEvidence.createMany({
          data: ranked.map((candidate, index) => ({
            characterId: scope.character_id,
            snapshotId,
            memoryId: candidate.id,
            memoryRevision: candidate.revision,
            rank: index + 1,
            score: candidate.score,
            estimatedTokens: candidate.estimatedTokens,
          })),
        })
        snapshot = await findSnapshot(tx, key)
        if (!snapshot) throw new Error('Memory snapshot was not persisted')
      }
    }
    if (snapshot.queryDigest !== queryDigest) throw new Error('Memory snapshot already exists for a different query')
    return snapshot
  }, { isolationLevel: 'ReadCommitted' })
}

export async function replayMemorySnapshot(db: PrismaClient, runId: string, request: MemoryRequest) {
  return db.$transaction(async (tx) => {
    const scope = await loadMemoryReadScope(tx, runId, request)
    if (!scope) return null
    await bindSnapshotRun(tx, runId)

    const snapshot = await findSnapshot(tx, snapshotKey(runId, request))
    if (!snapshot) return null
    if (snapshot.evidence.length === 0) return []

    const candidates = await readMemoryCandidates(tx, scope)
    const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    return snapshot.evidence.map((evidence) => {
      const candidate = allowed.get(evidence.memoryId)
      return {
        rank: evidence.rank,
        candidate: candidate?.revision === evidence.memoryRevision ? candidate : null,
      }
    })
  }, { isolationLevel: 'ReadCommitted' })
}
