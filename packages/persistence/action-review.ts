import type { z } from '@hono/zod-openapi'
import { reviewTarget, type ActionView, type actionDecision } from '../contracts/action-review.js'
import type { SimulationPlatformVersion } from '../contracts/simulation-platform.js'
import type { Prisma, PrismaClient } from './generated/client.js'
import { authorize, denyPermission, ManagementError, type Scope } from './management.js'

export const simulationReviewPolicyVersion = 2

const reviewStates = [
  'WAITING_APPROVAL', 'READY', 'REJECTED', 'CANCELED', 'EXPIRED', 'EXECUTING', 'RECONCILING', 'SIMULATED', 'BLOCKED',
] as const
type ReviewState = typeof reviewStates[number]
type Proposal = {
  id: string
  runId: string
  target: unknown
  version: number
  state: ReviewState
  reviewDigest: string
  policyVersion: number
  crossPlatformDuplicate: boolean
  adapterVersion: string
  proposerId: string | null
  expiresAt: Date
  expired: boolean
}

function notFound(): never {
  throw new ManagementError(404, 'NOT_FOUND', 'Proposal not found')
}

async function proposalRows(
  tx: Prisma.TransactionClient, characterId: string, actionId: string | null, limit = 25, cursor: string | null = null,
) {
  return tx.$queryRaw<Proposal[]>`
    SELECT a.id, a.run_id AS "runId", a.target, a.review_digest AS "reviewDigest",
      a.policy_version AS "policyVersion", a.adapter_version AS "adapterVersion",
      a.cross_platform_duplicate AS "crossPlatformDuplicate",
      a.proposer_id AS "proposerId", a.expires_at AS "expiresAt",
      a.expires_at <= statement_timestamp() AS expired,
      r.state, r.state_version AS version
    FROM public.action_proposals a
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    WHERE a.character_id = ${characterId}::uuid
      AND (${actionId}::uuid IS NULL OR a.id = ${actionId}::uuid)
      AND (${actionId}::uuid IS NOT NULL OR r.state = 'WAITING_APPROVAL')
      AND (${cursor}::uuid IS NULL OR (a.created_at, a.id) < (
        SELECT p.created_at, p.id FROM public.action_proposals p
        WHERE (p.character_id, p.id) = (${characterId}::uuid, ${cursor}::uuid)
      ))
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit}
  `
}

async function inspect(tx: Prisma.TransactionClient, characterId: string, proposal: Proposal, platformVersion: SimulationPlatformVersion, readContent = true) {
  const target = reviewTarget.parse(proposal.target)
  if (!reviewStates.includes(proposal.state)) notFound()
  if (proposal.state !== 'WAITING_APPROVAL' && proposal.state !== 'READY') {
    return { target, state: proposal.state, content: null }
  }
  if (proposal.expired) return { target, state: 'EXPIRED' as const, content: null }
  if (proposal.policyVersion !== simulationReviewPolicyVersion
    || proposal.adapterVersion !== platformVersion(target.platform)) {
    return { target, state: 'CANCELED' as const, content: null }
  }
  const [payload] = await tx.$queryRaw<{ content: string | null; valid: boolean }[]>`
    WITH checked AS MATERIALIZED (
      SELECT public.rica_review_payload(${characterId}::uuid, ${proposal.id}::uuid) AS content
    )
    SELECT CASE WHEN ${readContent} THEN content END AS content, content IS NOT NULL AS valid FROM checked
  `
  return payload?.valid
    ? { target, state: proposal.state, content: payload.content }
    : { target, state: 'CANCELED' as const, content: null }
}

export async function listReviewActions(
  db: PrismaClient, scope: Scope, platformVersion: SimulationPlatformVersion, actionId?: string, limit = 25, cursor?: string,
) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['REVIEWER'])
    const rows = await proposalRows(tx, scope.characterId, actionId ?? null, limit + 1, cursor ?? null)
    if (actionId && !rows.length) notFound()
    const actions: ActionView[] = []
    for (const row of rows.slice(0, limit)) {
      const { target, state, content } = await inspect(tx, scope.characterId, row, platformVersion, Boolean(actionId))
      actions.push({
        id: row.id, runId: row.runId, mode: 'SIMULATION', kind: 'REPLY',
        target, state, version: row.version, expiresAt: row.expiresAt.toISOString(),
        reviewDigest: row.reviewDigest,
        riskCodes: row.crossPlatformDuplicate
          ? ['HUMAN_REVIEW_REQUIRED', 'CROSS_PLATFORM_NEAR_DUPLICATE'] : ['HUMAN_REVIEW_REQUIRED'],
        content: actionId && row.proposerId !== scope.actor.id ? content : null,
      })
    }
    return { items: actions, nextCursor: rows.length > limit ? actions.at(-1)?.id ?? null : null }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function decideReviewAction(
  tx: Prisma.TransactionClient, scope: Scope, actionId: string, version: number,
  input: z.infer<typeof actionDecision>, platformVersion: SimulationPlatformVersion,
) {
  const [proposal] = await proposalRows(tx, scope.characterId, actionId)
  if (!proposal) notFound()
  if (proposal.proposerId === scope.actor.id) denyPermission()
  if (proposal.version !== version) throw new ManagementError(412, 'STALE_VERSION', 'Proposal version has changed')
  if (proposal.state !== 'WAITING_APPROVAL' || proposal.reviewDigest !== input.reviewDigest) {
    throw new ManagementError(409, 'STALE_REVIEW', 'Proposal no longer matches the review')
  }

  const { state } = await inspect(tx, scope.characterId, proposal, platformVersion)
  const valid = state === 'WAITING_APPROVAL'
  const nextState = valid ? (input.decision === 'APPROVE' ? 'READY' : 'REJECTED') : state
  const [transition] = await tx.$queryRaw<{ version: number | null }[]>`
    SELECT public.rica_finish_action_review(
      ${scope.characterId}::uuid, ${proposal.runId}::uuid, ${version}, ${nextState}::public."RunState"
    ) AS version
  `
  if (!transition?.version) throw new ManagementError(409, 'STALE_REVIEW', 'Proposal no longer matches the review')

  if (valid) {
    await tx.actionApproval.create({
      data: {
        characterId: scope.characterId, actionId, reviewDigest: proposal.reviewDigest,
        reviewerId: scope.actor.id, decision: input.decision, reason: input.reason, expiresAt: proposal.expiresAt,
      },
    })
  }
  return { id: actionId, status: nextState, version: transition.version }
}
