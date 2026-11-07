import { reviewTarget } from '../contracts/action-review.js'
import { resolveSimulatedPlatform } from '../runtime/simulated-platforms.js'
import { simulationReviewPolicyVersion } from './action-review.js'
import type { Prisma, PrismaClient } from './generated/client.js'

const dailyLimit = 5
const permitDurationMs = 30_000
const batchSize = 16

type Tx = Prisma.TransactionClient
type Candidate = {
  id: string
  characterId: string
  runId: string
  accountId: string
  state: string
  version: number
  target: unknown
  expiresAt: Date
  policyVersion: number
  adapterVersion: string
  reviewDigest: string
}

async function candidate(tx: Tx, actionId: string) {
  const [row] = await tx.$queryRaw<Candidate[]>`
    SELECT a.id, a.character_id AS "characterId", a.run_id AS "runId", r.account_id AS "accountId",
      r.state, r.state_version AS version, a.target, a.expires_at AS "expiresAt",
      a.policy_version AS "policyVersion", a.adapter_version AS "adapterVersion", a.review_digest AS "reviewDigest"
    FROM public.action_proposals a
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    WHERE a.id = ${actionId}::uuid AND r.mode = 'SIMULATION'
  `
  return row
}

async function audit(tx: Tx, action: Candidate, operation: string) {
  await tx.$executeRaw`
    INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
    VALUES (${action.characterId}::uuid, 'simulation-executor', ${operation}, ${action.id}::uuid,
      gen_random_uuid(), ${action.reviewDigest})
  `
}

async function transition(tx: Tx, action: Candidate, state: 'EXECUTING' | 'RECONCILING' | 'SIMULATED' | 'BLOCKED' | 'EXPIRED') {
  const count = await tx.$executeRaw`
    UPDATE public.agent_runs SET state = ${state}::public."RunState", state_version = state_version + 1
    WHERE id = ${action.runId}::uuid AND state_version = ${action.version}
  `
  if (count !== 1) throw new Error('Simulation state changed during transaction')
  await audit(tx, action, 'simulation.' + state.toLowerCase())
}

async function lockBudgetClock(tx: Tx, characterId: string) {
  const [clock] = await tx.$queryRaw<{ windowStart: Date; localHour: number }[]>`
    SELECT * FROM public.rica_simulation_budget_clock(${characterId}::uuid)
  `
  return clock
}

export async function reserveSimulation(db: PrismaClient, actionId: string) {
  return db.$transaction(async (tx) => {
    const initial = await candidate(tx, actionId)
    if (initial?.state !== 'READY') return false

    // Control, approval, evidence revocation and permit issuance serialize on this character.
    const clock = await lockBudgetClock(tx, initial.characterId)
    const action = await candidate(tx, actionId)
    if (!clock || action?.state !== 'READY') return false

    const now = new Date()
    if (action.expiresAt <= now) {
      await transition(tx, action, 'EXPIRED')
      return false
    }
    const target = reviewTarget.parse(action.target)
    const approval = await tx.actionApproval.findUnique({
      where: { actionId },
      select: { decision: true, reviewDigest: true, expiresAt: true },
    })
    const [payload] = await tx.$queryRaw<{ allowed: boolean }[]>`
      SELECT public.rica_simulation_payload_allowed(${action.characterId}::uuid, ${action.id}::uuid) AS allowed
    `
    if (!payload?.allowed || approval?.decision !== 'APPROVE' || approval.reviewDigest !== action.reviewDigest
      || approval.expiresAt <= now || action.policyVersion !== simulationReviewPolicyVersion
      || action.adapterVersion !== resolveSimulatedPlatform(target.platform).version) {
      await transition(tx, action, 'BLOCKED')
      return false
    }

    if (clock.localHour < 8 || clock.localHour >= 22) return false
    const occupied = await tx.simulationAttempt.count({
      where: { accountId: action.accountId, status: { in: ['PERMITTED', 'UNKNOWN'] } },
    })
    if (occupied) return false
    const reserved = await tx.simulationAttempt.count({
      where: { accountId: action.accountId, windowStart: clock.windowStart, status: { not: 'NOT_SENT' } },
    })
    if (reserved >= dailyLimit) return false

    if (target.contactId) {
      const [recent] = await tx.$queryRaw<{ occupied: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM public.simulation_attempts s
          LEFT JOIN public.simulation_receipts r ON (r.character_id, r.action_id) = (s.character_id, s.action_id)
          WHERE s.account_id = ${action.accountId}::uuid AND s.contact_id = ${target.contactId}::uuid
            AND s.status <> 'NOT_SENT'
            AND COALESCE(r.created_at, s.permit_until) > statement_timestamp() - interval '1 hour'
        ) AS occupied
      `
      if (recent?.occupied) return false
    }

    // The attempt itself is the durable quota reservation. Unknown results keep their unit.
    await tx.simulationAttempt.create({
      select: { actionId: true },
      data: {
        actionId, characterId: action.characterId, accountId: action.accountId, contactId: target.contactId,
        windowStart: clock.windowStart,
        permitUntil: new Date(Math.min(now.getTime() + permitDurationMs, action.expiresAt.getTime(), approval.expiresAt.getTime())),
      },
    })
    await transition(tx, action, 'EXECUTING')
    return true
  })
}

// This adapter writes only to the local simulation ledger. It has no network or real platform client.
export async function recordSimulationReceipt(db: PrismaClient, actionId: string) {
  const [result] = await db.$queryRaw<{ recorded: boolean }[]>`
    SELECT public.rica_record_simulation_receipt(${actionId}::uuid) AS recorded
  `
  if (!result) throw new Error('Missing local simulation outcome')
  return result.recorded
}

export async function reconcileSimulation(
  db: PrismaClient, actionId: string, outcome?: 'UNKNOWN' | 'NOT_SENT',
) {
  return db.$transaction(async (tx) => {
    const initial = await candidate(tx, actionId)
    if (!initial || (initial.state !== 'EXECUTING' && initial.state !== 'RECONCILING')) return
    await lockBudgetClock(tx, initial.characterId)
    const action = await candidate(tx, actionId)
    if (!action || (action.state !== 'EXECUTING' && action.state !== 'RECONCILING')) return
    const attempt = await tx.simulationAttempt.findUniqueOrThrow({
      where: { actionId }, select: { status: true, permitUntil: true },
    })
    const receipt = await tx.simulationReceipt.findUnique({ where: { actionId }, select: { actionId: true } })

    if (receipt) {
      await tx.simulationAttempt.update({ where: { actionId }, select: { actionId: true }, data: { status: 'CONFIRMED' } })
      await transition(tx, action, 'SIMULATED')
    } else if (outcome === 'NOT_SENT') {
      await tx.simulationAttempt.update({ where: { actionId }, select: { actionId: true }, data: { status: 'NOT_SENT' } })
      await transition(tx, action, 'BLOCKED')
    } else if (attempt.status === 'PERMITTED' && (outcome === 'UNKNOWN' || attempt.permitUntil <= new Date())) {
      await tx.simulationAttempt.update({ where: { actionId }, select: { actionId: true }, data: { status: 'UNKNOWN' } })
      await transition(tx, action, 'RECONCILING')
    }
  })
}

export async function executeSimulation(db: PrismaClient, actionId: string, send = recordSimulationReceipt) {
  if (!await reserveSimulation(db, actionId)) return
  let outcome: 'UNKNOWN' | 'NOT_SENT' = 'UNKNOWN'
  try {
    if (!await send(db, actionId)) outcome = 'NOT_SENT'
  } finally {
    // Only an explicit negative result releases the reservation. A throw proves nothing.
    await reconcileSimulation(db, actionId, outcome)
  }
}

export async function runSimulationBatch(db: PrismaClient, after: string | null) {
  const recovery = await db.$queryRaw<{ id: string }[]>`
    SELECT a.action_id AS id FROM public.simulation_attempts a
    WHERE a.status IN ('PERMITTED', 'UNKNOWN') AND (
      (a.status = 'PERMITTED' AND a.permit_until <= statement_timestamp())
      OR EXISTS (SELECT 1 FROM public.simulation_receipts r WHERE r.action_id = a.action_id)
    )
    ORDER BY a.permit_until, a.action_id
    LIMIT ${batchSize}
  `
  for (const { id } of recovery) await reconcileSimulation(db, id)

  const ready = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM public.action_proposals a
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    WHERE r.mode = 'SIMULATION' AND r.state = 'READY'
      AND (${after}::uuid IS NULL OR a.id > ${after}::uuid)
    ORDER BY a.id
    LIMIT ${batchSize}
  `
  for (const { id } of ready) await executeSimulation(db, id)
  return ready.length === batchSize ? ready.at(-1)?.id ?? null : null
}
