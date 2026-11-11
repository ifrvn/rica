import type { z } from '@hono/zod-openapi'
import { quarantinedOutboxEvent, runReplayView, simulationBacklogView, simulationDailyRow, simulationRunSummary, type consoleSimulationInput, type simulationDailyMetricsView, type simulationRunQuery } from '../contracts/simulation-observability.js'
import type { ResolveSimulationAdapter } from '../contracts/simulation-platform.js'
import type { Prisma, PrismaClient } from './generated/client.js'
import { authorize, ManagementError, type Scope } from './management.js'

export async function startConsoleSimulation(
  tx: Prisma.TransactionClient, scope: Scope, input: z.infer<typeof consoleSimulationInput>, resolveAdapter: ResolveSimulationAdapter,
) {
  const account = await tx.platformAccount.findFirst({
    where: { characterId: scope.characterId, id: input.accountId, platform: { in: ['mock-a', 'mock-b'] } },
    select: { platform: true },
  })
  if (!account) throw new ManagementError(404, 'NOT_FOUND', 'Simulation account not found')
  const adapter = resolveAdapter(account.platform)
  if (!adapter) throw new ManagementError(409, 'SIMULATION_ADAPTER_UNAVAILABLE', 'Simulation adapter is unavailable')
  const [row] = await tx.$queryRaw<{ id: string | null }[]>`
    SELECT public.rica_start_console_simulation(${scope.characterId}::uuid, ${input.accountId}::uuid,
      ${adapter.adapterId}, ${adapter.adapterVersion}, ${input.message}) AS id
  `
  if (!row?.id) throw new ManagementError(409, 'SIMULATION_BINDING_INACTIVE', 'Simulation binding is inactive')
  return { id: row.id, status: 'QUEUED' }
}

type RunListQuery = Omit<z.infer<typeof simulationRunQuery>, 'limit'> & { limit: number }

export async function listSimulationRuns(db: PrismaClient, scope: Scope, { limit, cursor, state, identityId, accountId, from, through }: RunListQuery) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const rows = await tx.$queryRaw<(Omit<z.infer<typeof simulationRunSummary>, 'createdAt'> & { createdAt: Date })[]>`
      SELECT * FROM public.rica_console_simulation_runs(
        ${scope.characterId}::uuid, ${cursor ?? null}::uuid, ${limit + 1}::int,
        ${state ?? null}::public."RunState", ${identityId ?? null}::uuid, ${accountId ?? null}::uuid,
        ${from ?? null}::date, ${through ?? null}::date
      )
    `
    const items = rows.slice(0, limit).map((row) => simulationRunSummary.parse({ ...row, createdAt: row.createdAt.toISOString() }))
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function replaySimulationRun(db: PrismaClient, scope: Scope, runId: string) {
  return db.$transaction(async (tx) => {
    const roles = await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const canReadTranscript = roles.some(({ role }) => role === 'ADMIN')
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_replay_run_with_time(${scope.characterId}::uuid, ${runId}::uuid) ||
        jsonb_build_object('transcript', CASE WHEN ${canReadTranscript}
          THEN public.rica_console_simulation_transcript(${scope.characterId}::uuid, ${runId}::uuid) END) AS view
    `
    if (!row?.view) throw new ManagementError(404, 'NOT_FOUND', 'Simulation run not found')
    return runReplayView.parse(row.view)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readSimulationDailyMetrics(db: PrismaClient, scope: Scope, { from, through }: { from: string; through: string }) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ days: unknown; today: string }[]>`
      SELECT public.rica_simulation_daily_metrics(${scope.characterId}::uuid, ${from}::date, ${through}::date) AS days,
        (statement_timestamp() AT TIME ZONE 'UTC')::date::text AS today
    `
    const days = simulationDailyRow.array().parse(row.days)
    const alerts: z.infer<typeof simulationDailyMetricsView>['alerts'] = []
    if (days.some(({ flaggedReceipts }) => flaggedReceipts > 0)) alerts.push('FLAGGED_RECEIPTS')
    if (days.some(({ receiptsWithoutApproval }) => receiptsWithoutApproval > 0)) alerts.push('UNAPPROVED_RECEIPTS')
    if (days.some(({ budgetDenials }) => budgetDenials > 0)) alerts.push('MODEL_BUDGET_EXHAUSTED')

    const complete = days.filter(({ utcDay }) => utcDay < row.today)
    if (complete.length >= 14) {
      const sum = (window: typeof days) => window.reduce((totals, day) => ({
        receipts: totals.receipts + day.receipts, proposals: totals.proposals + day.proposals,
        reviewed: totals.reviewed + day.approvals + day.rejections,
      }), { receipts: 0, proposals: 0, reviewed: 0 })
      const earlier = sum(complete.slice(-14, -7))
      const recent = sum(complete.slice(-7))
      if (recent.receipts >= earlier.receipts * 2 + 7) alerts.push('RECEIPT_VOLUME_DRIFT')
      if (earlier.proposals > 0 && recent.proposals > 0
        && Math.abs(recent.reviewed / recent.proposals - earlier.reviewed / earlier.proposals) >= 0.2) {
        alerts.push('REVIEW_RATE_DRIFT')
      }
    }
    return { days, alerts }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readQuarantinedOutbox(db: PrismaClient, scope: Scope, after?: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ events: unknown }[]>`
      SELECT public.rica_quarantined_outbox(${scope.characterId}::uuid, ${after ?? null}::uuid) AS events
    `
    const events = quarantinedOutboxEvent.array().parse(row.events)
    const items = events.slice(0, 25)
    return { items, nextCursor: events.length > items.length ? items.at(-1)!.id : null }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function retryQuarantinedOutbox(tx: Prisma.TransactionClient, scope: Scope, eventId: string, expected: number) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT public.rica_retry_outbox(${scope.characterId}::uuid, ${eventId}::uuid, ${expected}::int) AS status
  `
  if (row.status === 'MISSING') throw new ManagementError(404, 'NOT_FOUND', 'Outbox event not found')
  if (row.status === 'STALE') throw new ManagementError(412, 'STALE_VERSION', 'Outbox generation has changed')
  if (row.status !== 'UPDATED') throw new ManagementError(409, 'OUTBOX_NOT_QUARANTINED', 'Outbox event is not quarantined')
  return { id: eventId, version: expected + 1 }
}

export async function readSimulationBacklog(db: PrismaClient, scope: Scope) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_simulation_backlog(${scope.characterId}::uuid) AS view
    `
    return simulationBacklogView.parse(row?.view)
  }, { isolationLevel: 'RepeatableRead' })
}
