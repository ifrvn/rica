import { logger } from '@ricajs/runtime/logging'
import { createHash } from 'node:crypto'
import { reviewTarget } from '../contracts/review.js'
import { maxSimulatedTextLength, matchesSimulationAdapter, type ResolveSimulationAdapter } from '../contracts/platforms.js'
import { autoReviewSimulation, simulationReviewPolicyVersion } from './review.js'
import type { ReviewPublicReply } from '@ricajs/contracts/auto-review'
import type { ModelProvider } from '@ricajs/contracts/model-provider'
import type { Plugin } from '@ricajs/plugin-host'
import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import { loadMemoryReadScope } from '@ricajs/persistence/memory'
import { draftQueuedEvent, outboxAttemptFence, type OutboxAttempt } from '@ricajs/persistence/run-context'
import { localSimulationModel } from '../adapters/model.js'
import { buildSimulatedDraft, decisionRequest, recheckDraft, type DraftCandidate, type DraftSkipReason,
  type ParticipationDecision, type WritingRequest } from './draft-builder.js'
import { readChatReplyStop } from './chat-review.js'
import { saveChatTerms, type sourcesForTerms } from './glossary.js'

export { generateSimulatedDraft } from './draft-builder.js'

export type ResolveDraftModel = (profile?: string) => Plugin<ModelProvider> | Promise<Plugin<ModelProvider>>

async function findDraftRun(db: PrismaClient, eventId: string, attempt?: OutboxAttempt) {
  const event = await db.outboxEvent.findFirst({
    where: { eventId, type: draftQueuedEvent, processedAt: null, quarantinedAt: null,
      ...(attempt ? { generation: attempt.generation, attempts: attempt.ticket } : {}) },
    include: {
      run: { include: { inboundEvent: { select: { adapterId: true, adapterVersion: true, consoleSpeakerId: true } } } },
    },
  })
  return event?.run
}

type DraftRun = NonNullable<Awaited<ReturnType<typeof findDraftRun>>>

async function readDraftTarget(db: PrismaClient, run: DraftRun, resolveAdapter: ResolveSimulationAdapter) {
  const inbound = run.inboundEvent
  return db.$transaction(async (tx) => {
    const scope = await loadMemoryReadScope(tx, run.id, decisionRequest)
    if (!scope) return null
    const platform = inbound.adapterId ?? (await tx.$queryRaw<{ platform: string | null }[]>`
      SELECT public.rica_simulated_review_target(${run.id}::uuid)->>'platform' AS platform
    `)[0]?.platform
    const adapter = platform ? resolveAdapter(platform) : undefined
    if (!adapter || (inbound.adapterId !== null
      && (inbound.adapterId !== adapter.adapterId || inbound.adapterVersion !== adapter.adapterVersion))
      || (inbound.consoleSpeakerId && !adapter.isIm)) return null
    const { messageText } = await tx.inboundEvent.findUniqueOrThrow({
      where: { id: run.inboundEventId }, select: { messageText: true },
    })
    const stop = inbound.consoleSpeakerId ? await readChatReplyStop(tx, run.id) : null
    return { scope, text: messageText, platform, adapter, stop }
  })
}

type DraftTarget = NonNullable<Awaited<ReturnType<typeof readDraftTarget>>>

async function resolveSimulationDraftModel(
  db: PrismaClient, runId: string, request: WritingRequest | null, configuredModel: Plugin<ModelProvider> | ResolveDraftModel,
) {
  // Private simulation stays local. Hosted plugins receive only the public writing input.
  let selected = localSimulationModel
  if (typeof configuredModel === 'function') {
    if (request?.purpose === 'PRIVATE_REPLY') {
      selected = await configuredModel('simulated')
    } else if (request?.purpose === 'PUBLIC_REFERENCE') {
      const [profile] = await db.$queryRaw<{ model_profile: string | null }[]>`
        SELECT model_profile FROM public.rica_simulated_writing_profile(${runId}::uuid)
      `
      if (profile) selected = await configuredModel(profile.model_profile ?? undefined)
    }
  } else selected = configuredModel
  return request?.purpose === 'PRIVATE_REPLY' && selected.implementation.hostedModel ? localSimulationModel : selected
}

type DraftModelDetails = { modelId: string; modelVersion: string; signal: AbortSignal }

async function createDraftProposal(
  tx: Prisma.TransactionClient, run: DraftRun, input: DraftTarget, candidate: DraftCandidate,
  resolveAdapter: ResolveSimulationAdapter, reviewEnabled: boolean, { modelId, modelVersion, signal }: DraftModelDetails,
): Promise<{ actionId?: string; skipReason?: DraftSkipReason } | undefined> {
  const [bound] = await tx.$queryRaw<{ target: unknown; crossPlatformDuplicate: boolean }[]>`
    SELECT public.rica_simulated_review_target(${run.id}::uuid) AS target,
      public.rica_cross_platform_duplicate(${run.id}::uuid) AS "crossPlatformDuplicate"
  `
  const target = bound?.target ? reviewTarget.parse(bound.target) : null
  const content = candidate.draft.payload
  const adapter = target ? resolveAdapter(target.platform) : undefined
  if (!target || target.platform !== input.platform || !adapter || input.adapter.isIm !== adapter.isIm
    || !matchesSimulationAdapter(input.adapter, adapter) || !content || content.length > maxSimulatedTextLength) return

  const settings = await tx.character.findUniqueOrThrow({
    where: { id: run.characterId }, select: { simulationProposalHours: true },
  })
  const [flags] = await tx.$queryRaw<{ enabled: boolean; manual: boolean }[]>`
    SELECT * FROM public.rica_simulation_review_flags(${run.id}::uuid)
  `
  if (!flags) return
  const crossPlatformDuplicate = bound?.crossPlatformDuplicate ?? false
  const autoReview = reviewEnabled && flags.enabled && target.audience === 'PUBLIC' && !crossPlatformDuplicate
  if (!autoReview && adapter.isIm && !flags.manual) return { skipReason: 'IM_MANUAL_REVIEW_DISABLED' }

  const { isIm, ...adapterBinding } = adapter
  const expiresAt = new Date(Date.now() + settings.simulationProposalHours * 3_600_000)
  const payloadHash = createHash('sha256').update(content).digest('hex')
  const reviewDigest = createHash('sha256').update(JSON.stringify({
    payloadHash, target, ...adapterBinding, expiresAt: expiresAt.toISOString(), crossPlatformDuplicate,
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
      policyVersion: simulationReviewPolicyVersion, ...adapterBinding, expiresAt, crossPlatformDuplicate, isIm,
      autoReviewUntil: autoReview ? new Date(Date.now() + 12_000) : undefined,
    }, select: { id: true },
  })
  return { actionId: action.id }
}

async function commitDraft(db: PrismaClient, draft: DraftModelDetails & {
  eventId: string; attempt?: OutboxAttempt; run: DraftRun; input: DraftTarget | null; request: WritingRequest | null;
  candidate: DraftCandidate | null; resolveAdapter: ResolveSimulationAdapter; reviewEnabled: boolean; skipReason: DraftSkipReason;
  participationDecision?: ParticipationDecision; learnedTerms: ReturnType<typeof sourcesForTerms>;
}) {
  const { eventId, attempt, run, input, request, candidate, resolveAdapter, reviewEnabled, participationDecision, learnedTerms } = draft
  return db.$transaction(async (tx) => {
    const [pending] = await tx.$queryRaw<{ eventId: string }[]>`
      SELECT event_id AS "eventId" FROM public.outbox
      WHERE event_id = ${eventId}::uuid AND type = ${draftQueuedEvent} AND processed_at IS NULL
        AND quarantined_at IS NULL ${outboxAttemptFence(attempt)}
      FOR UPDATE
    `
    if (!pending) return

    let actionId: string | undefined
    let skipReason = draft.skipReason
    if (run.state === 'CONTEXT_READY') {
      await saveChatTerms(tx, run.id, learnedTerms)
      const checked = candidate && request && await recheckDraft(tx, run.id, request, candidate)
      const stop = checked && run.inboundEvent.consoleSpeakerId ? await readChatReplyStop(tx, run.id, participationDecision?.reason) : null
      if (stop) skipReason = stop
      if (checked && !stop && input) {
        const proposal = await createDraftProposal(tx, run, input, candidate, resolveAdapter, reviewEnabled, draft)
        actionId = proposal?.actionId
        if (proposal?.skipReason) skipReason = proposal.skipReason
      }
      const { count } = await tx.agentRun.updateMany({
        where: { id: run.id, state: 'CONTEXT_READY', stateVersion: run.stateVersion },
        data: {
          state: actionId ? 'WAITING_APPROVAL'
            : ['MODEL_NO_REPLY', 'CHAT_REPEAT', 'CHAT_MOVED_ON'].includes(skipReason) ? 'SKIPPED' : 'CANCELED',
          stateReason: actionId ? null : skipReason,
          participationDecision,
          stateVersion: { increment: 1 },
        },
      })
      if (count !== 1) throw new Error('Simulated run changed during drafting')
    }
    await tx.outboxEvent.update({ where: { eventId }, data: { processedAt: new Date() } })
    return actionId
  }, { isolationLevel: 'ReadCommitted' })
}

export async function processSimulatedDraft(
  db: PrismaClient, eventId: string, resolveAdapter: ResolveSimulationAdapter,
  configuredModel: Plugin<ModelProvider> | ResolveDraftModel, attempt?: OutboxAttempt, review?: ReviewPublicReply,
) {
  const run = await findDraftRun(db, eventId, attempt)
  if (!run) return
  const input = await readDraftTarget(db, run, resolveAdapter)
  const scope = input?.stop ? undefined : input?.scope
  const request: WritingRequest | null = scope?.channel === 'PRIVATE'
    ? { purpose: 'PRIVATE_REPLY' }
    : scope?.channel === 'PUBLIC' && scope.conversation_id
      ? { purpose: 'PUBLIC_REFERENCE', audience: scope.conversation_id }
      : null

  const model = await resolveSimulationDraftModel(db, run.id, request, configuredModel)
  const modelId = model.implementation.hostedProvider ?? model.id
  const modelVersion = model.implementation.hostedModel ?? model.version
  // Stay within the 30-second outbox lease. Model calls run outside the write transaction.
  const signal = AbortSignal.timeout(model.implementation.hostedModel ? 20_000 : 5_000)
  const text = input?.text ?? null
  let skipReason: DraftSkipReason = input?.stop ?? 'DRAFT_UNAVAILABLE'
  let participationDecision: ParticipationDecision | undefined
  let learnedTerms: ReturnType<typeof sourcesForTerms> = []
  const candidate = request && text !== null && !input?.stop
    ? await buildSimulatedDraft(db, run.id, text, request, model.implementation, signal, input?.adapter.isIm === true, {
      model: `${modelId}/${modelVersion}`,
      skip: reason => { skipReason = reason },
      decision: decision => { participationDecision = decision },
      learned: terms => { learnedTerms = terms },
    })
    : null

  const actionId = await commitDraft(db, {
    eventId, attempt, run, input, request, candidate, resolveAdapter, reviewEnabled: !!review,
    modelId, modelVersion, signal, skipReason, participationDecision, learnedTerms,
  })

  if (actionId && review && text !== null && request?.purpose === 'PUBLIC_REFERENCE') {
    const discussion = candidate?.conversation ? JSON.stringify({ ...candidate.conversation, message: text }) : text
    await autoReviewSimulation(db, run.characterId, actionId, discussion, resolveAdapter, review).catch(() => {
      logger.warn({ service: 'worker', event: 'auto_review_failed', actionId })
    })
  }
}
