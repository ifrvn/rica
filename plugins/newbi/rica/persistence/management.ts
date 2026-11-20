import { createHash, randomUUID } from 'node:crypto'
import type { z } from '@hono/zod-openapi'
import { newbiExecutorIdentity, newbiExecutorKey } from '../runtime/identity.js'
import { coreProfile, identityProfile } from '@ricajs/contracts/management'
import { newbiInboxView, newbiReplySummary, newbiReplyView, type newbiReplyQuery, type newbiAccountInput, type newbiReplyInput, type newbiDecisionInput, type newbiClosureInput, type newbiThreadView } from '../management/contracts.js'
import { Prisma, type PrismaClient } from '@ricajs/persistence/prisma'
import { associateAccount, authorize, denyPermission, registerAccount, makePage, ManagementError, pageArgs, type Page, type Scope } from '@ricajs/persistence/management'
import { autoReviewHandoff, autoReviewerId, missingAutoReviewHandoff, type AutoReviewOutcome, type AutoReviewSettings, type ReviewPublicReply } from '@ricajs/contracts/auto-review'
import { lockAutoReview, readAutoReviewSettings } from '@ricajs/persistence/auto-review'
import { containsWritingPrompt } from '@ricajs/runtime/writing-prompts'

const executorKey = newbiExecutorKey(newbiExecutorIdentity)

function missing(): never { throw new ManagementError(404, 'NOT_FOUND', 'Newbi pilot resource not found') }
function conflict(): never { throw new ManagementError(409, 'STATE_CONFLICT', 'Newbi reply is no longer eligible') }

export async function bindNewbiAccount(tx: Prisma.TransactionClient, scope: Scope, input: z.infer<typeof newbiAccountInput> & { endpoint: string; agentId: string }) {
  const { id } = await registerAccount(tx, scope, { platform: 'newbi', instanceKey: input.endpoint, remoteAccountId: input.agentId })
  return associateAccount(tx, scope, { registrationId: id, identityId: input.identityId })
}

async function boundAccount(tx: Prisma.TransactionClient, characterId: string, id: string) {
  return tx.platformAccount.findFirst({
    where: { id, characterId, platform: 'newbi' },
    include: { identity: { include: {
      activeProfile: { select: { roleProfile: true } }, character: { include: { activeCore: true } },
    } } },
  })
}

export async function createNewbiReply(
  tx: Prisma.TransactionClient, scope: Scope, input: z.infer<typeof newbiReplyInput>, requireConnector: (endpoint: string) => Promise<void>,
) {
  const account = await boundAccount(tx, scope.characterId, input.accountId)
  if (!account) missing()
  const { identity } = account
  const character = identity.character
  if (account.status !== 'ACTIVE' || identity.status !== 'ACTIVE' || character.status !== 'ACTIVE') conflict()
  await requireConnector(account.instanceKey)
  const { content } = input
  const corePrompt = coreProfile.pick({ aiDisclosure: true }).strip().safeParse(character.activeCore?.hardProfile).data?.aiDisclosure
  const identityPrompt = identityProfile.pick({ writingPrompt: true }).strip().safeParse(identity.activeProfile?.roleProfile).data?.writingPrompt
  if (content.includes('\n\nAI 披露：') || containsWritingPrompt(content, corePrompt, identityPrompt)) {
    throw new ManagementError(422, 'PRIVATE_WRITING_PROMPT', 'Reply contains internal writing instructions')
  }
  const id = randomUUID()
  const reviewDigest = createHash('sha256').update(JSON.stringify([
    id, account.id, account.instanceKey, account.remoteAccountId, account.bindingVersion,
    character.authEpoch, input.postId, content, executorKey,
  ])).digest('hex')
  const [clock] = await tx.$queryRaw<{ expires: Date }[]>`SELECT clock_timestamp()+interval '24 hours' AS expires`
  await tx.newbiReply.create({
    data: { id, characterId: scope.characterId, identityId: identity.id, accountId: account.id,
      authEpoch: character.authEpoch, bindingVersion: account.bindingVersion, postId: input.postId,
      content, reviewDigest, executorKey, proposerId: scope.actor.id, expiresAt: clock.expires },
  })
  return { id, status: 'WAITING' }
}

export async function listNewbiReplies(db: PrismaClient, scope: Scope, page: Page, { status, accountId }: z.infer<typeof newbiReplyQuery>) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId, status, accountId }
    const args = await pageArgs(page, (id) => tx.newbiReply.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.newbiReply.findMany({
      ...args, where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, postId: true, createdAt: true,
        account: { select: { remoteAccountId: true, identity: { select: { slug: true } } } } },
    })
    return makePage(rows, page, ({ account, createdAt, ...reply }) => newbiReplySummary.parse({
      ...reply, identity: account.identity.slug, agentId: account.remoteAccountId, createdAt: createdAt.toISOString(),
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function getNewbiReply(db: PrismaClient, scope: Scope, id: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const reply = await tx.newbiReply.findFirst({ where: { id, characterId: scope.characterId },
      include: { account: { select: { instanceKey: true, remoteAccountId: true, identity: { select: { slug: true } } } } } })
    if (!reply) missing()
    const canPreview = reply.status === 'WAITING' && reply.executorKey === executorKey && reply.content
    const reviewer = reply.reviewerId && reply.reviewerId !== autoReviewerId
      ? await tx.adminUser.findUnique({ where: { actorId: reply.reviewerId }, select: { username: true } }) : null
    return newbiReplyView.parse({
      ...reply, identity: reply.account.identity.slug, agentId: reply.account.remoteAccountId,
      endpoint: reply.account.instanceKey, expiresAt: reply.expiresAt.toISOString(),
      content: reply.status === 'WAITING' && reply.executorKey !== executorKey ? null : reply.content,
      autoApproved: reply.reviewerId === autoReviewerId,
      reviewerName: reviewer?.username ?? null,
      autoReviewHandoff: autoReviewHandoff.safeParse(reply.autoReviewHandoff).data ?? (canPreview ? missingAutoReviewHandoff : null),
      reviewPrompt: reply.content && Date.now() - reply.createdAt.getTime() < 30 * 86_400_000 ? reply.reviewPrompt : null,
      retryNotBefore: reply.retryNotBefore?.toISOString() ?? null,
      leaseUntil: reply.leaseUntil?.toISOString() ?? null,
    })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function autoReviewNewbiReply(
  db: PrismaClient, characterId: string, id: string, requestId: string, review: ReviewPublicReply,
  readThread: (target: Pick<z.infer<typeof newbiReplyView>, 'accountId' | 'agentId' | 'endpoint' | 'postId'>) =>
    Promise<z.infer<typeof newbiThreadView> | undefined>,
  requireConnector: (endpoint: string) => Promise<void>,
) {
  const settings = await readAutoReviewSettings(db, characterId)
  if (!settings) return
  const reply = await db.$transaction(async (tx) => {
    if (settings.enabled && !await lockAutoReview(tx, characterId, settings.version)) return
    const current = await tx.newbiReply.findFirst({
      where: { id, characterId, status: 'WAITING', executorKey, autoReviewVersion: null },
    })
    if (!current?.content) return
    if (!settings.enabled) {
      await tx.newbiReply.updateMany({ where: { id, characterId, status: 'WAITING', content: { not: null } },
        data: { autoReviewHandoff: { status: 'SKIPPED', category: 'POLICY', reason: '该角色未启用自动审批。' } } })
      return
    }
    const account = await boundAccount(tx, characterId, current.accountId)
    if (!account || account.status !== 'ACTIVE' || account.identity.status !== 'ACTIVE'
      || account.bindingVersion !== current.bindingVersion || account.identity.character.authEpoch !== current.authEpoch
      || current.expiresAt <= new Date()) return
    const prior = await tx.newbiReply.findFirst({
      where: {
        characterId, accountId: current.accountId, postId: current.postId,
        bindingVersion: current.bindingVersion, status: 'SENT',
      },
      select: { remoteCommentId: true }, orderBy: { createdAt: 'desc' },
    })
    if (!prior?.remoteCommentId) {
      await tx.newbiReply.updateMany({ where: { id, characterId, status: 'WAITING', content: { not: null } },
        data: { autoReviewHandoff: { status: 'SKIPPED', category: 'POLICY', reason: '此账号在该帖暂无已确认发送的回复，首次互动须由人工审核。' } } })
      return
    }
    await tx.newbiReply.update({ where: { id }, data: { autoReviewVersion: settings.version }, select: { id: true } })
    return { ...current, content: current.content, endpoint: account.instanceKey,
      agentId: account.remoteAccountId, previousCommentId: prior.remoteCommentId }
  })
  if (!reply) return

  async function evaluate(current: NonNullable<typeof reply>, policy: AutoReviewSettings): Promise<AutoReviewOutcome> {
    const thread = await requireConnector(current.endpoint).then(() => readThread(current)).catch(() => undefined)
    if (!thread) return { status: 'UNAVAILABLE', category: 'CONTEXT', reason: '无法读取 Newbi 帖子和评论，未能完成审核。' }
    if (thread.post.isLocked) return { status: 'SKIPPED', category: 'POLICY', reason: 'Newbi 帖子已锁定。' }
    if (!thread.comments.some(({ id }) => id === current.previousCommentId)) {
      return { status: 'SKIPPED', category: 'CONTEXT', reason: '当前讨论中无法确认此账号此前的回复。' }
    }
    if (thread.comments.some(({ content }) => content.trim() === current.content.trim())) {
      return { status: 'SKIPPED', category: 'POLICY', reason: '讨论中已有相同内容的评论，请核对是否重复。' }
    }
    const discussion = JSON.stringify({ title: thread.post.title, post: thread.post.content,
      comments: thread.comments.map(({ content }) => content) })
    return review(policy, { platform: 'newbi', draft: current.content, discussion },
      { characterId, identityId: current.identityId, platform: 'newbi' }, async (systemPrompt, model) => {
        const { count } = await db.newbiReply.updateMany({
          where: { id, characterId, status: 'WAITING', reviewDigest: current.reviewDigest, autoReviewVersion: policy.version,
            reviewPrompt: { equals: Prisma.DbNull } },
          data: { reviewPrompt: { model, systemPrompt, at: new Date().toISOString(), policyVersion: policy.version } },
        })
        if (!count) throw new Error('Newbi proposal no longer accepts a model call')
      })
  }
  const outcome = await evaluate(reply, settings)

  await db.$transaction(async (tx) => {
    const policyMatches = await lockAutoReview(tx, characterId, settings.version)
    if (!policyMatches || outcome.status !== 'APPROVE') {
      const handoff = !policyMatches ? { status: 'SKIPPED', category: 'POLICY', reason: '审核期间自动审批设置已更改。' } : outcome
      await tx.newbiReply.updateMany({
        where: { id, characterId, status: 'WAITING', executorKey, reviewDigest: reply.reviewDigest, content: reply.content },
        data: { autoReviewHandoff: handoff },
      })
      return
    }
    await decideReply(tx, characterId, autoReviewerId, id,
      { decision: 'APPROVE', reviewDigest: reply.reviewDigest, reason: outcome.reason }, requireConnector,
      { model: outcome.model, policyVersion: settings.version })
    await tx.managementAudit.create({ data: {
      characterId, actorId: autoReviewerId, operation: 'newbi.reply.auto-approve', targetId: id,
      requestId, digest: reply.reviewDigest,
    } })
  })
}

export async function decideNewbiReply(
  tx: Prisma.TransactionClient, scope: Scope, id: string, input: z.infer<typeof newbiDecisionInput>,
  requireConnector: (endpoint: string) => Promise<void>,
) {
  return decideReply(tx, scope.characterId, scope.actor.id, id, input, requireConnector)
}

async function decideReply(
  tx: Prisma.TransactionClient, characterId: string, reviewerId: string, id: string,
  input: z.infer<typeof newbiDecisionInput>,
  requireConnector: (endpoint: string) => Promise<void>,
  autoReview?: { model: string; policyVersion: number },
) {
  const reply = await tx.newbiReply.findFirst({ where: { id, characterId } })
  if (!reply) missing()
  if (reply.proposerId === reviewerId) denyPermission()
  if (reply.status !== 'WAITING' || reply.executorKey !== executorKey || reply.reviewDigest !== input.reviewDigest) conflict()
  const account = await boundAccount(tx, characterId, reply.accountId)
  if (!account || account.status !== 'ACTIVE' || account.identity.status !== 'ACTIVE'
    || account.identity.character.status !== 'ACTIVE' || account.bindingVersion !== reply.bindingVersion
    || account.identity.character.authEpoch !== reply.authEpoch) conflict()
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
  if (reply.expiresAt <= clock.now) conflict()
  if (input.decision === 'APPROVE') await requireConnector(account.instanceKey)
  const status = input.decision === 'APPROVE' ? 'READY' : 'REJECTED'
  const { count } = await tx.newbiReply.updateMany({
    where: { id, status: 'WAITING', executorKey },
    data: { status, reviewerId, approvedExecutorKey: status === 'READY' ? executorKey : null,
      reviewRecord: { decision: input.decision, at: clock.now.toISOString(), reviewerId, reason: input.reason ?? null, ...autoReview } },
  })
  if (count !== 1) conflict()
  return { id, status }
}

export async function closeNewbiReply(tx: Prisma.TransactionClient, scope: Scope, id: string, input: z.infer<typeof newbiClosureInput>) {
  const reply = await tx.newbiReply.findFirst({ where: { id, characterId: scope.characterId }, select: { id: true } })
  if (!reply) missing()
  const [result] = await tx.$queryRaw<{ closed: boolean }[]>`
    SELECT public.rica_close_newbi_reply(${id}::uuid, ${scope.characterId}::uuid, ${input.reason}) AS closed
  `
  if (!result.closed) conflict()
  return { id, status: 'CLOSED' }
}

export async function getNewbiInbox(db: PrismaClient, scope: Scope, id: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const account = await tx.platformAccount.findFirst({ where: { id, characterId: scope.characterId, platform: 'newbi' },
      select: { remoteAccountId: true },
    })
    if (!account) missing()
    const [[checkpoint], events] = await Promise.all([
      tx.$queryRaw<{ nextPollAt: Date; historyLostCount: number; lastHistoryLostAt: Date | null;
        lastSucceededAt: Date | null; readError: string | null }[]>`
        SELECT next_poll_at AS "nextPollAt", history_lost_count AS "historyLostCount", last_history_lost_at AS "lastHistoryLostAt",
          last_succeeded_at AS "lastSucceededAt", read_error AS "readError"
        FROM rica_plugin_newbi.event_checkpoints WHERE account_id = ${id}::uuid`,
      tx.$queryRaw<{ seq: string; type: string; postId: string; commentId: string | null; occurredAt: Date }[]>`
        SELECT seq, type, post_id AS "postId", comment_id AS "commentId", occurred_at AS "occurredAt"
        FROM rica_plugin_newbi.events WHERE account_id = ${id}::uuid
        ORDER BY occurred_at DESC, seq DESC LIMIT 50`,
    ])
    return newbiInboxView.parse({
      agentId: account.remoteAccountId,
      lastSucceededAt: checkpoint?.lastSucceededAt?.toISOString() ?? null,
      readError: checkpoint?.readError ?? null,
      nextPollAt: checkpoint?.nextPollAt.toISOString() ?? null,
      historyLostCount: checkpoint?.historyLostCount ?? 0,
      lastHistoryLostAt: checkpoint?.lastHistoryLostAt?.toISOString() ?? null,
      items: events.map(({ occurredAt, ...event }) => ({ ...event, occurredAt: occurredAt.toISOString() })),
    })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readNewbiConnections(db: PrismaClient, characterId: string, endpoint: string) {
  const account = { characterId, platform: 'newbi', instanceKey: endpoint }
  const [[active], confirmed, unknown] = await Promise.all([
    db.$queryRaw<{ activeAccounts: number; readFailures: number; lastReadAt: Date | null }[]>`
      SELECT count(*)::integer AS "activeAccounts", count(p.read_error)::integer AS "readFailures",
        max(p.last_succeeded_at) AS "lastReadAt"
      FROM public.platform_accounts a
      JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
      JOIN public.characters c ON c.id = a.character_id
      LEFT JOIN rica_plugin_newbi.event_checkpoints p ON p.account_id = a.id
      WHERE a.character_id = ${characterId}::uuid AND a.platform = 'newbi' AND a.instance_key = ${endpoint}
        AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'`,
    db.newbiReply.findFirst({ where: { characterId, status: 'SENT', account }, select: { id: true } }),
    db.newbiReply.findFirst({ where: { characterId, status: 'UNKNOWN', account }, select: { id: true } }),
  ])
  return { ...active, lastReadAt: active.lastReadAt?.toISOString() ?? null,
    hasReceipt: !!confirmed, hasUnknown: !!unknown }
}

export async function readPendingDeliveries(db: PrismaClient, characterId: string) {
  const counts = await db.newbiReply.groupBy({
    by: ['status'], where: { characterId, status: { in: ['IN_FLIGHT', 'UNKNOWN'] } }, _count: true,
  })
  return {
    inFlight: counts.find(({ status }) => status === 'IN_FLIGHT')?._count ?? 0,
    unknown: counts.find(({ status }) => status === 'UNKNOWN')?._count ?? 0,
  }
}

export async function checkNewbiAccount(db: PrismaClient, scope: Scope, accountId: string, verify: (endpoint: string, agentId: string) => Promise<boolean>) {
  const account = await db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const account = await tx.platformAccount.findFirst({
      where: { id: accountId, characterId: scope.characterId, platform: 'newbi', status: { not: 'REVOKED' } },
      select: { instanceKey: true, remoteAccountId: true },
    })
    return account ?? tx.platformAccountRegistration.findFirst({
      where: { id: accountId, characterId: scope.characterId, platform: 'newbi', boundAt: null },
      select: { instanceKey: true, remoteAccountId: true },
    })
  }, { isolationLevel: 'RepeatableRead' })
  if (!account) missing()
  const verified = await verify(account.instanceKey, account.remoteAccountId)
  return { verified, checkedAt: new Date().toISOString() }
}
