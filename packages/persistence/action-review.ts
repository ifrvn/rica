import { randomUUID } from 'node:crypto'
import type { z } from '@hono/zod-openapi'
import { reviewTarget, simulationReviewContext, type ActionView, type actionDecision } from '@ricajs/contracts/action-review'
import { simulationFollowUp } from '@ricajs/contracts/simulation-follow-up'
import { matchesSimulationAdapter, type ResolveSimulationAdapter } from '@ricajs/contracts/simulation-platform'
import type { Prisma, PrismaClient } from './generated/client.js'
import { authorize, denyPermission, ManagementError, type Scope } from './management.js'
import { autoReviewHandoff, autoReviewerId, missingAutoReviewHandoff, type AutoReviewHandoff, type ReviewPublicReply } from '@ricajs/contracts/auto-review'
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
  autoReviewHandoff: unknown
  autoReviewPending: boolean
  decision: 'APPROVE' | 'REJECT' | null
  reviewedAt: Date | null
  reviewReason: string | null
}

function skipSimulationReview(proposal: Proposal, target: ActionView['target']): AutoReviewHandoff | undefined {
  if (target.audience !== 'PUBLIC') return { status: 'SKIPPED', reason: '私密回复须由人工审核。' }
  if (proposal.crossPlatformDuplicate) return { status: 'SKIPPED', reason: '回复与其他平台的内容相似，请核对是否重复。' }
  if (proposal.followUp) return { status: 'SKIPPED', reason: '回复附带拟登记的计划或承诺，须由人工一并审核。' }
}

function notFound(): never {
  throw new ManagementError(404, 'NOT_FOUND', 'Proposal not found')
}

async function proposalRows(
  tx: Prisma.TransactionClient, characterId: string, actionId: string | null, limit = 25, cursor: string | null = null,
  status = 'WAITING',
) {
  return tx.$queryRaw<Proposal[]>`
    SELECT a.id, a.run_id AS "runId", a.target, a.review_digest AS "reviewDigest", a.follow_up AS "followUp",
      a.auto_review_handoff AS "autoReviewHandoff",
      a.policy_version AS "policyVersion", a.adapter_id AS "adapterId", a.adapter_version AS "adapterVersion",
      a.adapter_contract_version AS "adapterContractVersion",
      a.cross_platform_duplicate AS "crossPlatformDuplicate",
      a.proposer_id AS "proposerId", a.expires_at AS "expiresAt",
      a.expires_at <= statement_timestamp() AS expired,
      r.state, r.state_version AS version, approval.reviewer_id AS "reviewerId",
      approval.decision, approval.created_at AS "reviewedAt", approval.reason AS "reviewReason",
      COALESCE(r.state = 'WAITING_APPROVAL' AND a.auto_review_until > statement_timestamp()
        AND a.auto_review_handoff IS NULL AND approval.action_id IS NULL AND c.auto_review_enabled, false) AS "autoReviewPending"
    FROM public.action_proposals a
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    JOIN public.characters c ON c.id = a.character_id
    LEFT JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (a.character_id, a.id)
    WHERE a.character_id = ${characterId}::uuid
      AND (${actionId}::uuid IS NULL OR a.id = ${actionId}::uuid)
      AND (${actionId}::uuid IS NOT NULL OR CASE ${status}
        WHEN 'WAITING' THEN r.state = 'WAITING_APPROVAL'
        WHEN 'HISTORY' THEN approval.action_id IS NOT NULL
        ELSE approval.decision::text = ${status} END)
      AND (${cursor}::uuid IS NULL OR (coalesce(approval.created_at, a.created_at), a.id) < (
        SELECT coalesce(ar.created_at,p.created_at), p.id FROM public.action_proposals p
        LEFT JOIN public.action_approvals ar ON (ar.character_id,ar.action_id) = (p.character_id,p.id)
        WHERE (p.character_id, p.id) = (${characterId}::uuid, ${cursor}::uuid)
      ))
    ORDER BY coalesce(approval.created_at,a.created_at) DESC, a.id DESC
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
  db: PrismaClient, scope: Scope, resolveAdapter: ResolveSimulationAdapter, actionId?: string, limit = 25, cursor?: string, status?: string,
) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const rows = await proposalRows(tx, scope.characterId, actionId ?? null, limit + 1, cursor ?? null, status)
    if (actionId && !rows.length) notFound()
    const actions: ActionView[] = []
    for (const row of rows.slice(0, limit)) {
      const { target, state, content } = await inspect(tx, scope.characterId, row, resolveAdapter, Boolean(actionId))
      const canSeeDraft = Boolean(actionId && content && row.proposerId !== scope.actor.id)
      const [context] = canSeeDraft ? await tx.$queryRaw<{ context: unknown }[]>`
        SELECT public.rica_simulation_review_context(${scope.characterId}::uuid, ${row.id}::uuid) AS context
      ` : []
      actions.push({
        id: row.id, runId: row.runId, mode: 'SIMULATION', kind: 'REPLY',
        target, state, version: row.version, expiresAt: row.expiresAt.toISOString(),
        reviewDigest: row.reviewDigest,
        autoApproved: row.reviewerId === autoReviewerId,
        autoReviewPending: row.autoReviewPending && state === 'WAITING_APPROVAL',
        review: row.decision && row.reviewedAt ? { decision: row.decision, at: row.reviewedAt.toISOString(),
          reason: actionId && row.reviewerId !== autoReviewerId ? row.reviewReason || null : null } : null,
        autoReviewHandoff: canSeeDraft && state === 'WAITING_APPROVAL' && !row.autoReviewPending
          ? autoReviewHandoff.safeParse(row.autoReviewHandoff).data ?? skipSimulationReview(row, target) ?? missingAutoReviewHandoff
          : null,
        riskCodes: [
          ...(row.reviewerId === autoReviewerId ? [] : ['HUMAN_REVIEW_REQUIRED']),
          ...(row.crossPlatformDuplicate ? ['CROSS_PLATFORM_NEAR_DUPLICATE'] : []),
        ],
        content: canSeeDraft ? content : null,
        messageContext: context?.context == null ? null : simulationReviewContext.parse(context.context),
        followUp: canSeeDraft ? simulationFollowUp.safeParse(row.followUp).data ?? null : null,
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
    const [proposal] = await proposalRows(tx, characterId, actionId)
    if (!settings || !proposal || proposal.state !== 'WAITING_APPROVAL') return
    const { target, content } = await inspect(tx, characterId, proposal, resolveAdapter)
    if (content && !skipSimulationReview(proposal, target)) return { settings, proposal, target, content }
  }, { isolationLevel: 'RepeatableRead' })
  if (!input) return
  const { settings, proposal, target, content } = input
  const outcome = settings.enabled
    ? await review(settings, { platform: target.platform, draft: content, discussion },
      { characterId, identityId: target.identityId, platform: target.platform })
    : { status: 'SKIPPED', reason: '该角色未启用自动审批。' } as const

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE rica_admin_api`
    const policyMatches = settings.enabled && await lockAutoReview(tx, characterId, settings.version)
    const [current] = await proposalRows(tx, characterId, actionId)
    if (!current || current.state !== 'WAITING_APPROVAL' || current.version !== proposal.version
      || current.reviewDigest !== proposal.reviewDigest) return
    if ((await inspect(tx, characterId, current, resolveAdapter)).content !== content) return
    if (!policyMatches || outcome.status !== 'APPROVE') {
      const handoff = settings.enabled && !policyMatches
        ? { status: 'SKIPPED', reason: '审核期间自动审批设置已更改。' } : outcome
      await tx.$executeRaw`
        UPDATE public.action_proposals SET auto_review_handoff = ${JSON.stringify(handoff)}::jsonb
        WHERE character_id = ${characterId}::uuid AND id = ${actionId}::uuid
      `
      return
    }
    const result = await finishReview(tx, characterId, current, autoReviewerId, 'APPROVE',
      `Auto-review v${settings.version} · ${outcome.model}`, resolveAdapter)
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
  if (proposal.autoReviewPending) throw new ManagementError(409, 'AUTO_REVIEW_PENDING', 'Automatic review is in progress')
  return finishReview(tx, scope.characterId, proposal, scope.actor.id, input.decision, input.reason ?? '', resolveAdapter)
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
