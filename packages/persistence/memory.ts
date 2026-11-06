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

    return tx.$queryRaw<MemoryCandidate[]>`
      WITH eligible AS (
        SELECT m.id, m.content, m.revision, m.importance, m.confidence, m.created_at, m.visibility,
          (
            m.scope = 'CORE'
            OR (m.scope = 'IDENTITY' AND m.identity_id = ${binding.identityId}::uuid)
            OR (m.scope = 'ACCOUNT' AND m.account_id = ${binding.accountId}::uuid)
            OR (m.scope = 'CONVERSATION' AND m.conversation_id = ${conversationId}::uuid)
          ) AS native,
          EXISTS (
            SELECT 1 FROM memory_grants g
            WHERE g.character_id = m.character_id AND g.memory_id = m.id
              AND g.recipient_identity_id = ${binding.identityId}::uuid
              AND (g.recipient_account_id IS NULL OR g.recipient_account_id = ${binding.accountId}::uuid)
              AND g.purpose = ${request.purpose}::"MemoryPurpose"
              AND g.audience IS NOT DISTINCT FROM ${request.audience ?? null}::text
              AND (g.purpose <> 'PRIVATE_REPLY' OR (
                g.recipient_conversation_id = ${conversationId}::uuid
                AND g.recipient_contact_id = ${contactId}::uuid
              ))
              AND g.valid_from <= statement_timestamp() AND g.valid_until > statement_timestamp()
              AND g.revoked_at IS NULL
          ) AS granted
        FROM memories m
        WHERE m.character_id = ${binding.characterId}::uuid AND m.status = 'ACTIVE'
          AND m.visibility <> 'RESTRICTED'
          AND (m.scope <> 'CONVERSATION' OR m.conversation_id = ${conversationId}::uuid)
          AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
          AND EXISTS (
            SELECT 1 FROM memory_sources ms
            WHERE ms.character_id = m.character_id AND ms.memory_id = m.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_sources ms
            JOIN sources_registry s ON (s.character_id, s.id) = (ms.character_id, ms.source_id)
            WHERE ms.character_id = m.character_id AND ms.memory_id = m.id
              AND (
                s.revoked_at IS NOT NULL OR s.classification = 'RESTRICTED'
                OR (s.conversation_id IS NOT NULL AND s.conversation_id IS DISTINCT FROM ${conversationId}::uuid)
                OR (${request.purpose}::"MemoryPurpose" = 'PRIVATE_REPLY' AND s.classification = 'CONFIDENTIAL')
                OR (s.classification <> 'PUBLIC' AND (
                  m.scope = 'CORE'
                  OR ${request.purpose}::"MemoryPurpose" = 'PUBLIC_REFERENCE'
                  OR s.identity_id IS DISTINCT FROM ${binding.identityId}::uuid
                  OR (s.account_id IS NOT NULL AND s.account_id <> ${binding.accountId}::uuid)
                ))
              )
          )
      )
      SELECT id, content, revision, importance, confidence, created_at AS "createdAt"
      FROM eligible
      WHERE (
        ${request.purpose}::"MemoryPurpose" IN ('INTERNAL_CONTEXT', 'DECISION_SUPPORT')
        AND (native OR (granted AND visibility IN ('PUBLIC', 'PERSONAL')))
      ) OR (
        ${request.purpose}::"MemoryPurpose" = 'PUBLIC_REFERENCE' AND visibility = 'PUBLIC' AND granted
      ) OR (
        ${request.purpose}::"MemoryPurpose" = 'PRIVATE_REPLY' AND visibility IN ('PUBLIC', 'PERSONAL') AND granted
      )
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
