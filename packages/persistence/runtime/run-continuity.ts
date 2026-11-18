import type { Continuity, IdentityState, RunContinuity, RunTime, SubjectiveBelief } from '@ricajs/contracts/run-continuity'
import type { Prisma } from '../generated/client.js'

export async function loadRunContinuity(tx: Prisma.TransactionClient, runId: string): Promise<RunContinuity | null> {
  const [row] = await tx.$queryRaw<{
    context: Continuity | null; identityState: IdentityState | null; beliefs: readonly SubjectiveBelief[]
  }[]>`
    SELECT public.rica_run_continuity(${runId}::uuid) AS context,
      public.rica_run_identity_state(${runId}::uuid) AS "identityState",
      public.rica_run_beliefs(${runId}::uuid) AS beliefs
  `
  if (!row?.context || !row.identityState) return null
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
  return { ...context, time, identityState: row.identityState, beliefs: row.beliefs }
}
