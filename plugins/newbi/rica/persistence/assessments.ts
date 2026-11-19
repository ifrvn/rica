import type { z } from '@hono/zod-openapi'
import { identityProfile } from '@ricajs/contracts/management'
import { discussionSelection, type DiscussionSelectionInput } from '@ricajs/contracts/discussion-selection'
import { resolveParticipation, type ModelAttribution } from '@ricajs/contracts/model-provider'
import { authorize, lockCharacter, ManagementError, type Scope } from '@ricajs/persistence/management'
import { Prisma, type NewbiDiscussionAssessment, type PrismaClient } from '@ricajs/persistence/prisma'
import { newbiAssessmentResult, newbiAssessmentView, newbiAssessmentThread } from '../management/contracts.js'

const leaseMs = 45_000
const retentionMs = 30 * 86_400_000
type Result = Exclude<z.infer<typeof newbiAssessmentResult>, { status: 'PENDING' }>
type Thread = z.infer<typeof newbiAssessmentThread>
type DiscussionTarget = { accountId: string; agentId: string; endpoint: string; postId: string }
type AssessDiscussion = (input: DiscussionSelectionInput, profile: string | undefined, attribution: ModelAttribution,
  capture: (prompt: string, model: string) => Promise<void>) => Promise<unknown>

const unavailable = (reason: Extract<Result, { status: 'UNAVAILABLE' }>['reason'], note: string): Result => ({ status: 'UNAVAILABLE', reason, note })
const timedOut = unavailable('TIMED_OUT', '评估超时，请重新评估讨论。')
const contextChanged = unavailable('CONTEXT_CHANGED', '评估期间账号绑定或身份配置发生变化。')

function assessmentView(row: NewbiDiscussionAssessment, now = Date.now()) {
  return newbiAssessmentView.parse({ ...row, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
    result: row.result ?? (now - row.createdAt.getTime() >= leaseMs ? timedOut : { status: 'PENDING' }) })
}

async function boundAccount(tx: Prisma.TransactionClient, scope: Scope, id: string) {
  const account = await tx.platformAccount.findFirst({
    where: { id, characterId: scope.characterId, platform: 'newbi' },
    select: { id: true, remoteAccountId: true, instanceKey: true, status: true, bindingVersion: true, identityId: true,
      identity: { select: { slug: true, status: true, activeProfile: { select: { roleProfile: true } },
        character: { select: { status: true, authEpoch: true } } } } },
  })
  if (!account) throw new ManagementError(404, 'NOT_FOUND', 'Newbi account not found')
  return account
}

function active(account: Awaited<ReturnType<typeof boundAccount>>) {
  return account.status === 'ACTIVE' && account.identity.status === 'ACTIVE' && account.identity.character.status === 'ACTIVE'
}

function matches(row: NewbiDiscussionAssessment, account: Awaited<ReturnType<typeof boundAccount>>) {
  return active(account) && row.identityId === account.identityId && row.bindingVersion === account.bindingVersion
    && row.authEpoch === account.identity.character.authEpoch
}

async function lockAssessmentScope(tx: Prisma.TransactionClient, scope: Scope) {
  await authorize(tx, scope)
  await lockCharacter(tx, scope.characterId)
  await authorize(tx, scope)
}

export async function claimNewbiAssessment(tx: Prisma.TransactionClient, scope: Scope, accountId: string, postId: string) {
  const account = await boundAccount(tx, scope, accountId)
  if (!active(account)) throw new ManagementError(409, 'STATE_CONFLICT', 'Newbi account is inactive')
  const event = await tx.newbiEvent.findFirst({ where: { accountId, postId, occurredAt: { gt: new Date(Date.now() - retentionMs) } }, select: { seq: true } })
  if (!event) throw new ManagementError(404, 'NOT_FOUND', 'Newbi discussion has no current event')
  const binding = { characterId: scope.characterId, accountId, postId, identityId: account.identityId,
    bindingVersion: account.bindingVersion, authEpoch: account.identity.character.authEpoch }
  // The management command holds the character lock while reserving an attempt.
  const pending = await tx.newbiDiscussionAssessment.findFirst({ where: { ...binding, result: { equals: Prisma.DbNull },
    createdAt: { gt: new Date(Date.now() - leaseMs) } }, select: { id: true } })
  if (pending) return { id: pending.id, status: 'PENDING' }
  const profile = identityProfile.pick({ displayName: true, participation: true, writingPrompt: true }).strip()
    .parse(account.identity.activeProfile?.roleProfile ?? {})
  const row = await tx.newbiDiscussionAssessment.create({ data: { ...binding,
    identity: profile.displayName ?? account.identity.slug,
    participation: resolveParticipation(profile.participation, profile.writingPrompt) }, select: { id: true } })
  return { id: row.id, status: 'STARTED' }
}

export async function listNewbiAssessments(db: PrismaClient, scope: Scope, accountId: string, postId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    await boundAccount(tx, scope, accountId)
    const rows = await tx.newbiDiscussionAssessment.findMany({
      where: { characterId: scope.characterId, accountId, postId, createdAt: { gt: new Date(Date.now() - retentionMs) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10,
    })
    return { items: rows.map((row) => assessmentView(row)) }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function runNewbiAssessment(db: PrismaClient, scope: Scope, id: string,
  readThread: ((target: DiscussionTarget) => Promise<Thread | undefined>) | undefined,
  assess: AssessDiscussion | undefined, requireConnector: (endpoint: string) => Promise<void>,
) {
  const where = { id, characterId: scope.characterId }
  const initial = await db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const row = await tx.newbiDiscussionAssessment.findUniqueOrThrow({ where })
    const account = await boundAccount(tx, scope, row.accountId)
    const [events, receipts] = await Promise.all([
      tx.newbiEvent.findMany({ where: { accountId: row.accountId, postId: row.postId, occurredAt: { gt: new Date(Date.now() - retentionMs) } },
        orderBy: [{ occurredAt: 'desc' }, { seq: 'desc' }], take: 20, select: { commentId: true, type: true } }),
      tx.newbiReply.findMany({ where: { characterId: scope.characterId, accountId: row.accountId, postId: row.postId,
        status: 'SENT', remoteCommentId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 50, select: { remoteCommentId: true } }),
    ])
    return { row, account, events, receipts }
  }, { isolationLevel: 'RepeatableRead' })
  const { row, account, events, receipts } = initial

  async function evaluate(): Promise<Result> {
    if (!matches(row, account) || !events.length) return contextChanged
    const fetched = await requireConnector(account.instanceKey).then(() => readThread?.({
      accountId: account.id, agentId: account.remoteAccountId, endpoint: account.instanceKey, postId: row.postId,
    })).catch(() => undefined)
    const thread = newbiAssessmentThread.safeParse(fetched).data
    if (!thread || thread.nextCursor) return unavailable('THREAD_UNAVAILABLE', '未能读取完整的可见讨论。')
    if (thread.post.isLocked) return { status: 'NO_REPLY', reason: 'THREAD_LOCKED', note: '帖子已锁定。' }

    const byId = new Map(thread.comments.map((comment) => [comment.id, comment]))
    const ownIds = new Set(receipts.map(({ remoteCommentId }) => remoteCommentId))
    const own = (comment: Thread['comments'][number]) => ownIds.has(comment.id) || String(comment.author.id) === account.remoteAccountId
    const answered = new Set(thread.comments.filter(own).map(({ replyToCommentId }) => replyToCommentId))
    const signals = new Map<string, 'MENTION' | 'REPLY'>()
    for (const { commentId, type } of events) {
      if (commentId && byId.has(commentId) && (type === 'AGENT_MENTIONED' || !signals.has(commentId))) {
        signals.set(commentId, type === 'AGENT_MENTIONED' ? 'MENTION' : 'REPLY')
      }
    }
    const ordered = [...new Set([...signals.keys(), ...thread.comments.slice(-24).map(({ id }) => id)])].slice(0, 24)
    const speakers = new Map<string, number>()
    const comments = ordered.map((id) => {
      const comment = byId.get(id)!
      const speakerKey = String(comment.author.id ?? comment.author.username)
      const speaker = speakers.get(speakerKey) ?? speakers.size + 1
      speakers.set(speakerKey, speaker)
      const isOwn = own(comment)
      return { id, replyToCommentId: comment.replyToCommentId, speaker, text: comment.content.slice(0, 350), own: isOwn,
        eligible: !isOwn && !answered.has(id) && !!comment.content.trim(), signal: signals.get(id) ?? null }
    })
    if (!comments.some(({ eligible }) => eligible)) {
      return answered.size && comments.some(({ id }) => answered.has(id))
        ? { status: 'NO_REPLY', reason: 'ALREADY_ANSWERED', note: '此账号已在讨论中回应相关评论。' }
        : { status: 'NO_REPLY', reason: 'INSUFFICIENT_CONTEXT', note: '可见讨论里没有可评估的评论。' }
    }
    const profile = identityProfile.pick({ writingPrompt: true, draftModelProfile: true }).strip()
      .parse(account.identity.activeProfile?.roleProfile ?? {})
    const input: DiscussionSelectionInput = { title: thread.post.title.slice(0, 240), post: thread.post.content.slice(0, 1800),
      participation: resolveParticipation(row.participation), identityPreferences: profile.writingPrompt, comments }
    const selection = await assess?.(input, profile.draftModelProfile,
      { characterId: row.characterId, identityId: row.identityId, platform: 'newbi' }, async (systemPrompt, model) => {
        await db.$transaction(async (tx) => {
          await lockAssessmentScope(tx, scope)
          if (!matches(row, await boundAccount(tx, scope, row.accountId))) throw new Error('Assessment binding changed')
          const { count } = await tx.newbiDiscussionAssessment.updateMany({
            where: { ...where, result: { equals: Prisma.DbNull }, systemPrompt: null,
              createdAt: { gt: new Date(Date.now() - leaseMs) } }, data: { systemPrompt, model },
          })
          if (!count) throw new Error('Assessment no longer accepts a model call')
        })
      }).catch(() => undefined)
    if (selection === undefined) return unavailable('MODEL_UNAVAILABLE', '没有可用的评估模型，或模型调用失败。')
    const decision = discussionSelection.safeParse(selection).data
    if (decision?.status === 'NO_REPLY') return decision
    if (decision?.status === 'SUGGEST_REPLY' && comments.some(({ id, eligible }) => id === decision.commentId && eligible)) {
      const comment = byId.get(decision.commentId)!
      return { ...decision, target: { author: comment.author.username.slice(0, 64), excerpt: comment.content.slice(0, 220) } }
    }
    return unavailable('INVALID_SELECTION', '评估结果没有指向本轮可回应的评论。')
  }

  const result = await evaluate()
  await db.$transaction(async (tx) => {
    await lockAssessmentScope(tx, scope)
    const current = await boundAccount(tx, scope, row.accountId)
    await tx.newbiDiscussionAssessment.updateMany({ where: { ...where, result: { equals: Prisma.DbNull } },
      data: { result: Date.now() - row.createdAt.getTime() >= leaseMs ? timedOut : matches(row, current) ? result : contextChanged,
        finishedAt: new Date() } })
  })
}

export type { AssessDiscussion }
