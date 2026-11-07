import { maxSimulatedTextLength } from '../runtime/model-provider.js'
import { registerPlugins } from '../runtime/plugin-registry.js'
import { resolveSimulatedPlatform, type NormalizedPlatformEvent } from '../runtime/simulated-platforms.js'
import type { InboundKind, PrismaClient } from './generated/client.js'
import { lockEventContext, lockSimulatedBinding, runQueuedEvent } from './run-context.js'

type SimulatedEvent = Readonly<{
  accountId: string
  conversationId?: string
  contactId?: string
  sourceKey: string
  messageText?: string
  kind: InboundKind
  occurredAt: Date
}>

// Internal entry point for trusted simulation fixtures. Public ingress must authenticate its source.
export function ingestSimulatedEvent(db: PrismaClient, event: SimulatedEvent) {
  return storeSimulatedEvent(db, event)
}

type PlatformSource = Readonly<{ accountId: string; platform: string; instanceKey: string }>

// Only trusted simulation ingress calls this entry. Platform and instance come from the host.
export function createSimulatedPlatformIngress(db: PrismaClient, enabled = ['mock-a', 'mock-b']) {
  const resolveAdapter = registerPlugins('enabled platform', enabled.map(resolveSimulatedPlatform))

  return (source: PlatformSource, payload: unknown) => {
    const adapter = resolveAdapter(source.platform)
    const normalized = adapter.implementation.normalize(payload)
    return storeSimulatedEvent(db, {
      accountId: source.accountId, sourceKey: normalized.sourceKey, messageText: normalized.messageText,
      kind: normalized.kind, occurredAt: normalized.occurredAt,
    }, { platform: adapter.id, adapterVersion: adapter.version, instanceKey: source.instanceKey, normalized })
  }
}

type RemoteScope = {
  platform: string
  adapterVersion: string
  instanceKey: string
  normalized: NormalizedPlatformEvent
}

async function storeSimulatedEvent(db: PrismaClient, event: SimulatedEvent, remote?: RemoteScope) {
  const { accountId, sourceKey, kind, occurredAt, messageText } = event
  if (messageText !== undefined && ((!remote && !event.conversationId) || !messageText.trim()
    || messageText.length > maxSimulatedTextLength || messageText.includes('\0'))) {
    throw new Error('Invalid simulated message')
  }
  if (sourceKey.trim().length === 0 || sourceKey.length > 256 || !Number.isFinite(occurredAt.getTime())) {
    throw new Error('Invalid simulated event')
  }

  return db.$transaction(async (tx) => {
    const binding = await lockSimulatedBinding(tx, accountId)
    if (!binding) return { status: 'ACCOUNT_UNAVAILABLE' } as const
    let target: { conversationId?: string | null; contactId?: string | null } = event
    if (remote) {
      const { remoteAccountId, remoteConversationKey, remoteContactKey } = remote.normalized
      const [resolved] = await tx.$queryRaw<{ conversationId: string | null; contactId: string | null }[]>`
        SELECT * FROM public.rica_resolve_simulated_event_scope(
          ${accountId}::uuid, ${remote.platform}, ${remote.instanceKey}, ${remoteAccountId},
          ${remoteConversationKey}, ${remoteContactKey ?? null}
        )
      `
      if (!resolved) return { status: 'ACCOUNT_UNAVAILABLE' } as const
      if (!resolved.conversationId || (remoteContactKey && !resolved.contactId)) {
        return { status: 'CONVERSATION_UNAVAILABLE' } as const
      }
      target = resolved
    }
    const context = await lockEventContext(tx, binding, target)
    if (!context) return { status: 'CONVERSATION_UNAVAILABLE' } as const

    const { count } = await tx.inboundEvent.createMany({
      data: {
        characterId: binding.characterId,
        identityId: binding.identityId,
        accountId: binding.accountId,
        conversationId: context.conversationId,
        contactId: context.contactId,
        sourceKey,
        messageText,
        adapterId: remote?.platform,
        adapterVersion: remote?.adapterVersion,
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
