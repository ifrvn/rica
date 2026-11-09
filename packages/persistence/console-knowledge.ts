import type { z } from '@hono/zod-openapi'
import type { conversationListQuery, memberListQuery } from '../contracts/management.js'
import type { ManagementRole, Prisma, PrismaClient } from './generated/client.js'
import { authorize, makePage, ManagementError, pageArgs, parsePage, type Page, type Scope } from './management.js'

function missing(): never { throw new ManagementError(404, 'NOT_FOUND', 'Resource not found') }

export async function listMembers(db: PrismaClient, scope: Scope, query: z.infer<typeof memberListQuery>) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const { limit } = parsePage(query)
    const rows = await tx.$queryRaw<{ subject: string; roles: ManagementRole[] }[]>`
      SELECT subject, array_agg(role::text ORDER BY role) AS roles
      FROM public.management_memberships
      WHERE character_id = ${scope.characterId}::uuid AND issuer = ${scope.actor.issuer}
        AND (${query.after ?? null}::text IS NULL OR subject > ${query.after ?? null}::text)
      GROUP BY subject ORDER BY subject
      LIMIT ${limit + 1}
    `
    const items = rows.slice(0, limit)
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.subject : null }
  }, { isolationLevel: 'RepeatableRead' })
}

async function requireIdentity(tx: Prisma.TransactionClient, characterId: string, identityId: string) {
  if (!await tx.identity.findFirst({ where: { id: identityId, characterId }, select: { id: true } })) missing()
}

export async function listConversationOptions(db: PrismaClient, scope: Scope, identityId: string, query: z.infer<typeof conversationListQuery>) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN'])
    const { characterId } = scope
    const { accountId, channel } = query
    if (!await tx.platformAccount.findFirst({ where: { id: accountId, characterId, identityId }, select: { id: true } })) missing()
    const where = { characterId, identityId, accountId, channel }
    const page = parsePage(query)
    if (page.cursor && !await tx.conversation.findFirst({ where: { ...where, id: page.cursor }, select: { id: true } })) {
      throw new ManagementError(422, 'INVALID_INPUT', 'Invalid cursor')
    }
    const rows = await tx.conversation.findMany({ where: { ...where, id: { gt: page.cursor } },
      orderBy: { id: 'asc' }, take: page.limit + 1, select: { id: true, channel: true, privateContactId: true } })
    return makePage(rows, page, (row) => row)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listIdentityContacts(db: PrismaClient, scope: Scope, identityId: string, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    await requireIdentity(tx, scope.characterId, identityId)
    const where = { characterId: scope.characterId, identityId }
    const args = await pageArgs(page, (id) => tx.contact.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.contact.findMany({ ...args, where, select: {
      id: true, accountId: true, displayLabel: true, boundaryVersion: true, noContactAt: true,
    } })
    return makePage(rows, page, ({ id, accountId, displayLabel, boundaryVersion, noContactAt }) => ({
      id, accountId, label: displayLabel, version: boundaryVersion, blocked: !!noContactAt,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listIdentityBeliefs(db: PrismaClient, scope: Scope, identityId: string, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    await requireIdentity(tx, scope.characterId, identityId)
    const { cursor, limit } = page
    const rows = await tx.$queryRaw<{ id: string; version: number; kind: 'OPINION' | 'PREFERENCE' }[]>`
      SELECT DISTINCT ON (belief_id) belief_id AS id, version, kind
      FROM public.belief_versions
      WHERE character_id = ${scope.characterId}::uuid AND identity_id = ${identityId}::uuid
        AND (${cursor ?? null}::uuid IS NULL OR belief_id > ${cursor ?? null}::uuid)
      ORDER BY belief_id, version DESC
      LIMIT ${limit + 1}
    `
    return makePage(rows, page, (row) => row)
  }, { isolationLevel: 'RepeatableRead' })
}
