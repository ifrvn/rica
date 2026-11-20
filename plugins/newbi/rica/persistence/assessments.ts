import { createHash } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import { identityProfile } from '@ricajs/contracts/management'
import { discussionSelection, type DiscussionSelectionInput } from '@ricajs/contracts/discussion-selection'
import { resolveParticipation, type ModelAttribution } from '@ricajs/contracts/model-provider'
import { authorize, lockCharacter, ManagementError, type Scope } from '@ricajs/persistence/management'
import { Prisma, type NewbiDiscussionAssessment, type PrismaClient } from '@ricajs/persistence/prisma'
import { newbiAssessmentResult, newbiAssessmentView, newbiAssessmentThread } from '../management/contracts.js'
import { authorTermSelect, prepareDiscussionGlossary } from './discussion-glossary.js'
import { sectionSampleSelect } from './section-glossary.js'

const leaseMs = 45_000
const retentionMs = 30 * 86_400_000
type Result = Exclude<z.infer<typeof newbiAssessmentResult>, { status: 'PENDING' }>
type Thread = z.infer<typeof newbiAssessmentThread>
type DiscussionTarget = { accountId: string; agentId: string; endpoint: string; postId: string }
type AssessmentScope = Scope | { characterId: string; background: true }
type AssessDiscussion = (input: DiscussionSelectionInput, profile: string | undefined, attribution: ModelAttribution,
  capture: (prompt: string, model: string) => Promise<void>) => Promise<unknown>

const unavailable = (reason: Extract<Result, { status: 'UNAVAILABLE' }>['reason'], note: string): Result => ({ status: 'UNAVAILABLE', reason, note })
const timedOut = unavailable('TIMED_OUT', '评估超时，请重新评估讨论。')
const contextChanged = unavailable('CONTEXT_CHANGED', '评估期间账号绑定或身份配置发生变化。')
const backgroundDisabled = unavailable('BACKGROUND_DISABLED', '评估期间后台开关、外部模型或 Newbi 接入点发生变化。')

const glossaryHistory = {
  learnedTerms: { select: authorTermSelect, orderBy: { term: 'asc' as const } },
  sectionGlossarySamples: { select: sectionSampleSelect, orderBy: { term: 'asc' as const } },
}

function assessmentView(row: Prisma.NewbiDiscussionAssessmentGetPayload<{ include: typeof glossaryHistory }>, now = Date.now()) {
  return newbiAssessmentView.parse({ ...row, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
    origin: row.triggerSeq === null ? 'ADMIN' : 'BACKGROUND',
    glossaryUsed: row.glossaryUsed ?? [], glossaryLearned: row.learnedTerms.map((term) => ({ ...term, version: 1 })),
    sectionGlossarySamples: row.sectionGlossarySamples.map((term) => ({ ...term, version: 1 })),
    result: row.result ?? (now - row.createdAt.getTime() >= leaseMs ? timedOut : { status: 'PENDING' }) })
}

async function boundAccount(tx: Prisma.TransactionClient, scope: Pick<Scope, 'characterId'>, id: string) {
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

async function lockAssessmentScope(tx: Prisma.TransactionClient, scope: AssessmentScope) {
  if ('actor' in scope) await authorize(tx, scope)
  await lockCharacter(tx, scope.characterId)
  if ('actor' in scope) await authorize(tx, scope)
}

export async function claimNewbiAssessment(tx: Prisma.TransactionClient, scope: Scope, accountId: string, postId: string) {
  const account = await boundAccount(tx, scope, accountId)
  if (!active(account)) throw new ManagementError(409, 'STATE_CONFLICT', 'Newbi account is inactive')
  const [event] = await tx.$queryRaw<{ seq: string }[]>`
    SELECT seq FROM rica_plugin_newbi.events
    WHERE account_id = ${accountId}::uuid AND post_id = ${postId}::uuid AND occurred_at > ${new Date(Date.now() - retentionMs)}
    LIMIT 1`
  if (!event) throw new ManagementError(404, 'NOT_FOUND', 'Newbi discussion has no current event')
  return createAssessment(tx, scope.characterId, account, postId)
}

async function createAssessment(tx: Prisma.TransactionClient, characterId: string,
  account: Awaited<ReturnType<typeof boundAccount>>, postId: string, triggerSeq?: string) {
  const accountId = account.id
  const binding = { characterId, accountId, postId, identityId: account.identityId,
    bindingVersion: account.bindingVersion, authEpoch: account.identity.character.authEpoch }
  // The management command holds the character lock while reserving an attempt.
  const pending = await tx.newbiDiscussionAssessment.findFirst({ where: { ...binding, result: { equals: Prisma.DbNull },
    createdAt: { gt: new Date(Date.now() - leaseMs) } }, select: { id: true } })
  if (pending) return { id: pending.id, status: 'PENDING' }
  const profile = identityProfile.pick({ displayName: true, participation: true, writingPrompt: true }).strip()
    .parse(account.identity.activeProfile?.roleProfile ?? {})
  const row = await tx.newbiDiscussionAssessment.create({ data: { ...binding, triggerSeq,
    identity: profile.displayName ?? account.identity.slug,
    participation: resolveParticipation(profile.participation, profile.writingPrompt) }, select: { id: true } })
  return { id: row.id, status: 'STARTED' }
}

export type BackgroundDiscussion = { characterId: string; accountId: string; postId: string; seq: string }

export function backgroundDiscussions(endpoint: string, target?: Pick<BackgroundDiscussion, 'accountId' | 'postId'>) {
  const filter = target ? Prisma.sql`AND a.id = ${target.accountId}::uuid AND e.post_id = ${target.postId}::uuid` : Prisma.empty
  return Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON (e.account_id, e.post_id) a.character_id, e.account_id, e.post_id, e.seq, e.received_at
      FROM rica_plugin_newbi.events e
      JOIN public.platform_accounts a ON a.id = e.account_id
      JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
      JOIN public.characters c ON c.id = a.character_id
      WHERE a.platform = 'newbi' AND a.instance_key = ${endpoint}
        AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
        AND e.received_at > statement_timestamp() - interval '1 hour'
        AND e.occurred_at > statement_timestamp() - interval '1 hour'
        AND e.occurred_at <= statement_timestamp() + interval '1 minute'
        AND e.comment_id IS NOT NULL ${filter}
      ORDER BY e.account_id, e.post_id, e.received_at DESC, e.occurred_at DESC, length(e.seq) DESC, e.seq DESC
    )
    SELECT e.character_id AS "characterId", e.account_id AS "accountId", e.post_id AS "postId", e.seq
    FROM latest e
    WHERE e.received_at <= statement_timestamp() - interval '30 seconds'
      AND NOT EXISTS (
        SELECT 1 FROM public.newbi_discussion_assessments r
        WHERE r.account_id = e.account_id AND r.post_id = e.post_id
          AND (r.created_at >= e.received_at OR r.created_at > statement_timestamp() - interval '5 minutes')
      )
    ORDER BY e.received_at ASC, e.account_id, e.post_id
    LIMIT 4
  `
}

export async function claimBackgroundAssessment(db: PrismaClient, endpoint: string, target: BackgroundDiscussion) {
  const { characterId, accountId, postId } = target
  return db.$transaction(async (tx) => {
    await lockCharacter(tx, characterId)
    const [latest] = await tx.$queryRaw<BackgroundDiscussion[]>(backgroundDiscussions(endpoint, target))
    if (latest?.seq !== target.seq || latest.characterId !== characterId) return
    const account = await boundAccount(tx, { characterId }, accountId)
    const assessment = await createAssessment(tx, characterId, account, postId, target.seq)
    if (assessment.status !== 'STARTED') return
    await tx.managementAudit.create({ data: { characterId, actorId: 'system:newbi-background', operation: 'newbi.discussion.assess.auto',
      targetId: assessment.id, requestId: assessment.id, digest: createHash('sha256').update(JSON.stringify({ accountId, postId, seq: target.seq })).digest('hex') } })
    return assessment.id
  })
}

export async function listNewbiAssessments(db: PrismaClient, scope: Scope, accountId: string, postId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    await boundAccount(tx, scope, accountId)
    const rows = await tx.newbiDiscussionAssessment.findMany({
      where: { characterId: scope.characterId, accountId, postId, createdAt: { gt: new Date(Date.now() - retentionMs) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10,
      include: glossaryHistory,
    })
    return { items: rows.map((row) => assessmentView(row)) }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readNewbiAssessment(db: PrismaClient, scope: Scope, id: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const row = await tx.newbiDiscussionAssessment.findFirst({
      where: { id, characterId: scope.characterId, createdAt: { gt: new Date(Date.now() - retentionMs) } },
      include: glossaryHistory,
    })
    if (!row) throw new ManagementError(404, 'NOT_FOUND', 'Newbi discussion assessment not found')
    return assessmentView(row)
  }, { isolationLevel: 'RepeatableRead' })
}

export function newbiAssessmentActivity(characterId: string) {
  return Prisma.sql`
    SELECT r.id, 'ASSESSMENT'::text AS kind, a.platform, r.identity,
      coalesce(nullif(c.username, ''), a.remote_account_id) AS account, r.account_id,
      coalesce(r.result->>'status', CASE WHEN r.created_at > ${new Date(Date.now() - leaseMs)}::timestamptz
        THEN 'PENDING' ELSE 'UNAVAILABLE' END) AS state, r.created_at
    FROM public.newbi_discussion_assessments r
    JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
    LEFT JOIN rica_plugin_newbi.account_profiles c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
    WHERE r.character_id = ${characterId}::uuid AND r.created_at > ${new Date(Date.now() - retentionMs)}::timestamptz
  `
}

export async function runNewbiAssessment(db: PrismaClient, scope: AssessmentScope, id: string,
  readThread: ((target: DiscussionTarget) => Promise<Thread | undefined>) | undefined,
  assess: AssessDiscussion | undefined, requireConnector: (endpoint: string) => Promise<void>,
) {
  const where = { id, characterId: scope.characterId }
  const initial = await db.$transaction(async (tx) => {
    if ('actor' in scope) await authorize(tx, scope)
    const row = await tx.newbiDiscussionAssessment.findUniqueOrThrow({ where })
    const account = await boundAccount(tx, scope, row.accountId)
    const received = 'background' in scope ? Prisma.sql`AND received_at <= ${row.createdAt}` : Prisma.empty
    const [events, receipts] = await Promise.all([
      tx.$queryRaw<{ commentId: string | null; type: string }[]>`
        SELECT comment_id AS "commentId", type FROM rica_plugin_newbi.events
        WHERE account_id = ${row.accountId}::uuid AND post_id = ${row.postId}::uuid
          AND occurred_at > ${new Date(Date.now() - retentionMs)} ${received}
        ORDER BY occurred_at DESC, seq DESC LIMIT 20`,
      tx.newbiReply.findMany({ where: { characterId: scope.characterId, accountId: row.accountId, postId: row.postId,
        status: 'SENT', remoteCommentId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 50, select: { remoteCommentId: true } }),
    ])
    return { row, account, events, receipts }
  }, { isolationLevel: 'RepeatableRead' })
  const { row, account, events, receipts } = initial
  const cutoff = new Date(Date.now() - retentionMs)
  let saveLearning: ((tx: Prisma.TransactionClient) => Promise<void>) | undefined

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
    const glossary = await prepareDiscussionGlossary(db, row.accountId, thread, comments, cutoff)
    const input: DiscussionSelectionInput = { title: thread.post.title.slice(0, 240), post: thread.post.content.slice(0, 1800),
      participation: resolveParticipation(row.participation), identityPreferences: profile.writingPrompt, comments,
      ...(glossary?.used.length ? { glossary: glossary.used } : {}),
      ...(glossary?.canLearn ? { learnGlossary: true } : {}),
    }
    const selection = await assess?.(input, profile.draftModelProfile,
      { characterId: row.characterId, identityId: row.identityId, platform: 'newbi' }, async (systemPrompt, model) => {
        if ('background' in scope) await requireConnector(account.instanceKey)
        await db.$transaction(async (tx) => {
          await lockAssessmentScope(tx, scope)
          if (!matches(row, await boundAccount(tx, scope, row.accountId))) throw new Error('Assessment binding changed')
          const { count } = await tx.newbiDiscussionAssessment.updateMany({
            where: { ...where, result: { equals: Prisma.DbNull }, systemPrompt: null,
              createdAt: { gt: new Date(Date.now() - leaseMs) } }, data: { systemPrompt, model, glossaryUsed: glossary?.used ?? [] },
          })
          if (!count) throw new Error('Assessment no longer accepts a model call')
        })
      }).catch(() => undefined)
    if (selection === undefined) return unavailable('MODEL_UNAVAILABLE', '没有可用的评估模型，或模型调用失败。')
    const response = z.looseObject({ glossaryCandidates: z.unknown().optional() }).safeParse(selection).data
    const { glossaryCandidates, ...decisionFields } = response ?? {}
    const decision = discussionSelection.safeParse(decisionFields).data
    if (!decision || (decision.status === 'SUGGEST_REPLY' && !comments.some(({ id, eligible }) => id === decision.commentId && eligible))) {
      return unavailable('INVALID_SELECTION', '评估结果没有指向本轮可回应的评论。')
    }
    if (glossary?.canLearn) saveLearning = (tx) => glossary.save(tx, row, glossaryCandidates)
    if (decision.status === 'SUGGEST_REPLY') {
      const comment = byId.get(decision.commentId)!
      return { ...decision, target: { author: comment.author.username.slice(0, 64), excerpt: comment.content.slice(0, 220) } }
    }
    return decision
  }

  const result = await evaluate()
  const enabled = !('background' in scope) || await requireConnector(account.instanceKey).then(() => true, () => false)
  await db.$transaction(async (tx) => {
    await lockAssessmentScope(tx, scope)
    const current = await boundAccount(tx, scope, row.accountId)
    const valid = Date.now() - row.createdAt.getTime() < leaseMs
    const unchanged = matches(row, current)
    const completed = !valid ? timedOut : !enabled ? backgroundDisabled : unchanged ? result : contextChanged
    const { count } = await tx.newbiDiscussionAssessment.updateMany({ where: { ...where, result: { equals: Prisma.DbNull } },
      data: { result: completed, finishedAt: new Date() } })
    if (count && valid && enabled && unchanged) await saveLearning?.(tx)
  })
}

export type { AssessDiscussion }
