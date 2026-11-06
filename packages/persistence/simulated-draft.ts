import type { ModelEvidence, ModelProvider } from '../runtime/model-provider.js'
import { simulatedModel } from '../runtime/model-provider.js'
import type { PrismaClient } from './generated/client.js'
import { captureMemorySnapshot, replayMemorySnapshot } from './memory-snapshot.js'
import type { MemoryRequest } from './memory.js'

type WritingRequest = Extract<MemoryRequest, { purpose: 'PUBLIC_REFERENCE' }>
  | { purpose: 'PRIVATE_REPLY' }

const decisionRequest = { purpose: 'DECISION_SUPPORT' } as const
const maxTextLength = 4_000

async function readEvidence(
  db: PrismaClient, runId: string, request: MemoryRequest,
): Promise<ModelEvidence[] | null> {
  const replay = await replayMemorySnapshot(db, runId, request)
  return replay?.flatMap(({ candidate }) => candidate
    ? [{ id: candidate.id, revision: candidate.revision, content: candidate.content }]
    : []) ?? null
}

function validateDraft(output: unknown, allowedIds: ReadonlyMap<string, number>) {
  if (!output || typeof output !== 'object' || !('text' in output) || !('evidenceIds' in output)) {
    throw new Error('Invalid simulated writing output')
  }

  const { text, evidenceIds } = output
  if (typeof text !== 'string' || !text.trim() || text.length > maxTextLength
    || !Array.isArray(evidenceIds) || evidenceIds.length > allowedIds.size
    || !Array.from(evidenceIds).every((id): id is string => typeof id === 'string' && allowedIds.has(id))
    || new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error('Invalid simulated writing output')
  }

  return { text: text.trim(), evidenceIds: [...evidenceIds] }
}

function evidenceMatches(current: ModelEvidence[] | null, previous: ReadonlyMap<string, number>) {
  return current !== null && current.length === previous.size
    && current.every(({ id, revision }) => previous.get(id) === revision)
}

// Internal simulation only. The trusted caller supplies the writing scope separately from message text.
export async function generateSimulatedDraft(
  db: PrismaClient, runId: string, text: string, writingRequest: WritingRequest,
  provider: ModelProvider = simulatedModel, signal: AbortSignal = AbortSignal.timeout(5_000),
) {
  if (text.length > maxTextLength) throw new Error('Simulated message is too long')
  signal.throwIfAborted()

  if (!await captureMemorySnapshot(db, runId, writingRequest, text)
    || !await captureMemorySnapshot(db, runId, decisionRequest, text)) return null

  const decisionEvidence = await readEvidence(db, runId, decisionRequest)
  if (!decisionEvidence) return null

  signal.throwIfAborted()
  const decisionRevisions = new Map(decisionEvidence.map(({ id, revision }) => [id, revision]))
  const decision = await provider.decide({ text, evidence: decisionEvidence }, signal)
  signal.throwIfAborted()
  if (decision === 'NO_OP') return null
  if (decision !== 'REPLY') throw new Error('Invalid simulated decision output')

  const writingEvidence = await readEvidence(db, runId, writingRequest)
  if (!writingEvidence) return null

  // Preserve the authorized revisions independently of the objects passed to the provider.
  const allowedRevisions = new Map(writingEvidence.map(({ id, revision }) => [id, revision]))
  signal.throwIfAborted()
  const output = await provider.write({ text, evidence: writingEvidence }, signal)
  signal.throwIfAborted()
  const draft = validateDraft(output, allowedRevisions)

  if (!evidenceMatches(await readEvidence(db, runId, decisionRequest), decisionRevisions)
    || !evidenceMatches(await readEvidence(db, runId, writingRequest), allowedRevisions)) return null

  signal.throwIfAborted()
  return draft
}
