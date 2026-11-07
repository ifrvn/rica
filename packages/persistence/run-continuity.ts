import type { Prisma } from './generated/client.js'

export type RunTime = Readonly<{
  occurredAt: string
  now: string
  timezone: string
  localDate: string
  eventLocalDate: string
  localHour: number
}>

type Continuity = {
  runId: string
  characterId: string
  identityId: string
  accountId: string
  triggerId: string
  bindingVersion: number
  mode: 'SIMULATION'
  platform: string
  instanceKey: string
  conversationId: string | null
  contactId: string | null
  occurredAt: string
  now: string
  timezone: string
  recent: readonly { kind: string; occurredAt: string }[]
  nextCommitmentAt: string | null
  nextScheduleAt: string | null
  relationship: { confirmedInteractions: number; lastConfirmedAt: string | null } | null
  goals: readonly { id: string; version: number; title: string; budget: number; priority: number; dueAt: string; nextStep: string | null }[]
  self: {
    coreVersion: number
    name: string | null
    fictionalBackground: string | null
    facts: readonly { id: string; revision: number; content: string }[]
  }
}

export async function loadRunContinuity(tx: Prisma.TransactionClient, runId: string) {
  const [row] = await tx.$queryRaw<{ context: Continuity | null }[]>`
    SELECT public.rica_run_continuity(${runId}::uuid) AS context
  `
  if (!row?.context) return null
  const { occurredAt, now, timezone, ...context } = row.context
  let formatter: Intl.DateTimeFormat
  let zone = timezone
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' } as const
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: zone })
  } catch {
    zone = 'UTC'
    formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: zone })
  }
  const local = (instant: string) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]))
    return { date: [parts.year, parts.month, parts.day].join('-'), hour: Number(parts.hour) }
  }
  const current = local(now)
  const time: RunTime = { occurredAt, now, timezone: zone, localDate: current.date, eventLocalDate: local(occurredAt).date, localHour: current.hour }
  return { ...context, time }
}

export type RunContinuity = NonNullable<Awaited<ReturnType<typeof loadRunContinuity>>>
