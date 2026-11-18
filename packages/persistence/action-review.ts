import { randomUUID } from 'node:crypto'
import type { z } from '@hono/zod-openapi'
import { reviewTarget, type ActionView, type actionDecision } from '@ricajs/contracts/action-review'
import { simulationFollowUp } from '@ricajs/contracts/simulation-follow-up'
import { matchesSimulationAdapter, type ResolveSimulationAdapter } from '@ricajs/contracts/simulation-platform'
import type { Prisma, PrismaClient } from './generated/client.js'
import { authorize, denyPermission, ManagementError, type Scope } from './management.js'
import { autoReviewerId, type ReviewPublicReply } from '@ricajs/contracts/auto-review'
import { lockAutoReview, readAutoReviewSettings } from './auto-review.js'

export const simulationReviewPolicyVersion = 4

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
  adapterId: string
  adapterVersion: string
  adapterContractVersion: number
  proposerId: string | null
  expiresAt: Date
  expired: boolean
  followUp: unknown
  reviewerId: string | null
}

function notFound(): never {
  throw new ManagementError(404, 'NOT_FOUND', 'Proposal not found')
}

async function proposalRows(
  tx: Prisma.TransactionClient, characterId: string, actionId: string | null, limit = 25, cursor: string | null = null,
) {
  return tx.$queryRaw<Proposal[]>`
    SELECT a.id, a.run_id AS "runId", a.target, a.review_digest AS "reviewDigest", a.follow_up AS "followUp",
      a.policy_version AS "policyVersion", a.adapter_id AS "adapterId", a.adapter_version AS "adapterVersion",
      a.adapter_contract_version AS "adapterContractVersion",
      a.cross_platform_duplicate AS "crossPlatformDuplicate",
      a.proposer_id AS "proposerId", a.expires_at AS "expiresAt",
      a.expires_at <= statement_timestamp() AS expired,
      r.state, r.state_version AS version, approval.reviewer_id AS "reviewerId"
    FROM public.action_proposals a
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    LEFT JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (a.character_id, a.id)
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

async function inspect(tx: Prisma.TransactionClient, characterId: string, proposal: Proposal, resolveAdapter: ResolveSimulationAdapter, readContent = true) {
  const target = reviewTarget.parse(proposal.target)
  if (!reviewStates.includes(proposal.state)) notFound()
  if (proposal.state !== 'WAITING_APPROVAL' && proposal.state !== 'READY') {
    return { target, state: proposal.state, content: null }
  }
  if (proposal.expired) return { target, state: 'EXPIRED' as const, content: null }
  if (proposal.policyVersion !== simulationReviewPolicyVersion
    || !matchesSimulationAdapter(proposal, resolveAdapter(target.platform))) {
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
  db: PrismaClient, scope: Scope, resolveAdapter: ResolveSimulationAdapter, actionId?: string, limit = 25, cursor?: string,
) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const rows = await proposalRows(tx, scope.characterId, actionId ?? null, limit + 1, cursor ?? null)
    if (actionId && !rows.length) notFound()
    const actions: ActionView[] = []
    for (const row of rows.slice(0, limit)) {
      const { target, state, content } = await inspect(tx, scope.characterId, row, resolveAdapter, Boolean(actionId))
      actions.push({
        id: row.id, runId: row.runId, mode: 'SIMULATION', kind: 'REPLY',
        target, state, version: row.version, expiresAt: row.expiresAt.toISOString(),
        reviewDigest: row.reviewDigest,
        autoApproved: row.reviewerId === autoReviewerId,
        riskCodes: [
          ...(row.reviewerId === autoReviewerId ? [] : ['HUMAN_REVIEW_REQUIRED']),
          ...(row.crossPlatformDuplicate ? ['CROSS_PLATFORM_NEAR_DUPLICATE'] : []),
        ],
        content: actionId && row.proposerId !== scope.actor.id ? content : null,
        followUp: actionId && content && row.proposerId !== scope.actor.id
          ? simulationFollowUp.safeParse(row.followUp).data ?? null : null,
      })
    }
    return { items: actions, nextCursor: rows.length > limit ? actions.at(-1)?.id ?? null : null }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function autoReviewSimulation(
  db: PrismaClient, characterId: string, actionId: string, discussion: string,
  resolveAdapter: ResolveSimulationAdapter, review: ReviewPublicReply,
) {
  const input = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE rica_admin_api`
    const settings = await readAutoReviewSettings(tx, characterId)
    if (!settings?.enabled) return
    const [proposal] = await proposalRows(tx, characterId, actionId)
    if (!proposal || proposal.state !== 'WAITING_APPROVAL' || proposal.crossPlatformDuplicate || proposal.followUp) return
    const { target, content } = await inspect(tx, characterId, proposal, resolveAdapter)
    if (target.audience === 'PUBLIC' && content) return { settings, proposal, target, content }
  }, { isolationLevel: 'RepeatableRead' })
  if (!input) return
  const { settings, proposal, target, content } = input
  const model = await review(settings, { platform: target.platform, draft: content, discussion },
    { characterId, identityId: target.identityId, platform: target.platform })
  if (!model) return

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE rica_admin_api`
    if (!await lockAutoReview(tx, characterId, settings.version)) return
    const [current] = await proposalRows(tx, characterId, actionId)
    if (!current || current.state !== 'WAITING_APPROVAL' || current.version !== proposal.version
      || current.reviewDigest !== proposal.reviewDigest) return
    if ((await inspect(tx, characterId, current, resolveAdapter)).content !== content) return
    const result = await finishReview(tx, characterId, current, autoReviewerId, 'APPROVE',
      `Auto-review v${settings.version} · ${model}`, resolveAdapter)
    if (result.status === 'READY') await tx.managementAudit.create({ data: {
      characterId, actorId: autoReviewerId, operation: 'action.auto-approve', targetId: actionId,
      digest: current.reviewDigest, requestId: randomUUID(),
    } })
  })
}

export async function decideReviewAction(
  tx: Prisma.TransactionClient, scope: Scope, actionId: string, version: number,
  input: z.infer<typeof actionDecision>, resolveAdapter: ResolveSimulationAdapter,
) {
  const [proposal] = await proposalRows(tx, scope.characterId, actionId)
  if (!proposal) notFound()
  if (proposal.proposerId === scope.actor.id) denyPermission()
  if (proposal.version !== version) throw new ManagementError(412, 'STALE_VERSION', 'Proposal version has changed')
  if (proposal.state !== 'WAITING_APPROVAL' || proposal.reviewDigest !== input.reviewDigest) {
    throw new ManagementError(409, 'STALE_REVIEW', 'Proposal no longer matches the review')
  }
  return finishReview(tx, scope.characterId, proposal, scope.actor.id, input.decision, input.reason, resolveAdapter)
}

async function finishReview(
  tx: Prisma.TransactionClient, characterId: string, proposal: Proposal, reviewerId: string,
  decision: 'APPROVE' | 'REJECT', reason: string, resolveAdapter: ResolveSimulationAdapter,
) {
  const { state } = await inspect(tx, characterId, proposal, resolveAdapter, false)
  const valid = state === 'WAITING_APPROVAL'
  const nextState = valid ? (decision === 'APPROVE' ? 'READY' : 'REJECTED') : state
  const [transition] = await tx.$queryRaw<{ version: number | null }[]>`
    SELECT public.rica_finish_action_review(
      ${characterId}::uuid, ${proposal.runId}::uuid, ${proposal.version}, ${nextState}::public."RunState"
    ) AS version
  `
  if (!transition?.version) throw new ManagementError(409, 'STALE_REVIEW', 'Proposal no longer matches the review')

  if (valid) {
    await tx.actionApproval.create({
      data: {
        characterId, actionId: proposal.id, reviewDigest: proposal.reviewDigest,
        reviewerId, decision, reason, expiresAt: proposal.expiresAt,
      },
    })
  }
  return { id: proposal.id, status: nextState, version: transition.version }
}
