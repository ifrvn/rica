import { createHash, randomUUID } from 'node:crypto'
import type { z } from '@hono/zod-openapi'
import { newbiExecutorIdentity, newbiExecutorKey } from '../runtime/identity.js'
import { coreProfile, identityProfile } from '@rica/contracts/management'
import { newbiInboxView, newbiReplySummary, newbiReplyView, type newbiReplyQuery, type newbiAccountInput, type newbiReplyInput, type newbiDecisionInput, type newbiClosureInput, type newbiThreadView } from '../management/contracts.js'
import type { Prisma, PrismaClient } from '../../../../packages/persistence/generated/client.js'
import { associateAccount, authorize, denyPermission, registerAccount, makePage, ManagementError, pageArgs, type Page, type Scope } from '../../../../packages/persistence/management.js'
import { autoReviewerId, type ReviewPublicReply } from '../../../../packages/contracts/auto-review.js'
import { lockAutoReview, readAutoReviewSettings } from '../../../../packages/persistence/auto-review.js'
import { containsWritingPrompt } from '../../../../packages/runtime/writing-prompts.js'

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
    return newbiReplyView.parse({
      ...reply, identity: reply.account.identity.slug, agentId: reply.account.remoteAccountId,
      endpoint: reply.account.instanceKey, expiresAt: reply.expiresAt.toISOString(),
      content: reply.status === 'WAITING' && reply.executorKey !== executorKey ? null : reply.content,
      autoApproved: reply.reviewerId === autoReviewerId,
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
  if (!settings?.enabled) return
  const reply = await db.$transaction(async (tx) => {
    if (!await lockAutoReview(tx, characterId, settings.version)) return
    const current = await tx.newbiReply.findFirst({
      where: { id, characterId, status: 'WAITING', executorKey, autoReviewVersion: null },
    })
    if (!current?.content) return
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
    if (!prior?.remoteCommentId) return
    await tx.newbiReply.update({ where: { id }, data: { autoReviewVersion: settings.version }, select: { id: true } })
    return { ...current, content: current.content, endpoint: account.instanceKey,
      agentId: account.remoteAccountId, previousCommentId: prior.remoteCommentId }
  })
  if (!reply) return

  await requireConnector(reply.endpoint)
  const thread = await readThread(reply)
  if (!thread || thread.post.isLocked || !thread.comments.some(({ id }) => id === reply.previousCommentId)
    || thread.comments.some(({ content }) => content.trim() === reply.content.trim())) return
  const discussion = JSON.stringify({ title: thread.post.title, post: thread.post.content,
    comments: thread.comments.map(({ content }) => content) })
  const model = await review(settings, { platform: 'newbi', draft: reply.content, discussion })
  if (!model) return

  await db.$transaction(async (tx) => {
    if (!await lockAutoReview(tx, characterId, settings.version)) return
    await decideReply(tx, characterId, autoReviewerId, id,
      { decision: 'APPROVE', reviewDigest: reply.reviewDigest }, requireConnector)
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
  input: Pick<z.infer<typeof newbiDecisionInput>, 'decision' | 'reviewDigest'>,
  requireConnector: (endpoint: string) => Promise<void>,
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
    data: { status, reviewerId, approvedExecutorKey: status === 'READY' ? executorKey : null },
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
      select: { remoteAccountId: true, newbiCheckpoint: { select: { nextPollAt: true, historyLostCount: true, lastHistoryLostAt: true, lastSucceededAt: true, readError: true } },
        newbiEvents: { orderBy: [{ occurredAt: 'desc' }, { seq: 'desc' }], take: 50,
          select: { seq: true, type: true, postId: true, commentId: true, occurredAt: true } } },
    })
    if (!account) missing()
    const checkpoint = account.newbiCheckpoint
    return newbiInboxView.parse({
      agentId: account.remoteAccountId,
      lastSucceededAt: checkpoint?.lastSucceededAt?.toISOString() ?? null,
      readError: checkpoint?.readError ?? null,
      nextPollAt: checkpoint?.nextPollAt.toISOString() ?? null,
      historyLostCount: checkpoint?.historyLostCount ?? 0,
      lastHistoryLostAt: checkpoint?.lastHistoryLostAt?.toISOString() ?? null,
      items: account.newbiEvents.map(({ occurredAt, ...event }) => ({ ...event, occurredAt: occurredAt.toISOString() })),
    })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readNewbiConnections(db: PrismaClient, characterId: string, endpoint: string) {
  const account = { characterId, platform: 'newbi', instanceKey: endpoint }
  const [active, confirmed, unknown] = await Promise.all([
    db.platformAccount.findMany({
      where: { ...account, status: 'ACTIVE', identity: { status: 'ACTIVE', character: { status: 'ACTIVE' } } },
      select: { newbiCheckpoint: { select: { lastSucceededAt: true, readError: true } } },
    }),
    db.newbiReply.findFirst({ where: { characterId, status: 'SENT', account }, select: { id: true } }),
    db.newbiReply.findFirst({ where: { characterId, status: 'UNKNOWN', account }, select: { id: true } }),
  ])
  let lastReadAt: Date | null = null
  let readFailures = 0
  for (const { newbiCheckpoint } of active) {
    if (newbiCheckpoint?.readError) readFailures++
    const succeeded = newbiCheckpoint?.lastSucceededAt
    if (succeeded && (!lastReadAt || succeeded > lastReadAt)) lastReadAt = succeeded
  }
  return { activeAccounts: active.length, readFailures, lastReadAt: lastReadAt?.toISOString() ?? null,
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
