import type { PrismaClient } from './generated/client.js'
import { bindingMatches, lockEventContext, lockSimulatedBinding } from './run-context.js'

type MemoryRequest =
  | { purpose: 'INTERNAL_CONTEXT' | 'DECISION_SUPPORT' | 'PRIVATE_REPLY'; audience?: never }
  | { purpose: 'PUBLIC_REFERENCE'; audience: string }

type MemoryCandidate = {
  id: string
  content: string
  revision: number
  importance: number
  confidence: number
  createdAt: Date
}

// Internal retrieval boundary. A caller may choose a purpose, while the database supplies the identity and account.
export async function listAuthorizedMemoryCandidates(db: PrismaClient, runId: string, request: MemoryRequest) {
  return db.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({
      where: { id: runId },
      include: { inboundEvent: { select: { conversationId: true, contactId: true } } },
    })
    if (!run || run.mode !== 'SIMULATION' || run.state !== 'CONTEXT_READY') return []

    const binding = await lockSimulatedBinding(tx, run.accountId)
    if (!binding || !bindingMatches(run, binding)) return []
    const context = await lockEventContext(tx, binding, run.inboundEvent)
    if (!context) return []
    const { channel, conversationId, contactId } = context
    if (request.purpose === 'PRIVATE_REPLY' && (channel !== 'PRIVATE' || !contactId)) return []
    if (request.purpose === 'PUBLIC_REFERENCE' && channel === 'PRIVATE') return []

    const scope = JSON.stringify({
      character_id: binding.characterId,
      identity_id: binding.identityId,
      account_id: binding.accountId,
      conversation_id: conversationId,
      contact_id: contactId,
      channel,
      purpose: request.purpose,
      audience: request.audience ?? null,
    })
    // Bind scope and demote on this transaction's connection before reading any memory.
    await tx.$queryRaw`SELECT set_config('rica.memory_scope', ${scope}, true)`
    await tx.$executeRaw`SET LOCAL ROLE rica_memory_reader`
    return tx.$queryRaw<MemoryCandidate[]>`
      SELECT id, content, revision, importance, confidence, created_at AS "createdAt"
      FROM public.memories
      ORDER BY created_at, id
    `
  }, { isolationLevel: 'ReadCommitted' })
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
    if (count === 0) return false

    await tx.character.update({
      where: { id: characterId },
      data: { authEpoch: { increment: 1 } },
    })
    return true
  })
}
