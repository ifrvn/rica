import type { z } from '@hono/zod-openapi'
import { reviewTarget, type ActionView, type actionDecision } from '../contracts/action-review.js'
import { resolveSimulatedPlatform } from '../runtime/simulated-platforms.js'
import type { Prisma, PrismaClient } from './generated/client.js'
import { authorize, denyPermission, ManagementError, type Scope } from './management.js'

export const simulationReviewPolicyVersion = 1

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
  adapterVersion: string
  proposerId: string | null
  expiresAt: Date
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
      a.proposer_id AS "proposerId", a.expires_at AS "expiresAt",
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

async function inspect(tx: Prisma.TransactionClient, characterId: string, proposal: Proposal, readContent = true) {
  const target = reviewTarget.parse(proposal.target)
  if (!reviewStates.includes(proposal.state)) notFound()
  if (proposal.state !== 'WAITING_APPROVAL' && proposal.state !== 'READY') {
    return { target, state: proposal.state, content: null }
  }
  if (proposal.expiresAt.getTime() <= Date.now()) return { target, state: 'EXPIRED' as const, content: null }
  if (proposal.policyVersion !== simulationReviewPolicyVersion
    || proposal.adapterVersion !== resolveSimulatedPlatform(target.platform).version) {
    return { target, state: 'CANCELED' as const, content: null }
  }
  if (!readContent) return { target, state: proposal.state, content: null }
  const [payload] = await tx.$queryRaw<{ content: string | null }[]>`
    SELECT public.rica_review_payload(${characterId}::uuid, ${proposal.id}::uuid) AS content
  `
  return payload?.content
    ? { target, state: proposal.state, content: payload.content }
    : { target, state: 'CANCELED' as const, content: null }
}

export async function listReviewActions(
  db: PrismaClient, scope: Scope, actionId?: string, limit = 25, cursor?: string,
) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['REVIEWER'])
    const rows = await proposalRows(tx, scope.characterId, actionId ?? null, limit + 1, cursor ?? null)
    if (actionId && !rows.length) notFound()
    const actions: ActionView[] = []
    for (const row of rows.slice(0, limit)) {
      const { target, state, content } = await inspect(tx, scope.characterId, row, Boolean(actionId))
      actions.push({
        id: row.id, runId: row.runId, mode: 'SIMULATION', kind: 'REPLY',
        target, state, version: row.version, expiresAt: row.expiresAt.toISOString(),
        reviewDigest: row.reviewDigest, riskCodes: ['HUMAN_REVIEW_REQUIRED'],
        content: actionId && row.proposerId !== scope.actor.id ? content : null,
      })
    }
    return { items: actions, nextCursor: rows.length > limit ? actions.at(-1)?.id ?? null : null }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function decideReviewAction(
  tx: Prisma.TransactionClient, scope: Scope, actionId: string, version: number,
  input: z.infer<typeof actionDecision>,
) {
  const [proposal] = await proposalRows(tx, scope.characterId, actionId)
  if (!proposal) notFound()
  if (proposal.proposerId === scope.actor.id) denyPermission()
  if (proposal.version !== version) throw new ManagementError(412, 'STALE_VERSION', 'Proposal version has changed')
  if (proposal.state !== 'WAITING_APPROVAL' || proposal.reviewDigest !== input.reviewDigest) {
    throw new ManagementError(409, 'STALE_REVIEW', 'Proposal no longer matches the review')
  }

  const { state } = await inspect(tx, scope.characterId, proposal)
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
