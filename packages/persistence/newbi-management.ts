import { createHash, randomUUID } from 'node:crypto'
import type { z } from '@hono/zod-openapi'
import { newbiExecutorIdentity, newbiExecutorKey } from '../contracts/newbi-executor-identity.js'
import { coreProfile } from '../contracts/management.js'
import { newbiInboxView, newbiReplySummary, newbiReplyView, type newbiReplyQuery, type newbiAccountInput, type newbiReplyInput, type newbiDecisionInput, type newbiClosureInput } from '../contracts/newbi-pilot.js'
import type { Prisma, PrismaClient } from './generated/client.js'
import { associateAccount, authorize, denyPermission, registerAccount, makePage, ManagementError, pageArgs, type Page, type Scope } from './management.js'

const executorKey = newbiExecutorKey(newbiExecutorIdentity)

function missing(): never { throw new ManagementError(404, 'NOT_FOUND', 'Newbi pilot resource not found') }
function conflict(): never { throw new ManagementError(409, 'STATE_CONFLICT', 'Newbi reply is no longer eligible') }

export async function bindNewbiAccount(tx: Prisma.TransactionClient, scope: Scope, input: z.infer<typeof newbiAccountInput>) {
  const { id } = await registerAccount(tx, scope, { platform: 'newbi', instanceKey: input.endpoint, remoteAccountId: input.agentId })
  return associateAccount(tx, scope, { registrationId: id, identityId: input.identityId })
}

async function boundAccount(tx: Prisma.TransactionClient, characterId: string, id: string) {
  return tx.platformAccount.findFirst({
    where: { id, characterId, platform: 'newbi' },
    include: { identity: { include: { character: { include: { activeCore: true } } } } },
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
  const disclosure = coreProfile.strip().safeParse(character.activeCore?.hardProfile).data?.aiDisclosure
  if (!disclosure) throw new ManagementError(422, 'INVALID_INPUT', 'AI disclosure is required')
  const content = input.content + '\n\nAI 披露：' + disclosure
  if ([...content].length > 4000) throw new ManagementError(422, 'INVALID_INPUT', 'Reply plus disclosure exceeds the Newbi limit')
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
    await authorize(tx, scope, ['ADMIN', 'REVIEWER'])
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
    await authorize(tx, scope, ['ADMIN', 'REVIEWER'])
    const reply = await tx.newbiReply.findFirst({ where: { id, characterId: scope.characterId },
      include: { account: { select: { instanceKey: true, remoteAccountId: true, identity: { select: { slug: true } } } } } })
    if (!reply) missing()
    return newbiReplyView.parse({
      ...reply, identity: reply.account.identity.slug, agentId: reply.account.remoteAccountId,
      endpoint: reply.account.instanceKey, expiresAt: reply.expiresAt.toISOString(),
      content: reply.status === 'WAITING' && reply.executorKey !== executorKey ? null : reply.content,
      retryNotBefore: reply.retryNotBefore?.toISOString() ?? null,
    })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function decideNewbiReply(
  tx: Prisma.TransactionClient, scope: Scope, id: string, input: z.infer<typeof newbiDecisionInput>,
  requireConnector: (endpoint: string) => Promise<void>,
) {
  const reply = await tx.newbiReply.findFirst({ where: { id, characterId: scope.characterId } })
  if (!reply) missing()
  if (reply.proposerId === scope.actor.id) denyPermission()
  if (reply.status !== 'WAITING' || reply.executorKey !== executorKey || reply.reviewDigest !== input.reviewDigest) conflict()
  const account = await boundAccount(tx, scope.characterId, reply.accountId)
  if (!account || account.status !== 'ACTIVE' || account.identity.status !== 'ACTIVE'
    || account.identity.character.status !== 'ACTIVE' || account.bindingVersion !== reply.bindingVersion
    || account.identity.character.authEpoch !== reply.authEpoch) conflict()
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
  if (reply.expiresAt <= clock.now) conflict()
  if (input.decision === 'APPROVE') await requireConnector(account.instanceKey)
  const status = input.decision === 'APPROVE' ? 'READY' : 'REJECTED'
  const { count } = await tx.newbiReply.updateMany({
    where: { id, status: 'WAITING', executorKey },
    data: { status, reviewerId: scope.actor.id, approvedExecutorKey: status === 'READY' ? executorKey : null },
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
    const roles = await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const canReadEvents = roles.some(({ role }) => role === 'ADMIN')
    const account = await tx.platformAccount.findFirst({ where: { id, characterId: scope.characterId, platform: 'newbi' },
      select: { remoteAccountId: true, newbiCheckpoint: { select: { nextPollAt: true, historyLostCount: true, lastHistoryLostAt: true, lastSucceededAt: true, readError: true } },
        newbiEvents: canReadEvents ? { orderBy: [{ occurredAt: 'desc' }, { seq: 'desc' }], take: 50,
          select: { seq: true, type: true, postId: true, commentId: true, occurredAt: true } } : false },
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
      items: canReadEvents ? account.newbiEvents.map(({ occurredAt, ...event }) => ({ ...event, occurredAt: occurredAt.toISOString() })) : null,
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
