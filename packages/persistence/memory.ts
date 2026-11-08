import type { MemoryCandidate } from '../contracts/memory.js'
import { memoryPrefilterWords, rankMemoryCandidates } from '../runtime/memory-ranking.js'
import { Prisma, type PrismaClient } from './generated/client.js'
import { bindingMatches, lockEventContext, lockSimulatedBinding } from './run-context.js'

export type MemoryRequest =
  | { purpose: 'INTERNAL_CONTEXT' | 'DECISION_SUPPORT' | 'PRIVATE_REPLY'; audience?: never }
  | { purpose: 'PUBLIC_REFERENCE'; audience: string }

type MemoryReadScope = {
  character_id: string
  identity_id: string
  account_id: string
  conversation_id: string | null
  contact_id: string | null
  channel: 'PUBLIC' | 'PRIVATE' | null
  purpose: MemoryRequest['purpose']
  audience: string | null
}

export async function loadMemoryReadScope(
  tx: Prisma.TransactionClient, runId: string, request: MemoryRequest,
): Promise<MemoryReadScope | null> {
  const run = await tx.agentRun.findUnique({
    where: { id: runId },
    include: { inboundEvent: { select: { conversationId: true, contactId: true } } },
  })
  if (!run || run.mode !== 'SIMULATION' || run.state !== 'CONTEXT_READY') return null

  const binding = await lockSimulatedBinding(tx, run.accountId)
  if (!binding || !bindingMatches(run, binding)) return null
  // A retention sweep may have compacted the run while the binding lock was being acquired.
  const current = await tx.agentRun.findFirst({
    where: { id: runId, state: 'CONTEXT_READY', referencesExpiredAt: null }, select: { id: true },
  })
  if (!current) return null
  const context = await lockEventContext(tx, binding, run.inboundEvent)
  if (!context) return null
  const { channel, conversationId, contactId } = context
  if (request.purpose === 'PRIVATE_REPLY' && (channel !== 'PRIVATE' || !contactId)) return null
  if (request.purpose === 'PUBLIC_REFERENCE' && (channel === 'PRIVATE' || !request.audience.trim())) return null

  return {
    character_id: binding.characterId,
    identity_id: binding.identityId,
    account_id: binding.accountId,
    conversation_id: conversationId,
    contact_id: contactId,
    channel,
    purpose: request.purpose,
    audience: request.audience ?? null,
  }
}

export async function readMemoryCandidates(
  tx: Prisma.TransactionClient, scope: MemoryReadScope, options: { query?: string; memoryIds?: string[] } = {},
) {
  const keywordPatterns = options.query === undefined ? undefined : memoryPrefilterWords(options.query)
    .filter((word) => /^[\x00-\x7f]+$/u.test(word))
    .map((word) => '%' + word.replace(/[\\%_]/g, '\\$&') + '%')
  const readScope = { ...scope, keyword_patterns: keywordPatterns }
  const [original] = await tx.$queryRaw<{ role: string }[]>`SELECT current_user AS role`
  await tx.$queryRaw`SELECT set_config('rica.memory_scope', ${JSON.stringify(readScope)}, true)`
  await tx.$executeRaw`SET LOCAL ROLE rica_memory_reader`
  const candidates = await tx.$queryRaw<MemoryCandidate[]>`
    SELECT m.id, m.content, m.revision, m.importance, m.confidence, m.scope, m.created_at AS "createdAt",
      (
        (m.conversation_id = ${scope.conversation_id}::uuid) IS TRUE
        OR EXISTS (
          SELECT 1 FROM public.memory_sources ms
          JOIN public.sources_registry source ON (source.character_id, source.id) = (ms.character_id, ms.source_id)
          WHERE (ms.character_id, ms.memory_id) = (m.character_id, m.id)
            AND source.conversation_id = ${scope.conversation_id}::uuid
        )
      ) AS "sameConversation"
    FROM public.memories m
    WHERE m.character_id = ${scope.character_id}::uuid
    ${options.memoryIds ? Prisma.sql`AND m.id = ANY(${options.memoryIds}::uuid[])` : Prisma.empty}
    ORDER BY m.created_at, m.id
  `
  // Snapshot writes use the original runtime role. Clear the temporary memory scope first.
  await tx.$queryRaw`SELECT set_config('rica.memory_scope', '', true), set_config('role', ${original.role}, true)`
  return candidates
}

export async function listAuthorizedMemoryCandidates(
  db: PrismaClient, runId: string, request: MemoryRequest, query?: string,
) {
  return db.$transaction(async (tx) => {
    const scope = await loadMemoryReadScope(tx, runId, request)
    return scope ? readMemoryCandidates(tx, scope, { query }) : []
  }, { isolationLevel: 'ReadCommitted' })
}

export async function recallAuthorizedMemories(
  db: PrismaClient, runId: string, request: MemoryRequest, query: string, now = new Date(),
) {
  const candidates = await listAuthorizedMemoryCandidates(db, runId, request, query)
  return rankMemoryCandidates(candidates, query, now)
}

type Derivation = { characterId: string; parentMemoryId: string; content: string }

// The database verifies the current parent and copies its complete source set atomically.
export async function deriveMemory(db: PrismaClient, { characterId, parentMemoryId, content }: Derivation) {
  return db.$transaction(async (tx) => {
    const parent = await tx.memory.findUniqueOrThrow({
      where: { characterId_id: { characterId, id: parentMemoryId } },
    })
    return tx.memory.create({
      data: {
        characterId,
        parentMemoryId,
        identityId: parent.identityId,
        accountId: parent.accountId,
        conversationId: parent.conversationId,
        scope: parent.scope,
        visibility: parent.visibility,
        expiresAt: parent.expiresAt,
        confidence: parent.confidence,
        importance: parent.importance,
        content,
      },
    })
  })
}

type Revocation = { kind: 'GRANT' | 'SOURCE'; characterId: string; id: string }

// Administrative callers must authorize the command before entering this persistence boundary.
export async function revokeMemoryAccess(db: PrismaClient, { kind, characterId, id }: Revocation) {
  return db.$transaction(async (tx) => {
    // Match the binding read lock order so revocation and candidate retrieval have a clear boundary.
    const [character] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM characters WHERE id = ${characterId}::uuid FOR UPDATE
    `
    if (!character) return false

    const update = { where: { id, characterId, revokedAt: null }, data: { revokedAt: new Date() } }
    const { count } = kind === 'GRANT'
      ? await tx.memoryGrant.updateMany(update)
      : await tx.sourceRecord.updateMany(update)
    if (kind === 'SOURCE') {
      await tx.$executeRaw`
        UPDATE public.memories m SET status = 'REVOKED', content = ''
        FROM public.memory_sources ms
        JOIN public.sources_registry source ON (source.character_id, source.id) = (ms.character_id, ms.source_id)
        WHERE (m.character_id, m.id) = (ms.character_id, ms.memory_id)
          AND source.character_id = ${characterId}::uuid AND source.id = ${id}::uuid AND source.revoked_at IS NOT NULL
          AND (m.status <> 'REVOKED' OR m.content <> '')
      `
    }
    if (count === 0) return false

    await tx.character.update({
      where: { id: characterId },
      data: { authEpoch: { increment: 1 } },
    })
    return true
  })
}
