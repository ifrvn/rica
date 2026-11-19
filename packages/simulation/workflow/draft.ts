import { createHash } from 'node:crypto'
import { reviewTarget } from '../contracts/review.js'
import { maxSimulatedTextLength, matchesSimulationAdapter, type ResolveSimulationAdapter } from '../contracts/platforms.js'
import { autoReviewSimulation, simulationReviewPolicyVersion } from './review.js'
import type { ReviewPublicReply } from '@ricajs/contracts/auto-review'
import { containsWritingPrompt } from '@ricajs/runtime/writing-prompts'
import { participationLevel, replyDecision, type ModelEvidence, type ModelProvider, type Participation,
  type ReplyDecision, type WritingStyle } from '@ricajs/contracts/model-provider'
import { localSimulationModel } from '../adapters/model.js'
import type { Plugin } from '@ricajs/plugin-host'
import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import { captureMemorySnapshot, captureSelfModelSnapshot, replayMemorySnapshotInTransaction } from '@ricajs/persistence/memory-snapshot'
import { loadMemoryReadScope, type MemoryRequest } from '@ricajs/persistence/memory'
import { loadRunContinuity } from '@ricajs/persistence/run-continuity'
import type { RunContinuity } from '@ricajs/contracts/run-continuity'
import { draftQueuedEvent, outboxAttemptFence, type OutboxAttempt } from '@ricajs/persistence/run-context'
import { simulationWritingContext } from '../contracts/observability.js'
import { recordRunModelCall } from './model-calls.js'
import { glossaryReferences, learningExamples, matchChatGlossary, readChatGlossary, saveChatTerms, sourcesForTerms,
  type GlossarySnapshot } from './glossary.js'

type WritingRequest = Extract<MemoryRequest, { purpose: 'PUBLIC_REFERENCE' }>
  | { purpose: 'PRIVATE_REPLY' }

const decisionRequest = { purpose: 'DECISION_SUPPORT' } as const
type ParticipationDecision = ReplyDecision & { participation: Participation; glossary: GlossarySnapshot }

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

async function readChatWritingContext(tx: Prisma.TransactionClient, runId: string) {
  const [row] = await tx.$queryRaw<{ conversation: unknown }[]>`
    SELECT public.rica_console_chat_writing(${runId}::uuid) AS conversation
  `
  return row?.conversation == null ? undefined : simulationWritingContext.parse(row.conversation)
}

// Internal simulation only. The trusted caller supplies the writing scope separately from message text.
async function buildSimulatedDraft(
  db: PrismaClient, runId: string, text: string, writingRequest: WritingRequest,
  provider: ModelProvider, signal: AbortSignal, observe?: {
    model: string
    skip: (reason: 'MODEL_BUDGET_EXHAUSTED' | 'MODEL_NO_REPLY') => void
    decision: (decision: ParticipationDecision) => void
    learned: (terms: ReturnType<typeof sourcesForTerms>) => void
  },
) {
  if (text.length > maxSimulatedTextLength) throw new Error('Simulated message is too long')
  signal.throwIfAborted()

  if (!await captureMemorySnapshot(db, runId, writingRequest, text)
    || !await captureMemorySnapshot(db, runId, decisionRequest, text)) return null

  const prepared = await db.$transaction(async (tx) => {
    const evidence = await readEvidence(tx, runId, decisionRequest)
    const context = evidence && await loadRunContinuity(tx, runId)
    if (!context || !await captureSelfModelSnapshot(tx, runId, context.characterId, context.self.facts)) return null
    const [profile] = await tx.$queryRaw<{ prompt: string | null; participation: string | null }[]>`
      SELECT prompt, public.rica_simulation_participation(${runId}::uuid) AS participation
      FROM public.rica_simulated_writing_profile(${runId}::uuid)
    `
    if (!profile) return null
    const conversation = writingRequest.purpose === 'PUBLIC_REFERENCE' ? await readChatWritingContext(tx, runId) : undefined
    const identityPrompt = profile.prompt ?? undefined
    const participation = participationLevel.safeParse(profile.participation).data
      ?? (/话痨|talkative/i.test(identityPrompt ?? '') ? 'talkative'
        : /寡言|reserved/i.test(identityPrompt ?? '') ? 'reserved' : 'balanced')
    const localGlossary = conversation && provider.hostedModel ? await readChatGlossary(tx, runId) : undefined
    const glossary = localGlossary && conversation
      ? matchChatGlossary(localGlossary, text, conversation.history.slice(-2).map(({ message }) => message)) : []
    const examples = localGlossary && observe ? learningExamples(localGlossary) : undefined
    const input = { text, evidence, context, conversation, identityPrompt, participation,
      glossary: glossary.length ? glossaryReferences(glossary) : undefined, glossaryExamples: examples } as const
    if (await reserveModelBudget(tx, runId, input, examples ? 1024 : 64)) return { input, localGlossary, glossary }
    observe?.skip('MODEL_BUDGET_EXHAUSTED')
    return null
  })
  if (!prepared) return null
  const { input: decisionInput, localGlossary, glossary } = prepared
  const { evidence: decisionEvidence, context } = decisionInput
  const selfRevisions = new Map(context.self.facts.map(({ id, revision }) => [id, revision]))
  const time = { ...context.time }
  const goalVersions = context.goals.map(({ id, version }) => id + ':' + version).join(',')
  const beliefVersions = beliefRefs(context)

  signal.throwIfAborted()
  const decisionRevisions = new Map(decisionEvidence.map(({ id, revision }) => [id, revision]))
  const captureDecision = observe && provider.hostedModel && writingRequest.purpose === 'PUBLIC_REFERENCE'
    ? (prompt: string) => recordRunModelCall(db, runId, 'DECISION', observe.model, prompt) : undefined
  const outputDecision = await provider.decide({ ...decisionInput, capture: captureDecision }, signal)
  signal.throwIfAborted()
  const structured = outputDecision && typeof outputDecision === 'object' && 'action' in outputDecision && 'reason' in outputDecision
    ? { action: outputDecision.action, reason: outputDecision.reason } : outputDecision
  const decision = replyDecision.parse(structured === 'NO_OP' ? { action: 'NO_OP', reason: 'BYSTANDER' }
    : structured === 'REPLY' ? { action: 'REPLY', reason: 'RELEVANT_TOPIC' } : structured)
  if (localGlossary && decisionInput.glossaryExamples && outputDecision && typeof outputDecision === 'object' && 'glossaryCandidates' in outputDecision) {
    observe?.learned(sourcesForTerms(localGlossary, outputDecision.glossaryCandidates))
  }
  observe?.decision({ ...decision, participation: decisionInput.participation, glossary })
  if (decision.action === 'NO_OP') {
    observe?.skip('MODEL_NO_REPLY')
    return null
  }

  const writing = await db.$transaction(async (tx) => {
    const evidence = await readEvidence(tx, runId, writingRequest)
    if (!evidence) return null
    const [profile] = await tx.$queryRaw<{ style: WritingStyle; prompt: string | null; corePrompt: string | null }[]>`
      SELECT style, prompt, public.rica_simulation_core_prompt(${runId}::uuid) AS "corePrompt"
      FROM public.rica_simulated_writing_profile(${runId}::uuid)
    `
    if (!profile) return null
    if (!await glossaryStillAvailable(tx, runId, glossary)) return null
    const conversation = decisionInput.conversation
    const input = { text, evidence, style: profile.style, time, identityPrompt: profile.prompt ?? undefined, conversation,
      corePrompt: profile.corePrompt ?? undefined, glossary: decisionInput.glossary }
    const outputUnits = maxSimulatedTextLength * 4 + 1024
    if (!await reserveModelBudget(tx, runId, input, outputUnits)) {
      observe?.skip('MODEL_BUDGET_EXHAUSTED')
      return null
    }
    const { characterId, identityId, platform } = context
    return { ...input, attribution: { characterId, identityId, platform } }
  })
  if (!writing) return null

  // Preserve the authorized revisions independently of the objects passed to the provider.
  const allowedRevisions = new Map(writing.evidence.map(({ id, revision }) => [id, revision]))
  signal.throwIfAborted()
  const captureWriting = captureDecision && observe
    ? (prompt: string) => recordRunModelCall(db, runId, 'WRITING', observe.model, prompt) : undefined
  const output = await provider.write({ ...writing, capture: captureWriting }, signal)
  signal.throwIfAborted()
  const draft = validateDraft(output, allowedRevisions)
  if (containsWritingPrompt(draft.text, writing.corePrompt, writing.identityPrompt)) return null
  return { draft, conversation: writing.conversation, decisionRevisions, glossary,
    writingRevisions: allowedRevisions, selfRevisions, goalVersions, beliefVersions }
}

type DraftCandidate = NonNullable<Awaited<ReturnType<typeof buildSimulatedDraft>>>

async function glossaryStillAvailable(tx: Prisma.TransactionClient, runId: string, glossary: GlossarySnapshot) {
  if (!glossary.length) return true
  const current = await readChatGlossary(tx, runId)
  return glossary.every(({ id, version }) => current?.terms.some((term) => term.id === id && term.version === version))
}

async function recheckDraft(
  tx: Prisma.TransactionClient, runId: string, request: WritingRequest, candidate: DraftCandidate,
) {
  if (!evidenceMatches(await readEvidence(tx, runId, decisionRequest), candidate.decisionRevisions)
    || !evidenceMatches(await readEvidence(tx, runId, request), candidate.writingRevisions)
    || !await glossaryStillAvailable(tx, runId, candidate.glossary)) return false
  const context = await loadRunContinuity(tx, runId)
  return !!context && evidenceMatches(context.self.facts, candidate.selfRevisions)
    && context.goals.map(({ id, version }) => id + ':' + version).join(',') === candidate.goalVersions
    && JSON.stringify(beliefRefs(context)) === JSON.stringify(candidate.beliefVersions)
    && (request.purpose !== 'PUBLIC_REFERENCE'
      || JSON.stringify(await readChatWritingContext(tx, runId)) === JSON.stringify(candidate.conversation))
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

export type ResolveDraftModel = (profile?: string) => Plugin<ModelProvider> | Promise<Plugin<ModelProvider>>

export async function processSimulatedDraft(
  db: PrismaClient, eventId: string, resolveAdapter: ResolveSimulationAdapter,
  configuredModel: Plugin<ModelProvider> | ResolveDraftModel, attempt?: OutboxAttempt, review?: ReviewPublicReply,
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

  // Private simulation stays local. Hosted plugins receive only the public writing input.
  let selected = localSimulationModel
  if (typeof configuredModel === 'function') {
    if (request?.purpose === 'PRIVATE_REPLY') {
      selected = await configuredModel('simulated')
    } else if (request?.purpose === 'PUBLIC_REFERENCE') {
      const [profile] = await db.$queryRaw<{ model_profile: string | null }[]>`
        SELECT model_profile FROM public.rica_simulated_writing_profile(${run.id}::uuid)
      `
      if (profile) selected = await configuredModel(profile.model_profile ?? undefined)
    }
  } else selected = configuredModel
  const model = request?.purpose === 'PRIVATE_REPLY' && selected.implementation.hostedModel ? localSimulationModel : selected
  const modelId = model.implementation.hostedProvider ?? model.id
  const modelVersion = model.implementation.hostedModel ?? model.version
  // Stay within the 30-second outbox lease. Model calls run outside the write transaction.
  const signal = AbortSignal.timeout(model.implementation.hostedModel ? 20_000 : 5_000)
  const text = input?.text ?? null
  let skipReason: 'DRAFT_UNAVAILABLE' | 'MODEL_BUDGET_EXHAUSTED' | 'MODEL_NO_REPLY' = 'DRAFT_UNAVAILABLE'
  let participationDecision: ParticipationDecision | undefined
  let learnedTerms: ReturnType<typeof sourcesForTerms> = []
  const candidate = request && text !== null
    ? await buildSimulatedDraft(db, run.id, text, request, model.implementation, signal, {
      model: `${modelId}/${modelVersion}`,
      skip: reason => { skipReason = reason },
      decision: decision => { participationDecision = decision },
      learned: terms => { learnedTerms = terms },
    })
    : null

  const actionId = await db.$transaction(async (tx) => {
    const [pending] = await tx.$queryRaw<{ eventId: string }[]>`
      SELECT event_id AS "eventId" FROM public.outbox
      WHERE event_id = ${eventId}::uuid AND type = ${draftQueuedEvent} AND processed_at IS NULL
        AND quarantined_at IS NULL ${outboxAttemptFence(attempt)}
      FOR UPDATE
    `
    if (!pending) return

    let actionId: string | undefined
    if (run.state === 'CONTEXT_READY') {
      await saveChatTerms(tx, run.id, learnedTerms)
      const accepted = candidate && request && await recheckDraft(tx, run.id, request, candidate)
      const [bound] = accepted ? await tx.$queryRaw<{ target: unknown; crossPlatformDuplicate: boolean }[]>`
        SELECT public.rica_simulated_review_target(${run.id}::uuid) AS target,
          public.rica_cross_platform_duplicate(${run.id}::uuid) AS "crossPlatformDuplicate"
      ` : []
      const target = bound?.target ? reviewTarget.parse(bound.target) : null
      const content = accepted ? candidate.draft.text : null
      const adapter = target ? resolveAdapter(target.platform) : undefined
      const proposed = accepted && target && target.platform === input?.platform
        && adapter && matchesSimulationAdapter(input.adapter, adapter) && content
        && content.length <= maxSimulatedTextLength
      if (proposed) {
        const settings = await tx.character.findUniqueOrThrow({
          where: { id: run.characterId }, select: { autoReviewEnabled: true, simulationProposalHours: true },
        })
        const expiresAt = new Date(Date.now() + settings.simulationProposalHours * 3_600_000)
        const payloadHash = createHash('sha256').update(content).digest('hex')
        const crossPlatformDuplicate = bound?.crossPlatformDuplicate ?? false
        const autoReview = review && settings.autoReviewEnabled && target.audience === 'PUBLIC' && !crossPlatformDuplicate
        const reviewDigest = createHash('sha256').update(JSON.stringify({
          payloadHash, target, ...adapter, expiresAt: expiresAt.toISOString(), crossPlatformDuplicate,
          kind: 'REPLY', mode: run.mode, policyVersion: simulationReviewPolicyVersion,
          characterId: run.characterId, runId: run.id, coreVersion: run.coreVersion,
          identityVersion: run.identityVersion, bindingVersion: run.bindingVersion, authEpoch: run.authEpoch,
          decisionEvidence: [...candidate.decisionRevisions], writingEvidence: [...candidate.writingRevisions],
          selfEvidence: [...candidate.selfRevisions], goalVersions: candidate.goalVersions, beliefRefs: candidate.beliefVersions,
          citationIds: candidate.draft.evidenceIds, modelId, modelVersion,
          glossary: candidate.glossary.map(({ id, version }) => [id, version]),
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
            modelId,
            modelVersion,
          },
        })
        const action = await tx.actionProposal.create({
          data: {
            characterId: run.characterId, runId: run.id, target, payloadHash, reviewDigest,
            policyVersion: simulationReviewPolicyVersion, ...adapter, expiresAt, crossPlatformDuplicate,
            autoReviewUntil: autoReview ? new Date(Date.now() + 12_000) : undefined,
          }, select: { id: true },
        })
        actionId = action.id
      }
      const { count } = await tx.agentRun.updateMany({
        where: { id: run.id, state: 'CONTEXT_READY', stateVersion: run.stateVersion },
        data: {
          state: proposed ? 'WAITING_APPROVAL' : skipReason === 'MODEL_NO_REPLY' ? 'SKIPPED' : 'CANCELED',
          stateReason: proposed ? null : skipReason,
          participationDecision,
          stateVersion: { increment: 1 },
        },
      })
      if (count !== 1) throw new Error('Simulated run changed during drafting')
    }
    await tx.outboxEvent.update({ where: { eventId }, data: { processedAt: new Date() } })
    return actionId
  }, { isolationLevel: 'ReadCommitted' })

  if (actionId && review && text !== null && request?.purpose === 'PUBLIC_REFERENCE') {
    const discussion = candidate?.conversation ? JSON.stringify({ ...candidate.conversation, message: text }) : text
    await autoReviewSimulation(db, run.characterId, actionId, discussion, resolveAdapter, review).catch(() => {
      console.warn(JSON.stringify({ service: 'worker', event: 'auto_review_failed', actionId }))
    })
  }
}
