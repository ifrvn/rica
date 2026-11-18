import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import { dailyScheduleSlot, lockEventContext, lockSimulatedBinding, runQueuedEvent } from '@ricajs/persistence/run-context'

const batchSize = 16
export const scheduleSourcePrefix = 'schedule:'

export async function dispatchSimulationSchedule(db: PrismaClient, scheduleId: string, now: Date) {
  return db.$transaction(async (tx) => {
    const before = await tx.simulationSchedule.findUnique({
      where: { id: scheduleId }, select: { accountId: true },
    })
    if (!before) return
    // Management takes the character lock before editing a schedule.
    const binding = await lockSimulatedBinding(tx, before.accountId)
    if (!binding) return
    const [due] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM public.simulation_schedules
      WHERE id = ${scheduleId}::uuid AND enabled AND next_at <= ${now}
      FOR UPDATE
    `
    if (!due) return

    const schedule = await tx.simulationSchedule.findUniqueOrThrow({ where: { id: due.id } })
    if (!schedule.nextAt) return
    const context = await lockEventContext(tx, binding, schedule)
    if (!context) return
    const { timezone, simulationQuietEnabled, simulationQuietFrom, simulationQuietUntil, simulationCatchUpMinutes } = await tx.character.findUniqueOrThrow({
      where: { id: binding.characterId }, select: { timezone: true, simulationQuietEnabled: true,
        simulationQuietFrom: true, simulationQuietUntil: true, simulationCatchUpMinutes: true },
    })
    const slot = schedule.kind === 'DAILY'
      ? await dailyScheduleSlot(tx, schedule.zone, schedule.localTime!, now, true)
      : schedule.dueAt!
    const [window] = simulationQuietEnabled ? await tx.$queryRaw<{ openAt: Date; slotOpen: boolean }[]>`
      SELECT public.rica_simulation_next_open(
        ${now}::timestamptz, ${timezone}, ${simulationQuietFrom}::time, ${simulationQuietUntil}::time) AS "openAt",
        public.rica_simulation_next_open(${slot}::timestamptz, ${timezone},
          ${simulationQuietFrom}::time, ${simulationQuietUntil}::time) = ${slot}::timestamptz AS "slotOpen"
    ` : []
    const deferredUntil = window && window.openAt > now ? window.openAt : null
    const nextAt = schedule.kind === 'DAILY'
      ? await dailyScheduleSlot(tx, schedule.zone, schedule.localTime!, now) : deferredUntil
    await tx.simulationSchedule.update({ where: { id: schedule.id }, data: { nextAt } })

    if (deferredUntil || (schedule.kind === 'DAILY'
      && (slot < schedule.nextAt || now.getTime() - slot.getTime() > simulationCatchUpMinutes * 60_000
        || window?.slotOpen === false))) return

    const key = { scheduleId: schedule.id, scheduledAt: slot }
    if (await tx.scheduleOccurrence.findUnique({ where: { scheduleId_scheduledAt: key }, select: { runId: true } })) return

    // A timer is an internal cognition trigger, with no fabricated inbound message or reply target.
    const event = await tx.inboundEvent.create({
      data: {
        characterId: binding.characterId, identityId: binding.identityId, accountId: binding.accountId,
        conversationId: context.conversationId, contactId: context.contactId,
        sourceKey: scheduleSourcePrefix + schedule.id + ':' + slot.toISOString(), kind: 'POST', occurredAt: slot,
      },
      select: { id: true },
    })
    const run = await tx.agentRun.create({
      data: { ...binding, inboundEventId: event.id }, select: { id: true },
    })
    await tx.scheduleOccurrence.create({
      data: { ...key, characterId: binding.characterId, scheduleVersion: schedule.version, runId: run.id },
    })
    await tx.outboxEvent.create({ data: { type: runQueuedEvent, runId: run.id } })
  }, { isolationLevel: 'ReadCommitted' })
}

export async function scanSimulationSchedules(db: PrismaClient, after: string | null, now = new Date()) {
  const due = await db.simulationSchedule.findMany({
    where: { enabled: true, nextAt: { lte: now }, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' }, take: batchSize, select: { id: true },
  })
  for (const { id } of due) await dispatchSimulationSchedule(db, id, now)
  return due.length === batchSize ? due.at(-1)?.id ?? null : null
}
