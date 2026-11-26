import { maxSimulatedTextLength, simulationMessageSeparator } from '../contracts/platforms.js'
import type { ChatReplyStop } from '../contracts/review.js'
import { containsWritingPrompt } from '@ricajs/runtime/writing-prompts'
import { chatDraftDecision, maxChatReplyMessages, ModelProviderError, resolveParticipation, replyDecision, type CaptureModelCall, type ModelEvidence, type ModelProvider, type Participation,
  type ReplyDecision, type WritingStyle } from '@ricajs/contracts/model-provider'
import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import { captureMemorySnapshot, captureSelfModelSnapshot, replayMemorySnapshotInTransaction } from '@ricajs/persistence/memory-snapshot'
import type { MemoryRequest } from '@ricajs/persistence/memory'
import { loadRunContinuity } from '@ricajs/persistence/run-continuity'
import type { RunContinuity } from '@ricajs/contracts/run-continuity'
import { simulationWritingContext } from '../contracts/observability.js'
import { recordRunModelCall } from './model-calls.js'
import { readChatReplyStop } from './chat-review.js'
import { glossaryReferences, learningExamples, matchChatGlossary, readChatGlossary, sourcesForTerms,
  type GlossarySnapshot } from './glossary.js'

export type WritingRequest = Extract<MemoryRequest, { purpose: 'PUBLIC_REFERENCE' }>
  | { purpose: 'PRIVATE_REPLY' }

export const decisionRequest = { purpose: 'DECISION_SUPPORT' } as const
export type ParticipationDecision = ReplyDecision & { participation: Participation; glossary: GlossarySnapshot }
export type DraftSkipReason = 'DRAFT_UNAVAILABLE' | 'MODEL_BUDGET_EXHAUSTED' | 'MODEL_NO_REPLY'
  | 'MODEL_DECISION_INVALID_OUTPUT' | 'MODEL_WRITING_INVALID_OUTPUT' | 'IM_MANUAL_REVIEW_DISABLED' | ChatReplyStop

class InvalidDraftOutput extends Error {
  constructor() { super('Invalid simulated writing output') }
}

function invalidModelOutput(error: unknown) {
  return error instanceof ModelProviderError && error.code === 'INVALID_OUTPUT'
}

async function readDecisionOutput(call: () => Promise<unknown>, signal: AbortSignal) {
  signal.throwIfAborted()
  let output: unknown
  try {
    output = await call()
  } catch (error) {
    signal.throwIfAborted()
    if (invalidModelOutput(error)) return null
    throw error
  }
  signal.throwIfAborted()
  return output
}

async function readParticipationDecision(provider: ModelProvider, input: Parameters<ModelProvider['decide']>[0], signal: AbortSignal) {
  const output = await readDecisionOutput(() => provider.decide(input, signal), signal)
  const structured = output && typeof output === 'object' && 'action' in output && 'reason' in output
    ? { action: output.action, reason: output.reason } : output
  const decision = replyDecision.safeParse(structured === 'NO_OP' ? { action: 'NO_OP', reason: 'BYSTANDER' }
    : structured === 'REPLY' ? { action: 'REPLY', reason: 'RELEVANT_TOPIC' } : structured)
  return decision.success ? { decision: decision.data, output } : null
}

async function readEvidence(
  tx: Prisma.TransactionClient, runId: string, request: MemoryRequest,
): Promise<ModelEvidence[] | null> {
  const replay = await replayMemorySnapshotInTransaction(tx, runId, request)
  return replay?.flatMap(({ candidate }) => candidate
    ? [{ id: candidate.id, revision: candidate.revision, content: candidate.content }]
    : []) ?? null
}

function validateDraft(output: unknown, allowedIds: ReadonlyMap<string, number>, chat: boolean) {
  if (!output || typeof output !== 'object' || !('evidenceIds' in output)) {
    throw new InvalidDraftOutput()
  }

  const { evidenceIds } = output
  const parts = 'messages' in output && !('text' in output) && chat ? output.messages
    : 'text' in output && !('messages' in output) ? [output.text] : null
  if (!Array.isArray(parts) || !parts.length || parts.length > maxChatReplyMessages
    || !Array.from(parts).every((part): part is string => typeof part === 'string' && !!part.trim()
      && !part.includes('\0') && !part.includes(simulationMessageSeparator))
    || !Array.isArray(evidenceIds) || evidenceIds.length > allowedIds.size
    || !Array.from(evidenceIds).every((id): id is string => typeof id === 'string' && allowedIds.has(id))
    || new Set(evidenceIds).size !== evidenceIds.length) {
    throw new InvalidDraftOutput()
  }

  const messages = parts.map(part => part.trim())
  const payload = messages.join(simulationMessageSeparator)
  if (payload.length > maxSimulatedTextLength) throw new InvalidDraftOutput()
  return { messages, payload, evidenceIds: [...evidenceIds] }
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

type DraftInput = { runId: string; text: string; writingRequest: WritingRequest; isIm: boolean }
type DraftObservation = {
  model: string
  skip: (reason: DraftSkipReason) => void
  decision: (decision: ParticipationDecision) => void
  learned: (terms: ReturnType<typeof sourcesForTerms>) => void
}

const writingOutputUnits = maxSimulatedTextLength * 4 + 1024

async function readWritingInput(
  tx: Prisma.TransactionClient, { runId, text, writingRequest, isIm }: DraftInput, context: RunContinuity, glossary: GlossarySnapshot,
) {
  const evidence = await readEvidence(tx, runId, writingRequest)
  if (!evidence) return null
  const [profile] = await tx.$queryRaw<{ style: WritingStyle; prompt: string | null; corePrompt: string | null }[]>`
    SELECT style, prompt, public.rica_simulation_core_prompt(${runId}::uuid) AS "corePrompt"
    FROM public.rica_simulated_writing_profile(${runId}::uuid)
  `
  if (!profile || !await glossaryStillAvailable(tx, runId, glossary)) return null
  const { characterId, identityId, platform } = context
  return { text, evidence, style: profile.style, time: { ...context.time }, identityPrompt: profile.prompt ?? undefined,
    isIm, corePrompt: profile.corePrompt ?? undefined, glossary: glossary.length ? glossaryReferences(glossary) : undefined,
    attribution: { characterId, identityId, platform } }
}

async function prepareDraft(tx: Prisma.TransactionClient, draft: DraftInput, provider: ModelProvider, observe?: DraftObservation) {
  const { runId, text, writingRequest, isIm } = draft
  const evidence = await readEvidence(tx, runId, decisionRequest)
  const context = evidence && await loadRunContinuity(tx, runId)
  if (!context || !await captureSelfModelSnapshot(tx, runId, context.characterId, context.self.facts)) return null
  const [profile] = await tx.$queryRaw<{ prompt: string | null; participation: string | null }[]>`
    SELECT prompt, public.rica_simulation_participation(${runId}::uuid) AS participation
    FROM public.rica_simulated_writing_profile(${runId}::uuid)
  `
  if (!profile) return null
  const conversation = isIm && writingRequest.purpose === 'PUBLIC_REFERENCE' ? await readChatWritingContext(tx, runId) : undefined
  const identityPrompt = profile.prompt ?? undefined
  const participation = resolveParticipation(profile.participation, identityPrompt)
  const localGlossary = conversation && provider.hostedModel ? await readChatGlossary(tx, runId) : undefined
  const glossary = localGlossary && conversation
    ? matchChatGlossary(localGlossary, text, conversation.history.slice(-2).map(({ message }) => message)) : []
  if (conversation && provider.participateAndWrite) {
    const writing = await readWritingInput(tx, draft, context, glossary)
    if (!writing) return null
    const visibleMessages = [...conversation.history, { speaker: conversation.speaker, message: text }]
    const learning = localGlossary && observe && {
      ...localGlossary,
      examples: localGlossary.examples.filter(example =>
        visibleMessages.some(({ speaker, message }) => speaker === example.speaker && message === example.message)),
    }
    const glossaryExamples = learning ? learningExamples(learning) : undefined
    const input = { ...writing, conversation, participation, glossaryExamples }
    if (await reserveModelBudget(tx, runId, input, writingOutputUnits)) {
      return { input, context, decisionEvidence: evidence, localGlossary: learning, glossary, combined: provider.participateAndWrite.bind(provider) }
    }
    observe?.skip('MODEL_BUDGET_EXHAUSTED')
    return null
  }
  const examples = localGlossary && observe ? learningExamples(localGlossary) : undefined
  const input = { text, evidence, context, conversation, isIm, identityPrompt, participation,
    glossary: glossary.length ? glossaryReferences(glossary) : undefined, glossaryExamples: examples } as const
  const outputUnits = examples ? 1024 : 64
  if (await reserveModelBudget(tx, runId, input, outputUnits)) return { input, context, decisionEvidence: evidence, localGlossary, glossary, outputUnits }
  observe?.skip('MODEL_BUDGET_EXHAUSTED')
  return null
}

type PreparedDraft = NonNullable<Awaited<ReturnType<typeof prepareDraft>>>
type CaptureDraftCall = (stage: 'DECISION' | 'WRITING' | 'DECISION_AND_WRITING') => CaptureModelCall
type DraftDecision = { decision: ReplyDecision; output: unknown; messages?: string[]; revisions?: Map<string, number> }

async function decideDraft(
  db: PrismaClient, runId: string, prepared: PreparedDraft, provider: ModelProvider,
  signal: AbortSignal, capture?: CaptureDraftCall, observe?: DraftObservation,
): Promise<DraftDecision | null> {
  if (prepared.combined) {
    const { input, combined } = prepared
    const revisions = new Map(input.evidence.map(({ id, revision }) => [id, revision]))
    const output = await readDecisionOutput(() => combined({ ...input, capture: capture?.('DECISION_AND_WRITING') }, signal), signal)
    const parsed = chatDraftDecision.safeParse(output)
    if (parsed.success) {
      const { action, reason } = parsed.data
      return action === 'REPLY'
        ? { decision: { action, reason }, output: parsed.data, messages: parsed.data.messages, revisions }
        : { decision: { action, reason }, output: parsed.data }
    }
  } else {
    const { input, outputUnits } = prepared
    const decisionCall = { ...input, capture: capture?.('DECISION') }
    const first = await readParticipationDecision(provider, decisionCall, signal)
    if (first) return first
    if (!await db.$transaction(tx => reserveModelBudget(tx, runId, input, outputUnits))) {
      observe?.skip('MODEL_BUDGET_EXHAUSTED')
      return null
    }
    const second = await readParticipationDecision(provider, decisionCall, signal)
    if (second) return second
  }
  observe?.skip('MODEL_DECISION_INVALID_OUTPUT')
  return null
}

async function prepareSeparateWriting(
  tx: Prisma.TransactionClient, draft: DraftInput, prepared: PreparedDraft, decision: ReplyDecision, observe?: DraftObservation,
) {
  const { runId } = draft
  const { context, glossary, input: { conversation } } = prepared
  if (conversation) {
    const stop = await readChatReplyStop(tx, runId, decision.reason)
    if (stop) {
      observe?.skip(stop)
      return null
    }
  }
  const input = await readWritingInput(tx, draft, context, glossary)
  if (!input) return null
  const { attribution, ...writingInput } = input
  const writing = { ...writingInput, conversation }
  if (!await reserveModelBudget(tx, runId, writing, writingOutputUnits)) {
    observe?.skip('MODEL_BUDGET_EXHAUSTED')
    return null
  }
  return { ...writing, attribution }
}

async function writeDraft(
  db: PrismaClient, input: DraftInput, prepared: PreparedDraft, result: DraftDecision,
  provider: ModelProvider, signal: AbortSignal, capture?: CaptureDraftCall, observe?: DraftObservation,
) {
  const writing = prepared.combined ? prepared.input
    : await db.$transaction(tx => prepareSeparateWriting(tx, input, prepared, result.decision, observe))
  if (!writing) return null

  // Preserve the authorized revisions independently of the objects passed to the provider.
  const writingRevisions = result.revisions ?? new Map(writing.evidence.map(({ id, revision }) => [id, revision]))
  signal.throwIfAborted()
  let draft: ReturnType<typeof validateDraft>
  try {
    const output = prepared.combined ? { messages: result.messages, evidenceIds: [...writingRevisions.keys()] }
      : await provider.write({ ...writing, capture: capture?.('WRITING') }, signal)
    signal.throwIfAborted()
    draft = validateDraft(output, writingRevisions, !!writing.conversation)
  } catch (error) {
    signal.throwIfAborted()
    if (!observe || !(invalidModelOutput(error) || error instanceof InvalidDraftOutput)) throw error
    observe.skip('MODEL_WRITING_INVALID_OUTPUT')
    return null
  }
  if ([' ', ''].some(separator => containsWritingPrompt(draft.messages.join(separator), writing.corePrompt, writing.identityPrompt))) return null
  return { draft, conversation: writing.conversation, writingRevisions }
}

// The trusted caller supplies the writing scope separately from message text.
export async function buildSimulatedDraft(
  db: PrismaClient, runId: string, text: string, writingRequest: WritingRequest,
  provider: ModelProvider, signal: AbortSignal, isIm = false, observe?: DraftObservation,
) {
  if (text.length > maxSimulatedTextLength) throw new Error('Simulated message is too long')
  signal.throwIfAborted()
  if (!await captureMemorySnapshot(db, runId, writingRequest, text)
    || !await captureMemorySnapshot(db, runId, decisionRequest, text)) return null

  const input = { runId, text, writingRequest, isIm }
  const prepared = await db.$transaction(tx => prepareDraft(tx, input, provider, observe))
  if (!prepared) return null
  const { context, decisionEvidence, localGlossary, glossary } = prepared
  const selfRevisions = new Map(context.self.facts.map(({ id, revision }) => [id, revision]))
  const goalVersions = context.goals.map(({ id, version }) => id + ':' + version).join(',')
  const beliefVersions = beliefRefs(context)

  signal.throwIfAborted()
  const decisionRevisions = new Map(decisionEvidence.map(({ id, revision }) => [id, revision]))
  const capture: CaptureDraftCall | undefined = observe && provider.hostedModel && writingRequest.purpose === 'PUBLIC_REFERENCE'
    ? stage => prompt => recordRunModelCall(db, runId, stage, observe.model, prompt) : undefined
  const result = await decideDraft(db, runId, prepared, provider, signal, capture, observe)
  if (!result) return null
  const { decision, output } = result
  if (localGlossary && prepared.input.glossaryExamples && output && typeof output === 'object' && 'glossaryCandidates' in output) {
    observe?.learned(sourcesForTerms(localGlossary, output.glossaryCandidates))
  }
  observe?.decision({ ...decision, participation: prepared.input.participation, glossary })
  if (decision.action === 'NO_OP') {
    observe?.skip('MODEL_NO_REPLY')
    return null
  }

  const writing = await writeDraft(db, input, prepared, result, provider, signal, capture, observe)
  return writing && { ...writing, isIm, decisionRevisions, glossary, selfRevisions, goalVersions, beliefVersions }
}

export type DraftCandidate = NonNullable<Awaited<ReturnType<typeof buildSimulatedDraft>>>

async function glossaryStillAvailable(tx: Prisma.TransactionClient, runId: string, glossary: GlossarySnapshot) {
  if (!glossary.length) return true
  const current = await readChatGlossary(tx, runId)
  return glossary.every(({ id, version }) => current?.terms.some((term) => term.id === id && term.version === version))
}

export async function recheckDraft(
  tx: Prisma.TransactionClient, runId: string, request: WritingRequest, candidate: DraftCandidate,
) {
  if (!evidenceMatches(await readEvidence(tx, runId, decisionRequest), candidate.decisionRevisions)
    || !evidenceMatches(await readEvidence(tx, runId, request), candidate.writingRevisions)
    || !await glossaryStillAvailable(tx, runId, candidate.glossary)) return false
  const context = await loadRunContinuity(tx, runId)
  return !!context && evidenceMatches(context.self.facts, candidate.selfRevisions)
    && context.goals.map(({ id, version }) => id + ':' + version).join(',') === candidate.goalVersions
    && JSON.stringify(beliefRefs(context)) === JSON.stringify(candidate.beliefVersions)
    && (!candidate.isIm || request.purpose !== 'PUBLIC_REFERENCE'
      || JSON.stringify(await readChatWritingContext(tx, runId)) === JSON.stringify(candidate.conversation))
}

export async function generateSimulatedDraft(
  db: PrismaClient, runId: string, text: string, request: WritingRequest,
  provider: ModelProvider, signal: AbortSignal = AbortSignal.timeout(5_000),
) {
  const candidate = await buildSimulatedDraft(db, runId, text, request, provider, signal)
  if (!candidate || !await db.$transaction((tx) => recheckDraft(tx, runId, request, candidate))) return null
  signal.throwIfAborted()
  const { messages, evidenceIds } = candidate.draft
  return messages.length === 1 ? { text: messages[0], evidenceIds } : { messages, evidenceIds }
}
