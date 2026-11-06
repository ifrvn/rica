import type { InboundKind, PrismaClient } from './generated/client.js'

type SimulatedEvent = Readonly<{
  accountId: string
  sourceKey: string
  kind: InboundKind
  occurredAt: Date
}>

type Binding = {
  characterId: string
  identityId: string
  accountId: string
  coreVersion: number
  identityVersion: number
  bindingVersion: number
  authEpoch: number
}

// Internal entry point for trusted simulation fixtures. Public ingress must authenticate its source.
export async function ingestSimulatedEvent(db: PrismaClient, event: SimulatedEvent) {
  const { accountId, sourceKey, kind, occurredAt } = event
  if (sourceKey.trim().length === 0 || sourceKey.length > 256 || !Number.isFinite(occurredAt.getTime())) {
    throw new Error('Invalid simulated event')
  }

  return db.$transaction(async (tx) => {
    // Keep the resolved binding and activation state stable until the event and run commit.
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
    if (!binding) return { status: 'ACCOUNT_UNAVAILABLE' } as const

    const { count } = await tx.inboundEvent.createMany({
      data: {
        characterId: binding.characterId,
        identityId: binding.identityId,
        accountId: binding.accountId,
        sourceKey,
        kind,
        occurredAt,
      },
      skipDuplicates: true,
    })
    const inbound = await tx.inboundEvent.findUniqueOrThrow({
      where: { accountId_sourceKey: { accountId, sourceKey } },
      select: { id: true },
    })
    if (count === 0) {
      const run = await tx.agentRun.findUniqueOrThrow({
        where: { inboundEventId: inbound.id },
        select: { id: true },
      })
      return { status: 'DUPLICATE', runId: run.id } as const
    }

    const run = await tx.agentRun.create({
      data: { ...binding, inboundEventId: inbound.id },
      select: { id: true },
    })
    return { status: 'ACCEPTED', runId: run.id } as const
  }, { isolationLevel: 'ReadCommitted' })
}
