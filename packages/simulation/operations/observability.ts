import { simulationPlatformId } from '@ricajs/contracts/management'
import type { z } from '@hono/zod-openapi'
import { quarantinedOutboxEvent, runReplayView, simulationBacklogView, simulationChatSummary, simulationChatView,
  simulationDailyRow, simulationRunSummary, type consoleSimulationInput, type simulationDailyMetricsView,
  type simulationRunQuery, type simulationTermUpdate } from '../contracts/observability.js'
import { autoReviewerId } from '@ricajs/contracts/auto-review'
import type { ResolveSimulationAdapter } from '../contracts/platforms.js'
import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import { authorize, ManagementError, type Scope } from '@ricajs/persistence/management'

export async function startConsoleSimulation(
  tx: Prisma.TransactionClient, scope: Scope, input: z.infer<typeof consoleSimulationInput>, resolveAdapter: ResolveSimulationAdapter,
) {
  const account = await tx.platformAccount.findFirst({
    where: { characterId: scope.characterId, id: input.accountId, platform: { in: simulationPlatformId.options } },
    select: { platform: true },
  })
  if (!account) throw new ManagementError(404, 'NOT_FOUND', 'Simulation account not found')
  const adapter = resolveAdapter(account.platform)
  if (!adapter) throw new ManagementError(409, 'SIMULATION_ADAPTER_UNAVAILABLE', 'Simulation adapter is unavailable')
  if ('chatId' in input && !adapter.isIm) {
    throw new ManagementError(422, 'SIMULATION_ACCOUNT_NOT_IM', 'This platform account does not support chat')
  }
  const [row] = 'chatId' in input ? await tx.$queryRaw<{ id: string | null }[]>`
    SELECT public.rica_start_console_chat_message(${scope.characterId}::uuid, ${input.accountId}::uuid,
      ${input.chatId}::uuid, ${adapter.adapterId}, ${adapter.adapterVersion}, ${input.speaker}, ${input.message}) AS id
  ` : await tx.$queryRaw<{ id: string | null }[]>`
    SELECT public.rica_start_console_simulation(${scope.characterId}::uuid, ${input.accountId}::uuid,
      ${adapter.adapterId}, ${adapter.adapterVersion}, ${input.message}) AS id
  `
  if (!row?.id) throw new ManagementError(409, 'SIMULATION_BINDING_INACTIVE', 'Simulation binding is inactive')
  return { id: row.id, status: 'QUEUED' }
}

export async function listSimulationChats(db: PrismaClient, scope: Scope, { cursor, limit }: { cursor?: string; limit: number }) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const rows = await tx.$queryRaw<{ id: string; createdAt: Date }[]>`
      SELECT * FROM public.rica_console_simulation_chats(${scope.characterId}::uuid, ${cursor ?? null}::uuid, ${limit + 1}::int)
    `
    const items = rows.slice(0, limit).map((row) => simulationChatSummary.parse({ ...row, createdAt: row.createdAt.toISOString() }))
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
  })
}

export async function readSimulationChat(db: PrismaClient, scope: Scope, chatId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const [row] = await tx.$queryRaw<{ chat: unknown }[]>`
      SELECT public.rica_console_simulation_chat(${scope.characterId}::uuid, ${chatId}::uuid) || jsonb_build_object('glossary',
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'term',t.term,'tone',t.tone,'version',t.version,
          'meaning',CASE WHEN source.available THEN t.meaning END,
          'status',CASE WHEN t.status = 'DISABLED' OR source.available THEN t.status ELSE 'UNAVAILABLE' END,
          'sourceRuns',CASE WHEN source.available THEN to_jsonb(t.source_runs) ELSE '[]'::jsonb END)
          ORDER BY t.updated_at DESC,t.id DESC) FROM public.simulation_chat_terms t
          CROSS JOIN LATERAL (SELECT public.rica_chat_term_available(t.character_id,t.chat_id,t.source_runs,NULL) AS available) source
          WHERE (t.character_id,t.chat_id) = (${scope.characterId}::uuid,${chatId}::uuid)),'[]'::jsonb)) AS chat
    `
    if (!row.chat) throw new ManagementError(404, 'NOT_FOUND', 'Simulation chat not found')
    return simulationChatView.parse(row.chat)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function updateSimulationTerm(tx: Prisma.TransactionClient, scope: Scope, chatId: string, id: string,
  expected: number, input: z.infer<typeof simulationTermUpdate>,
) {
  const where = { id, chatId, characterId: scope.characterId }
  const status = input.operation === 'CORRECT' ? 'CORRECTED' : 'DISABLED'
  const { count } = await tx.simulationChatTerm.updateMany({
    where: { ...where, version: expected }, data: { status, updatedAt: new Date(), version: { increment: 1 },
      ...(input.operation === 'CORRECT' ? { meaning: input.meaning, tone: input.tone } : {}) },
  })
  if (!count) {
    if (!await tx.simulationChatTerm.findFirst({ where, select: { id: true } })) {
      throw new ManagementError(404, 'NOT_FOUND', 'Simulation glossary term not found')
    }
    throw new ManagementError(412, 'STALE_VERSION', 'Simulation glossary term changed')
  }
  return { id, status, version: expected + 1 }
}

type RunListQuery = Omit<z.infer<typeof simulationRunQuery>, 'limit'> & { limit: number }

export async function listSimulationRuns(db: PrismaClient, scope: Scope, { limit, cursor, state, identityId, accountId, from, through }: RunListQuery) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
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
    await authorize(tx, scope)
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_replay_run_with_time(${scope.characterId}::uuid, ${runId}::uuid) ||
        jsonb_build_object(
          'chatId', public.rica_console_chat_for_run(${scope.characterId}::uuid, ${runId}::uuid),
          'chatStop', chat.stop,
          'autoReviewPending', COALESCE(a.auto_review_until > statement_timestamp()
            AND a.auto_review_handoff IS NULL AND approval.action_id IS NULL
            AND r.state = 'WAITING_APPROVAL' AND i.auto_review_enabled AND chat.stop IS NULL, false),
          'manualReviewAllowed', COALESCE(NOT a.is_im OR i.im_manual_review_enabled, true),
          'autoApproved', COALESCE(approval.reviewer_id = ${autoReviewerId}, false),
          'autoReviewHandoff', CASE WHEN r.state = 'WAITING_APPROVAL' AND a.auto_review_handoff IS NOT NULL
            AND a.proposer_id IS DISTINCT FROM ${scope.actor.id}
            AND public.rica_review_payload(a.character_id,a.id) IS NOT NULL THEN a.auto_review_handoff END,
          'executionWait', CASE WHEN r.state = 'READY' AND chat.stop IS NULL THEN public.rica_simulation_execution_wait(a.character_id,a.id) END,
          'transcript', public.rica_console_simulation_transcript(${scope.characterId}::uuid, ${runId}::uuid),
          'systemPrompts', public.rica_run_system_prompts(${scope.characterId}::uuid, ${runId}::uuid),
          'participationDecision', (SELECT participation_decision FROM public.agent_runs
            WHERE (character_id, id) = (${scope.characterId}::uuid, ${runId}::uuid)),
          'modelCalls', public.rica_run_model_calls(${scope.characterId}::uuid, ${runId}::uuid),
          'glossary', public.rica_run_glossary(${scope.characterId}::uuid, ${runId}::uuid)
        ) AS view
      FROM (SELECT 1) base
      LEFT JOIN public.action_proposals a ON (a.character_id, a.run_id) = (${scope.characterId}::uuid, ${runId}::uuid)
      LEFT JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (a.character_id, a.id)
      LEFT JOIN public.agent_runs r ON (r.character_id,r.id) = (a.character_id,a.run_id)
      LEFT JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
      CROSS JOIN LATERAL (SELECT CASE WHEN r.state IN ('WAITING_APPROVAL','READY') THEN public.rica_chat_reply_stop(r.id) END AS stop OFFSET 0) chat
    `
    if (!row?.view) throw new ManagementError(404, 'NOT_FOUND', 'Simulation run not found')
    const view = runReplayView.parse(row.view)
    if (view.snapshots.some(({ evidence }) => evidence.some(({ available }) => !available))) {
      return { ...view, modelCalls: view.modelCalls.map((call) => ({ ...call, output: null })) }
    }
    return view
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readSimulationDailyMetrics(db: PrismaClient, scope: Scope, { from, through }: { from: string; through: string }) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
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
    await authorize(tx, scope)
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
    await authorize(tx, scope)
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_simulation_backlog(${scope.characterId}::uuid) AS view
    `
    return simulationBacklogView.parse(row?.view)
  }, { isolationLevel: 'RepeatableRead' })
}
