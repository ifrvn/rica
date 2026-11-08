import { createHash, randomUUID } from 'node:crypto'
import type { z } from '@hono/zod-openapi'
import { coreProfile } from '../contracts/management.js'
import { newbiReplyView, type newbiAccountInput, type newbiReplyInput, type newbiDecisionInput } from '../contracts/newbi-pilot.js'
import type { Prisma, PrismaClient } from './generated/client.js'
import { authorize, denyPermission, ManagementError, type Scope } from './management.js'

function missing(): never { throw new ManagementError(404, 'NOT_FOUND', 'Newbi pilot resource not found') }
function conflict(): never { throw new ManagementError(409, 'STATE_CONFLICT', 'Newbi reply is no longer eligible') }

export async function bindNewbiAccount(tx: Prisma.TransactionClient, scope: Scope, input: z.infer<typeof newbiAccountInput>) {
  const { characterId } = scope
  if (!await tx.identity.findFirst({ where: { characterId, id: input.identityId }, select: { id: true } })) missing()
  const account = await tx.platformAccount.create({
    data: { characterId, identityId: input.identityId, platform: 'newbi', instanceKey: input.endpoint,
      remoteAccountId: input.agentId, status: 'PAUSED' },
    select: { id: true, status: true, bindingVersion: true },
  })
  return { id: account.id, status: account.status, version: account.bindingVersion }
}

async function boundAccount(tx: Prisma.TransactionClient, characterId: string, id: string) {
  return tx.platformAccount.findFirst({
    where: { id, characterId, platform: 'newbi' },
    include: { identity: { include: { character: { include: { activeCore: true } } } } },
  })
}

export async function createNewbiReply(tx: Prisma.TransactionClient, scope: Scope, input: z.infer<typeof newbiReplyInput>) {
  const account = await boundAccount(tx, scope.characterId, input.accountId)
  if (!account) missing()
  const { identity } = account
  const character = identity.character
  if (account.status !== 'ACTIVE' || identity.status !== 'ACTIVE' || character.status !== 'ACTIVE') conflict()
  const disclosure = coreProfile.strip().safeParse(character.activeCore?.hardProfile).data?.aiDisclosure
  if (!disclosure) throw new ManagementError(422, 'INVALID_INPUT', 'AI disclosure is required')
  const content = input.content + '\n\nAI 披露：' + disclosure
  if ([...content].length > 4000) throw new ManagementError(422, 'INVALID_INPUT', 'Reply plus disclosure exceeds the Newbi limit')
  const id = randomUUID()
  const reviewDigest = createHash('sha256').update(JSON.stringify([
    id, account.id, account.instanceKey, account.remoteAccountId, account.bindingVersion,
    character.authEpoch, input.postId, content,
  ])).digest('hex')
  const [clock] = await tx.$queryRaw<{ expires: Date }[]>`SELECT clock_timestamp()+interval '24 hours' AS expires`
  await tx.newbiReply.create({
    data: { id, characterId: scope.characterId, identityId: identity.id, accountId: account.id,
      authEpoch: character.authEpoch, bindingVersion: account.bindingVersion, postId: input.postId,
      content, reviewDigest, proposerId: scope.actor.id, expiresAt: clock.expires },
  })
  return { id, status: 'WAITING' }
}

export async function getNewbiReply(db: PrismaClient, scope: Scope, id: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'REVIEWER'])
    const reply = await tx.newbiReply.findFirst({ where: { id, characterId: scope.characterId },
      include: { account: { select: { instanceKey: true, remoteAccountId: true } } } })
    if (!reply) missing()
    return newbiReplyView.parse({
      ...reply, agentId: reply.account.remoteAccountId, endpoint: reply.account.instanceKey, expiresAt: reply.expiresAt.toISOString(),
    })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function decideNewbiReply(tx: Prisma.TransactionClient, scope: Scope, id: string, input: z.infer<typeof newbiDecisionInput>) {
  const reply = await tx.newbiReply.findFirst({ where: { id, characterId: scope.characterId } })
  if (!reply) missing()
  if (reply.proposerId === scope.actor.id) denyPermission()
  if (reply.status !== 'WAITING' || reply.reviewDigest !== input.reviewDigest) conflict()
  const account = await boundAccount(tx, scope.characterId, reply.accountId)
  if (!account || account.status !== 'ACTIVE' || account.identity.status !== 'ACTIVE'
    || account.identity.character.status !== 'ACTIVE' || account.bindingVersion !== reply.bindingVersion
    || account.identity.character.authEpoch !== reply.authEpoch) conflict()
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
  if (reply.expiresAt <= clock.now) conflict()
  const status = input.decision === 'APPROVE' ? 'READY' : 'REJECTED'
  const { count } = await tx.newbiReply.updateMany({
    where: { id, status: 'WAITING' }, data: { status, reviewerId: scope.actor.id },
  })
  if (count !== 1) conflict()
  return { id, status }
}
