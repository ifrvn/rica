import type { Prisma, PrismaClient } from './generated/client.js'
import { lockEventContext, lockSimulatedBinding, runQueuedEvent } from './run-context.js'

const catchUpMs = 2 * 60 * 60 * 1000
const batchSize = 16
export const scheduleSourcePrefix = 'schedule:'

export async function dailyScheduleSlot(
  tx: Prisma.TransactionClient, zone: string, wallTime: string, reference: Date, backwards = false,
) {
  const [result] = await tx.$queryRaw<{ slot: Date | null }[]>`
    SELECT public.rica_daily_schedule_slot(${zone}, ${wallTime}::time, ${reference}, ${backwards}) AS slot
  `
  if (!result?.slot) throw new Error('Daily schedule slot is unavailable')
  return result.slot
}

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
    const { timezone } = await tx.character.findUniqueOrThrow({
      where: { id: binding.characterId }, select: { timezone: true },
    })
    const slot = schedule.kind === 'DAILY'
      ? await dailyScheduleSlot(tx, schedule.zone, schedule.localTime!, now, true)
      : schedule.dueAt!
    const [window] = await tx.$queryRaw<{ currentHour: number; slotHour: number }[]>`
      SELECT extract(hour FROM ${now}::timestamptz AT TIME ZONE ${timezone})::int AS "currentHour",
        extract(hour FROM ${slot}::timestamptz AT TIME ZONE ${timezone})::int AS "slotHour"
    `
    const open = window.currentHour >= 8 && window.currentHour < 22
    let nextAt: Date | null
    if (schedule.kind === 'DAILY') nextAt = await dailyScheduleSlot(tx, schedule.zone, schedule.localTime!, now)
    else nextAt = open ? null : await dailyScheduleSlot(tx, timezone, '08:00', now)
    await tx.simulationSchedule.update({ where: { id: schedule.id }, data: { nextAt } })

    if (!open || (schedule.kind === 'DAILY'
      && (slot < schedule.nextAt || now.getTime() - slot.getTime() > catchUpMs
        || window.slotHour < 8 || window.slotHour >= 22))) return

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
