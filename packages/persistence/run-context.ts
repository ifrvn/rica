import type { Prisma, PrismaClient, RunStateReason } from './generated/client.js'

export const runQueuedEvent = 'RunQueued.v1'

type Binding = {
  characterId: string
  identityId: string
  accountId: string
  coreVersion: number
  identityVersion: number
  bindingVersion: number
  authEpoch: number
}

export async function lockSimulatedBinding(tx: Prisma.TransactionClient, accountId: string) {
  // Keep the binding and activation state stable through the enclosing transaction.
  const [binding] = await tx.$queryRaw<Binding[]>`
    SELECT c.id AS "characterId", i.id AS "identityId", a.id AS "accountId",
           c.active_core_version AS "coreVersion", i.active_version AS "identityVersion",
           a.binding_version AS "bindingVersion", c.auth_epoch AS "authEpoch"
    FROM platform_accounts a
    JOIN identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
    JOIN characters c ON c.id = i.character_id
    WHERE a.id = ${accountId}::uuid
      AND a.platform IN ('mock-a', 'mock-b')
      AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    FOR SHARE OF c, i, a
  `
  return binding
}

function bindingMatches(run: Binding, current: Binding) {
  return run.characterId === current.characterId
    && run.identityId === current.identityId
    && run.accountId === current.accountId
    && run.coreVersion === current.coreVersion
    && run.identityVersion === current.identityVersion
    && run.bindingVersion === current.bindingVersion
    && run.authEpoch === current.authEpoch
}

export async function prepareSimulatedRun(db: PrismaClient, eventId: string) {
  await db.$transaction(async (tx) => {
    // Duplicate queue delivery must not race the run transition or its acknowledgment.
    const [event] = await tx.$queryRaw<{ runId: string }[]>`
      SELECT run_id AS "runId" FROM outbox
      WHERE event_id = ${eventId}::uuid AND type = ${runQueuedEvent} AND processed_at IS NULL
      FOR UPDATE
    `
    if (!event) return

    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: event.runId } })
    if (run.state === 'QUEUED' && run.mode === 'SIMULATION') {
      const current = await lockSimulatedBinding(tx, run.accountId)
      let reason: RunStateReason | null = null
      if (!current) reason = 'ACCOUNT_UNAVAILABLE'
      else if (!bindingMatches(run, current)) reason = 'BINDING_CHANGED'

      const { count } = await tx.agentRun.updateMany({
        where: { id: run.id, state: 'QUEUED', stateVersion: run.stateVersion },
        data: {
          state: reason ? 'CANCELED' : 'CONTEXT_READY',
          stateReason: reason,
          stateVersion: { increment: 1 },
        },
      })
      if (count !== 1) throw new Error('Simulated run changed during preparation')
    }
    await tx.outboxEvent.update({
      where: { eventId },
      data: { processedAt: new Date() },
    })
  }, { isolationLevel: 'ReadCommitted' })
}
