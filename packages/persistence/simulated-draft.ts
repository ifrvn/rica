import { createHash } from 'node:crypto'
import { reviewTarget } from '../contracts/action-review.js'
import { matchesSimulationAdapter, type ResolveSimulationAdapter } from '../contracts/simulation-platform.js'
import { simulationReviewPolicyVersion } from './action-review.js'
import type { ModelEvidence, ModelProvider, WritingStyle } from '../runtime/model-provider.js'
import { maxSimulatedTextLength } from '../runtime/model-provider.js'
import type { Plugin } from '../runtime/plugin-registry.js'
import type { Prisma, PrismaClient } from './generated/client.js'
import { captureMemorySnapshot, captureSelfModelSnapshot, replayMemorySnapshotInTransaction } from './memory-snapshot.js'
import { loadMemoryReadScope, type MemoryRequest } from './memory.js'
import { loadRunContinuity, type RunContinuity } from './run-continuity.js'
import { draftQueuedEvent, outboxAttemptFence, type OutboxAttempt } from './run-context.js'

type WritingRequest = Extract<MemoryRequest, { purpose: 'PUBLIC_REFERENCE' }>
  | { purpose: 'PRIVATE_REPLY' }

const decisionRequest = { purpose: 'DECISION_SUPPORT' } as const

async function readEvidence(
  tx: Prisma.TransactionClient, runId: string, request: MemoryRequest,
): Promise<ModelEvidence[] | null> {
  const replay = await replayMemorySnapshotInTransaction(tx, runId, request)
  return replay?.flatMap(({ candidate }) => candidate
    ? [{ id: candidate.id, revision: candidate.revision, content: candidate.content }]
    : []) ?? null
}

function validateDraft(output: unknown, allowedIds: ReadonlyMap<string, number>) {
  if (!output || typeof output !== 'object' || !('text' in output) || !('evidenceIds' in output)) {
    throw new Error('Invalid simulated writing output')
  }

  const { text, evidenceIds } = output
  if (typeof text !== 'string' || !text.trim() || text.length > maxSimulatedTextLength
    || !Array.isArray(evidenceIds) || evidenceIds.length > allowedIds.size
    || !Array.from(evidenceIds).every((id): id is string => typeof id === 'string' && allowedIds.has(id))
    || new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error('Invalid simulated writing output')
  }

  return { text: text.trim(), evidenceIds: [...evidenceIds] }
}

function evidenceMatches(current: readonly ModelEvidence[] | null, previous: ReadonlyMap<string, number>) {
  return current !== null && current.length === previous.size
    && current.every(({ id, revision }) => previous.get(id) === revision)
}

function beliefRefs(context: RunContinuity) {
  return context.beliefs.map(({ id, version }) => ({ id, version }))
}

async function reserveModelBudget(tx: Prisma.TransactionClient, runId: string, input: object, outputUnits: number) {
  const units = Buffer.byteLength(JSON.stringify(input), 'utf8') + outputUnits
  const [row] = await tx.$queryRaw<{ allowed: boolean }[]>`
    SELECT public.rica_reserve_model_budget(${runId}::uuid, ${units}::int) AS allowed
  `
  return row.allowed
}

// Internal simulation only. The trusted caller supplies the writing scope separately from message text.
async function buildSimulatedDraft(
  db: PrismaClient, runId: string, text: string, writingRequest: WritingRequest,
  provider: ModelProvider, signal: AbortSignal,
) {
  if (text.length > maxSimulatedTextLength) throw new Error('Simulated message is too long')
  signal.throwIfAborted()

  if (!await captureMemorySnapshot(db, runId, writingRequest, text)
    || !await captureMemorySnapshot(db, runId, decisionRequest, text)) return null

  const prepared = await db.$transaction(async (tx) => {
    const evidence = await readEvidence(tx, runId, decisionRequest)
    const context = evidence && await loadRunContinuity(tx, runId)
    if (!context || !await captureSelfModelSnapshot(tx, runId, context.characterId, context.self.facts)) return null
    const input = { text, evidence, context }
    return await reserveModelBudget(tx, runId, input, 64) ? input : null
  })
  if (!prepared) return null
  const { evidence: decisionEvidence, context } = prepared
  const selfRevisions = new Map(context.self.facts.map(({ id, revision }) => [id, revision]))
  const time = { ...context.time }
  const goalVersions = context.goals.map(({ id, version }) => id + ':' + version).join(',')
  const beliefVersions = beliefRefs(context)

  signal.throwIfAborted()
  const decisionRevisions = new Map(decisionEvidence.map(({ id, revision }) => [id, revision]))
  const decision = await provider.decide(prepared, signal)
  signal.throwIfAborted()
  if (decision === 'NO_OP') return null
  if (decision !== 'REPLY') throw new Error('Invalid simulated decision output')

  const writing = await db.$transaction(async (tx) => {
    const evidence = await readEvidence(tx, runId, writingRequest)
    if (!evidence) return null
    const [profile] = await tx.$queryRaw<{ style: WritingStyle | null }[]>`
      SELECT public.rica_simulated_writing_style(${runId}::uuid) AS style
    `
    if (!profile?.style) return null
    const input = { text, evidence, style: profile.style, time }
    const outputUnits = maxSimulatedTextLength * 4 + 1024
    return await reserveModelBudget(tx, runId, input, outputUnits) ? input : null
  })
  if (!writing) return null

  // Preserve the authorized revisions independently of the objects passed to the provider.
  const allowedRevisions = new Map(writing.evidence.map(({ id, revision }) => [id, revision]))
  signal.throwIfAborted()
  const output = await provider.write(writing, signal)
  signal.throwIfAborted()
  const draft = validateDraft(output, allowedRevisions)

  return { draft, decisionRevisions, writingRevisions: allowedRevisions, selfRevisions, goalVersions, beliefVersions }
}

type DraftCandidate = NonNullable<Awaited<ReturnType<typeof buildSimulatedDraft>>>

async function recheckDraft(
  tx: Prisma.TransactionClient, runId: string, request: WritingRequest, candidate: DraftCandidate,
) {
  if (!evidenceMatches(await readEvidence(tx, runId, decisionRequest), candidate.decisionRevisions)
    || !evidenceMatches(await readEvidence(tx, runId, request), candidate.writingRevisions)) return false
  const context = await loadRunContinuity(tx, runId)
  return !!context && evidenceMatches(context.self.facts, candidate.selfRevisions)
    && context.goals.map(({ id, version }) => id + ':' + version).join(',') === candidate.goalVersions
    && JSON.stringify(beliefRefs(context)) === JSON.stringify(candidate.beliefVersions)
}

export async function generateSimulatedDraft(
  db: PrismaClient, runId: string, text: string, request: WritingRequest,
  provider: ModelProvider, signal: AbortSignal = AbortSignal.timeout(5_000),
) {
  const candidate = await buildSimulatedDraft(db, runId, text, request, provider, signal)
  if (!candidate || !await db.$transaction((tx) => recheckDraft(tx, runId, request, candidate))) return null
  signal.throwIfAborted()
  return candidate.draft
}

export async function processSimulatedDraft(
  db: PrismaClient, eventId: string, resolveAdapter: ResolveSimulationAdapter, model: Plugin<ModelProvider>, attempt?: OutboxAttempt,
) {
  const event = await db.outboxEvent.findFirst({
    where: { eventId, type: draftQueuedEvent, processedAt: null, quarantinedAt: null,
      ...(attempt ? { generation: attempt.generation, attempts: attempt.ticket } : {}) },
    include: {
      run: { include: { inboundEvent: { select: { adapterId: true, adapterVersion: true } } } },
    },
  })
  const run = event?.run
  if (!run) return
  const inbound = run.inboundEvent
  const input = await db.$transaction(async (tx) => {
    const scope = await loadMemoryReadScope(tx, run.id, decisionRequest)
    if (!scope) return null
    const platform = inbound.adapterId ?? (await tx.$queryRaw<{ platform: string | null }[]>`
      SELECT public.rica_simulated_review_target(${run.id}::uuid)->>'platform' AS platform
    `)[0]?.platform
    const adapter = platform ? resolveAdapter(platform) : undefined
    if (!adapter || (inbound.adapterId !== null
      && (inbound.adapterId !== adapter.adapterId || inbound.adapterVersion !== adapter.adapterVersion))) return null
    const { messageText } = await tx.inboundEvent.findUniqueOrThrow({
      where: { id: run.inboundEventId }, select: { messageText: true },
    })
    return { scope, text: messageText, platform, adapter }
  })
  const scope = input?.scope
  const request: WritingRequest | null = scope?.channel === 'PRIVATE'
    ? { purpose: 'PRIVATE_REPLY' }
    : scope?.channel === 'PUBLIC' && scope.conversation_id
      ? { purpose: 'PUBLIC_REFERENCE', audience: scope.conversation_id }
      : null

  // Model calls stay outside the write transaction. A retry can rebuild from the same snapshots.
  const signal = AbortSignal.timeout(5_000)
  const text = input?.text ?? null
  const candidate = request && text !== null
    ? await buildSimulatedDraft(db, run.id, text, request, model.implementation, signal)
    : null

  await db.$transaction(async (tx) => {
    const [pending] = await tx.$queryRaw<{ eventId: string }[]>`
      SELECT event_id AS "eventId" FROM public.outbox
      WHERE event_id = ${eventId}::uuid AND type = ${draftQueuedEvent} AND processed_at IS NULL
        AND quarantined_at IS NULL ${outboxAttemptFence(attempt)}
      FOR UPDATE
    `
    if (!pending) return

    if (run.state === 'CONTEXT_READY') {
      const accepted = candidate && request && await recheckDraft(tx, run.id, request, candidate)
      const [bound] = accepted ? await tx.$queryRaw<{ target: unknown; disclosure: string | null; crossPlatformDuplicate: boolean }[]>`
        SELECT public.rica_simulated_review_target(${run.id}::uuid) AS target,
          public.rica_simulation_disclosure(${run.id}::uuid) AS disclosure,
          public.rica_cross_platform_duplicate(${run.id}::uuid) AS "crossPlatformDuplicate"
      ` : []
      const target = bound?.target ? reviewTarget.parse(bound.target) : null
      const content = accepted && bound?.disclosure
        ? candidate.draft.text + '\n\nAI 披露：' + bound.disclosure : null
      const adapter = target ? resolveAdapter(target.platform) : undefined
      const proposed = accepted && target && target.platform === input?.platform
        && adapter && matchesSimulationAdapter(input.adapter, adapter) && content
        && content.length <= maxSimulatedTextLength
      if (proposed) {
        const expiresAt = new Date(Date.now() + 86_400_000)
        const payloadHash = createHash('sha256').update(content).digest('hex')
        const crossPlatformDuplicate = bound?.crossPlatformDuplicate ?? false
        const reviewDigest = createHash('sha256').update(JSON.stringify({
          payloadHash, target, ...adapter, expiresAt: expiresAt.toISOString(), crossPlatformDuplicate,
          kind: 'REPLY', mode: run.mode, policyVersion: simulationReviewPolicyVersion,
          characterId: run.characterId, runId: run.id, coreVersion: run.coreVersion,
          identityVersion: run.identityVersion, bindingVersion: run.bindingVersion, authEpoch: run.authEpoch,
          decisionEvidence: [...candidate.decisionRevisions], writingEvidence: [...candidate.writingRevisions],
          selfEvidence: [...candidate.selfRevisions], goalVersions: candidate.goalVersions, beliefRefs: candidate.beliefVersions,
          citationIds: candidate.draft.evidenceIds, modelId: model.id, modelVersion: model.version,
        })).digest('hex')
        signal.throwIfAborted()
        await tx.simulatedDraft.createMany({
          data: {
            runId: run.id,
            characterId: run.characterId,
            content,
            decisionEvidenceIds: [...candidate.decisionRevisions.keys()],
            writingEvidenceIds: [...candidate.writingRevisions.keys()],
            citationIds: candidate.draft.evidenceIds,
            beliefRefs: candidate.beliefVersions,
            modelId: model.id,
            modelVersion: model.version,
          },
        })
        await tx.actionProposal.create({
          data: {
            characterId: run.characterId, runId: run.id, target, payloadHash, reviewDigest,
            policyVersion: simulationReviewPolicyVersion, ...adapter, expiresAt, crossPlatformDuplicate,
          },
        })
      }
      const { count } = await tx.agentRun.updateMany({
        where: { id: run.id, state: 'CONTEXT_READY', stateVersion: run.stateVersion },
        data: {
          state: proposed ? 'WAITING_APPROVAL' : 'CANCELED',
          stateReason: proposed ? null : 'DRAFT_UNAVAILABLE',
          stateVersion: { increment: 1 },
        },
      })
      if (count !== 1) throw new Error('Simulated run changed during drafting')
    }
    await tx.outboxEvent.update({ where: { eventId }, data: { processedAt: new Date() } })
  }, { isolationLevel: 'ReadCommitted' })
}
