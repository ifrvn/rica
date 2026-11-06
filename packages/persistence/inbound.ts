import type { InboundKind, PrismaClient } from './generated/client.js'
import { lockSimulatedBinding, runQueuedEvent } from './run-context.js'

type SimulatedEvent = Readonly<{
  accountId: string
  sourceKey: string
  kind: InboundKind
  occurredAt: Date
}>

// Internal entry point for trusted simulation fixtures. Public ingress must authenticate its source.
export async function ingestSimulatedEvent(db: PrismaClient, event: SimulatedEvent) {
  const { accountId, sourceKey, kind, occurredAt } = event
  if (sourceKey.trim().length === 0 || sourceKey.length > 256 || !Number.isFinite(occurredAt.getTime())) {
    throw new Error('Invalid simulated event')
  }

  return db.$transaction(async (tx) => {
    const binding = await lockSimulatedBinding(tx, accountId)
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
    await tx.outboxEvent.create({ data: { type: runQueuedEvent, runId: run.id } })
    return { status: 'ACCEPTED', runId: run.id } as const
  }, { isolationLevel: 'ReadCommitted' })
}
