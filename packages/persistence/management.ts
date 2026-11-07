import { createHash, randomUUID } from 'node:crypto'
import type { commitmentInput, commitmentQuery, commitmentUpdate } from '../contracts/commitments.js'
import type { z } from '@hono/zod-openapi'
import { contactBoundaryView, coreProfile, dailyEnergyView, identityProfile, memoryProvenanceView } from '../contracts/management.js'
import type * as contracts from '../contracts/management.js'
import type { scheduleInput, scheduleUpdate } from '../contracts/schedules.js'
import { dailyScheduleSlot } from './simulation-schedules.js'
import type { ManagementRole, Prisma, PrismaClient } from './generated/client.js'

type Subject = Readonly<{ issuer: string; subject: string; id: string }>
type Tx = Prisma.TransactionClient
type CommandResult = { id: string; status?: string; version?: number; authEpoch?: number }
type Input<T extends z.ZodType> = z.infer<T>

export class ManagementError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 412 | 422 | 428,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function unavailable(): never {
  throw new ManagementError(404, 'NOT_FOUND', 'Resource not found')
}

function invalid(message: string): never {
  throw new ManagementError(422, 'INVALID_INPUT', message)
}

export function denyPermission(): never {
  throw new ManagementError(403, 'FORBIDDEN', 'Permission denied')
}

export type Scope = Readonly<{ actor: Subject; characterId: string }>

export async function authorize(tx: Tx, scope: Scope, roles: readonly ManagementRole[] = []) {
  const members = await tx.managementMembership.findMany({
    where: { characterId: scope.characterId, issuer: scope.actor.issuer, subject: scope.actor.subject },
    select: { role: true },
  })
  if (members.length === 0) unavailable()
  if (roles.length && !members.some(({ role }) => roles.includes(role))) denyPermission()
  return members
}

async function lockCharacter(tx: Tx, characterId: string) {
  const [character] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public.characters WHERE id = ${characterId}::uuid FOR UPDATE
  `
  if (!character) unavailable()
}

type Command = {
  actor: Subject
  characterId?: string
  operation: string
  requestId: string
  input: unknown
  targetScope: string
  key?: string
  roles?: readonly ManagementRole[]
}

export async function executeManagementCommand(
  db: PrismaClient, command: Command, apply: (tx: Tx) => Promise<CommandResult>,
) {
  const { actor, characterId, operation, requestId, input, key, targetScope, roles = ['ADMIN'] } = command
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const routeScope = operation + ':' + targetScope

  return db.$transaction(async (tx) => {
    if (key) {
      // Scope the lock to the same tuple as the unique idempotency key.
      const lock = JSON.stringify([actor.id, routeScope, key])
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`
    }
    if (characterId) {
      // Check membership again after taking the same lock as role provisioning and revocation.
      await authorize(tx, { actor, characterId }, roles)
      await lockCharacter(tx, characterId)
      await authorize(tx, { actor, characterId }, roles)
    }

    const selector = key ? { principalId: actor.id, routeScope, key } : null
    const unique = selector ? { principalId_routeScope_key: selector } : null
    if (unique) {
      const previous = await tx.managementIdempotency.findUnique({ where: unique })
      if (previous && previous.expiresAt > new Date()) {
        if (previous.requestHash !== digest) {
          throw new ManagementError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different input')
        }
        return previous.response as CommandResult
      }
    }

    const result = await apply(tx)
    await tx.managementAudit.create({
      data: { characterId: characterId ?? result.id, actorId: actor.id, operation, targetId: result.id, requestId, digest },
    })
    if (unique && selector) {
      const data = { requestHash: digest, response: result, expiresAt: new Date(Date.now() + 86_400_000) }
      await tx.managementIdempotency.upsert({ where: unique, create: { ...selector, ...data }, update: data })
    }
    return result
  }, { isolationLevel: 'ReadCommitted' })
}

function checkVersion(actual: number | null, expected: number) {
  if ((actual ?? 0) !== expected) throw new ManagementError(412, 'STALE_VERSION', 'Resource version has changed')
}

async function advanceEpoch(tx: Tx, characterId: string) {
  const { authEpoch } = await tx.character.update({
    where: { id: characterId }, data: { authEpoch: { increment: 1 } }, select: { authEpoch: true },
  })
  return authEpoch
}

export async function createCharacter(tx: Tx, actor: Subject, input: Input<typeof contracts.characterInput>) {
  const { slug, timezone, coreProfile } = input
  const { id, status } = await tx.character.create({ data: { slug, timezone }, select: { id: true, status: true } })
  await tx.coreVersion.create({
    data: { characterId: id, version: 1, hardProfile: coreProfile, actorId: actor.id, reason: 'Create character' },
  })
  await tx.character.update({ where: { id }, data: { activeCoreVersion: 1 } })
  await tx.managementMembership.create({
    data: { characterId: id, issuer: actor.issuer, subject: actor.subject, role: 'ADMIN' },
  })
  return { id, status, version: 1 }
}

export async function updateCore(tx: Tx, scope: Scope, expected: number, input: Input<typeof contracts.coreInput>) {
  const { actor, characterId } = scope
  const character = await tx.character.findUniqueOrThrow({ where: { id: characterId }, select: { activeCoreVersion: true } })
  checkVersion(character.activeCoreVersion, expected)
  const latest = await tx.coreVersion.findFirst({
    where: { characterId }, orderBy: { version: 'desc' }, select: { version: true },
  })
  const version = (latest?.version ?? 0) + 1
  await tx.coreVersion.create({
    data: { characterId, version, hardProfile: input.coreProfile, actorId: actor.id, reason: input.reason },
  })
  const { authEpoch } = await tx.character.update({
    where: { id: characterId }, data: { activeCoreVersion: version, authEpoch: { increment: 1 } },
    select: { authEpoch: true },
  })
  return { id: characterId, version, authEpoch }
}

export async function createIdentity(tx: Tx, scope: Scope, input: Input<typeof contracts.identityInput>) {
  const { actor, characterId } = scope
  const { id, status } = await tx.identity.create({
    data: { characterId, slug: input.slug }, select: { id: true, status: true },
  })
  await tx.identityVersion.create({
    data: { characterId, identityId: id, version: 1, roleProfile: input.roleProfile, actorId: actor.id, reason: 'Create identity' },
  })
  await tx.identity.update({ where: { id }, data: { activeVersion: 1 } })
  return { id, status, version: 1 }
}

export async function updateIdentity(
  tx: Tx, scope: Scope, id: string, expected: number, input: Input<typeof contracts.identityUpdate>,
) {
  const { actor, characterId } = scope
  const identity = await tx.identity.findFirst({ where: { id, characterId }, select: { activeVersion: true } })
  if (!identity) unavailable()
  checkVersion(identity.activeVersion, expected)
  const latest = await tx.identityVersion.findFirst({
    where: { characterId, identityId: id }, orderBy: { version: 'desc' }, select: { version: true },
  })
  const version = (latest?.version ?? 0) + 1
  await tx.identityVersion.create({
    data: { characterId, identityId: id, version, roleProfile: input.roleProfile, actorId: actor.id, reason: input.reason },
  })
  await tx.identity.update({ where: { id }, data: { activeVersion: version } })
  return { id, version, authEpoch: await advanceEpoch(tx, characterId) }
}

export async function createAccount(tx: Tx, scope: Scope, input: Input<typeof contracts.accountInput>) {
  const { characterId } = scope
  if (!await tx.identity.findFirst({ where: { characterId, id: input.identityId }, select: { id: true } })) unavailable()
  const account = await tx.platformAccount.create({
    data: { ...input, characterId, status: 'PAUSED' },
    select: { id: true, status: true, bindingVersion: true },
  })
  return { id: account.id, status: account.status, version: account.bindingVersion }
}

export async function control(tx: Tx, scope: Scope, input: Input<typeof contracts.controlInput>) {
  const { characterId } = scope
  const { scopeId: id, operation } = input
  const entityStatus = operation === 'RESUME' ? 'ACTIVE' : 'PAUSED'
  if (input.scope === 'ACCOUNT') {
    const account = await tx.platformAccount.findFirst({ where: { characterId, id }, select: { status: true, platform: true } })
    if (!account) unavailable()
    if (account.status === 'REVOKED' || (operation === 'RESUME' && account.status !== 'PAUSED' && account.status !== 'ACTIVE')) {
      throw new ManagementError(409, 'STATE_CONFLICT', 'Account cannot perform this transition')
    }
    if (operation === 'RESUME' && account.platform !== 'mock-a' && account.platform !== 'mock-b') {
      throw new ManagementError(409, 'STATE_CONFLICT', 'Account must complete platform authorization')
    }
    // Pausing a reauthentication or pending account must not make it eligible for activation.
    if (operation === 'PAUSE' && account.status !== 'ACTIVE' && account.status !== 'PAUSED') {
      throw new ManagementError(409, 'STATE_CONFLICT', 'Account cannot perform this transition')
    }
    const status = operation === 'REVOKE_ACCOUNT' ? 'REVOKED' : entityStatus
    const { bindingVersion } = await tx.platformAccount.update({
      where: { id }, data: { status, bindingVersion: { increment: 1 } }, select: { bindingVersion: true },
    })
    return { id, status, version: bindingVersion, authEpoch: await advanceEpoch(tx, characterId) }
  }
  if (operation === 'REVOKE_ACCOUNT') invalid('Only an account can be revoked')
  if (input.scope === 'IDENTITY') {
    const identity = await tx.identity.findFirst({ where: { id, characterId }, select: { activeVersion: true } })
    if (!identity) unavailable()
    if (entityStatus === 'ACTIVE' && identity.activeVersion === null) invalid('Identity has no active configuration')
    await tx.identity.update({ where: { id }, data: { status: entityStatus } })
    return { id, status: entityStatus, authEpoch: await advanceEpoch(tx, characterId) }
  }
  if (id !== characterId) unavailable()
  const character = await tx.character.findUniqueOrThrow({ where: { id }, select: { activeCoreVersion: true } })
  if (entityStatus === 'ACTIVE' && character.activeCoreVersion === null) invalid('Character has no active configuration')
  const { authEpoch } = await tx.character.update({
    where: { id }, data: { status: entityStatus, authEpoch: { increment: 1 } }, select: { authEpoch: true },
  })
  return { id, status: entityStatus, authEpoch }
}

export async function changeMembership(tx: Tx, scope: Scope, input: Input<typeof contracts.membershipInput>) {
  const { characterId, actor } = scope
  const where = { characterId, issuer: actor.issuer, subject: input.subject, role: input.role }
  if (input.action === 'GRANT') {
    await tx.managementMembership.create({ data: where })
  } else {
    const existing = await tx.managementMembership.findUnique({
      where: { characterId_issuer_subject_role: where },
      select: { role: true },
    })
    if (!existing) unavailable()
    if (input.role === 'ADMIN' && await tx.managementMembership.count({ where: { characterId, role: 'ADMIN' } }) <= 1) {
      throw new ManagementError(409, 'LAST_ADMIN', 'Character must retain an administrator')
    }
    await tx.managementMembership.delete({ where: { characterId_issuer_subject_role: where } })
  }
  return { id: characterId }
}

export async function createGrant(tx: Tx, scope: Scope, input: Input<typeof contracts.memoryGrantInput>) {
  const { characterId, actor } = scope
  const { memoryId, recipientIdentityId, recipientAccountId, recipientConversationId, recipientContactId,
    purpose, audience, reason } = input
  const validFrom = new Date(input.validFrom)
  const validUntil = new Date(input.validUntil)
  if (validFrom >= validUntil || validUntil <= new Date()) invalid('Grant validity window is invalid')

  const memory = await tx.memory.findFirst({
    where: { id: memoryId, characterId },
    select: { status: true, visibility: true, expiresAt: true },
  })
  if (!memory) unavailable()
  if (memory.status !== 'ACTIVE' || (memory.expiresAt && memory.expiresAt <= new Date())
    || !['PUBLIC', 'PERSONAL'].includes(memory.visibility)) invalid('Memory cannot be shared')
  if (!await tx.identity.findFirst({ where: { characterId, id: recipientIdentityId }, select: { id: true } })) unavailable()
  if (recipientAccountId && !await tx.platformAccount.findFirst({
    where: { characterId, id: recipientAccountId, identityId: recipientIdentityId },
    select: { id: true },
  })) unavailable()

  if (purpose === 'PUBLIC_REFERENCE') {
    if (memory.visibility !== 'PUBLIC' || !audience || !recipientAccountId) invalid('Public reference requires a public memory and bound audience')
    if (!await tx.conversation.findFirst({
      where: { id: audience, characterId, identityId: recipientIdentityId, accountId: recipientAccountId, channel: 'PUBLIC' },
      select: { id: true },
    })) unavailable()
  } else if (audience) invalid('Only a public reference has a public audience')
  if (purpose === 'PRIVATE_REPLY') {
    if (!recipientAccountId || !recipientConversationId || !recipientContactId) invalid('Private reply requires an exact recipient')
    if (!await tx.conversation.findFirst({
      where: { id: recipientConversationId, characterId, identityId: recipientIdentityId,
        accountId: recipientAccountId, channel: 'PRIVATE', privateContactId: recipientContactId },
      select: { id: true },
    })) unavailable()
  } else if (recipientConversationId || recipientContactId) invalid('Only a private reply has a private recipient')

  const { id } = await tx.memoryGrant.create({
    data: { characterId, memoryId, recipientIdentityId, recipientAccountId, recipientConversationId,
      recipientContactId, purpose, audience, reason, validFrom, validUntil, approvedBy: actor.id },
    select: { id: true },
  })
  return { id, authEpoch: await advanceEpoch(tx, characterId) }
}

export async function revokeGrant(tx: Tx, scope: Scope, id: string) {
  const { characterId } = scope
  const existing = await tx.memoryGrant.findFirst({ where: { id, characterId }, select: { revokedAt: true } })
  if (!existing) unavailable()
  if (existing.revokedAt) throw new ManagementError(409, 'STATE_CONFLICT', 'Grant is already revoked')
  await tx.memoryGrant.update({ where: { id }, data: { revokedAt: new Date() }, select: { id: true } })
  return { id, authEpoch: await advanceEpoch(tx, characterId) }
}

type Page = { limit: number; cursor?: string }

export function parsePage(input: Input<typeof contracts.listQuery>): Page {
  return { limit: Number(input.limit ?? 25), cursor: input.cursor }
}

async function pageArgs({ limit, cursor }: Page, visible: (id: string) => Promise<unknown>) {
  if (cursor && !await visible(cursor)) invalid('Invalid cursor')
  // Resolve the native timestamp through its row to preserve PostgreSQL microseconds.
  return {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  }
}

function makePage<T extends { id: string }, View>(rows: T[], { limit }: Page, view: (row: T) => View) {
  const items = rows.slice(0, limit).map(view)
  const last = rows.length > limit ? rows[limit - 1] : undefined
  const nextCursor = last?.id ?? null
  return { items, nextCursor }
}

const characterSelect = {
  id: true, slug: true, status: true, timezone: true, activeCoreVersion: true, createdAt: true,
  activeCore: { select: { hardProfile: true } },
} satisfies Prisma.CharacterSelect

function characterView({ id, slug, status, timezone, activeCoreVersion, activeCore }: Prisma.CharacterGetPayload<{ select: typeof characterSelect }>) {
  return { id, slug, status, timezone, version: activeCoreVersion,
    profile: coreProfile.strip().safeParse(activeCore?.hardProfile).data ?? null }
}

export async function listCharacters(db: PrismaClient, actor: Subject, page: Page) {
  const where = { managementMemberships: { some: { issuer: actor.issuer, subject: actor.subject } } }
  return db.$transaction(async (tx) => {
    const args = await pageArgs(page, (id) => tx.character.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.character.findMany({ ...args, where, select: characterSelect })
    return makePage(rows, page, characterView)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function getCharacter(db: PrismaClient, scope: Scope) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const row = await tx.character.findUnique({ where: { id: scope.characterId }, select: characterSelect })
    if (!row) unavailable()
    return characterView(row)
  })
}

const publicIdentityProfile = identityProfile.omit({ stateRule: true, autonomousGoal: true, duplicateReview: true }).strip()

export async function listIdentities(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    const members = await authorize(tx, scope)
    const profile = members.some(({ role }) => role === 'ADMIN' || role === 'AUDITOR')
      ? identityProfile.strip() : publicIdentityProfile
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.identity.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.identity.findMany({
      ...args, where,
      select: { id: true, slug: true, status: true, activeVersion: true, createdAt: true,
        activeProfile: { select: { roleProfile: true } } },
    })
    return makePage(rows, page, ({ id, slug, status, activeVersion, activeProfile }) => ({
      id, slug, status, version: activeVersion,
      profile: profile.safeParse(activeProfile?.roleProfile).data ?? null,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listAccounts(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.platformAccount.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.platformAccount.findMany({
      ...args, where,
      select: { id: true, identityId: true, platform: true, instanceKey: true, status: true, bindingVersion: true, createdAt: true },
    })
    return makePage(rows, page, ({ bindingVersion, createdAt: _, ...view }) => ({ ...view, version: bindingVersion }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readAutomationEligibility(db: PrismaClient, scope: Scope, accountId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const account = await tx.platformAccount.findFirst({
      where: { id: accountId, characterId: scope.characterId },
      select: { id: true, identityId: true, bindingVersion: true, platform: true, status: true, identity: {
        select: { status: true, activeVersion: true, character: { select: { status: true, activeCoreVersion: true } } },
      } },
    })
    if (!account) unavailable()
    const { identity } = account
    const active = account.status === 'ACTIVE' && identity.status === 'ACTIVE' && identity.activeVersion !== null
      && identity.character.status === 'ACTIVE' && identity.character.activeCoreVersion !== null
    const simulated = account.platform === 'mock-a' || account.platform === 'mock-b'
    return {
      accountId: account.id, identityId: account.identityId, bindingVersion: account.bindingVersion, eligible: false,
      reasons: [
        ...(active ? [] : ['BINDING_INACTIVE']),
        simulated ? 'SIMULATION_ONLY' : 'UNSUPPORTED_ADAPTER',
        'EXTERNAL_AUTO_DISABLED',
      ],
    }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readDailyEnergy(db: PrismaClient, scope: Scope, day: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_read_daily_energy(${scope.characterId}::uuid, ${day}::date) AS view
    `
    if (!row?.view) unavailable()
    return dailyEnergyView.parse(row.view)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function approveDailyEnergy(tx: Tx, scope: Scope, input: Input<typeof contracts.dailyEnergyInput>) {
  const [row] = await tx.$queryRaw<{ outcome: string }[]>`
    SELECT public.rica_approve_daily_energy(${scope.characterId}::uuid, ${input.utcDay}::date,
      ${input.energy}, ${scope.actor.id}, ${input.reason}) AS outcome
  `
  if (row.outcome === 'DAY_NOT_FUTURE') invalid('A projection must be approved before its UTC day begins')
  if (row.outcome === 'DAY_EXISTS') throw new ManagementError(409, 'DAY_EXISTS', 'This UTC day already has a projection')
  return { id: row.outcome }
}

export async function readIdentityReflection(db: PrismaClient, scope: Scope, identityId: string, day: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_read_identity_reflection(${scope.characterId}::uuid, ${identityId}::uuid, ${day}::date) AS view
    `
    if (!row?.view) unavailable()
    return row.view
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readBelief(db: PrismaClient, scope: Scope, identityId: string, beliefId: string, revision?: number) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_read_belief(${scope.characterId}::uuid, ${identityId}::uuid,
        ${beliefId}::uuid, ${revision ?? null}::int) AS view
    `
    if (!row?.view) unavailable()
    return row.view
  }, { isolationLevel: 'RepeatableRead' })
}

export async function writeBelief(tx: Tx, scope: Scope, identityId: string, beliefId: string, expected: number,
  input: Input<typeof contracts.beliefInput> | Input<typeof contracts.beliefRestoreInput>) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT public.rica_write_belief(${scope.characterId}::uuid, ${identityId}::uuid,
      ${beliefId}::uuid, ${expected}::int, ${JSON.stringify(input)}::jsonb, ${scope.actor.id}) AS status
  `
  if (row.status === 'MISSING') unavailable()
  if (row.status === 'STALE') throw new ManagementError(412, 'STALE_VERSION', 'Resource version has changed')
  if (row.status === 'KIND') invalid('Belief kind cannot be changed')
  if (row.status === 'EVIDENCE') invalid('Evidence must be current and available at identity scope')
  if (row.status === 'DUPLICATE_SOURCE') invalid('Each origin source may be submitted once per revision')
  if (row.status === 'RESTORE_BLOCKED') {
    throw new ManagementError(409, 'BELIEF_RESTORE_BLOCKED', 'Revision is not restorable with its current evidence')
  }
  return { id: beliefId, version: expected + 1, status: row.status }
}

export async function readManualGoals(db: PrismaClient, scope: Scope, identityId: string,
  goalId?: string, revision?: number) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_read_manual_goals(${scope.characterId}::uuid, ${identityId}::uuid,
        ${goalId ?? null}::uuid, ${revision ?? null}::int) AS view
    `
    if (!row?.view) unavailable()
    return row.view
  }, { isolationLevel: 'RepeatableRead' })
}

export async function writeManualGoal(tx: Tx, scope: Scope, identityId: string, goalId: string, expected: number,
  input: Input<typeof contracts.manualGoalInput>) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT public.rica_write_manual_goal(${scope.characterId}::uuid, ${identityId}::uuid,
      ${goalId}::uuid, ${expected}::int, ${JSON.stringify(input)}::jsonb, ${scope.actor.id}) AS status
  `
  if (row.status === 'MISSING') unavailable()
  if (row.status === 'STALE') throw new ManagementError(412, 'STALE_VERSION', 'Resource version has changed')
  if (row.status === 'SELF_MANAGED') {
    throw new ManagementError(409, 'GOAL_SELF_MANAGED', 'An autonomous goal can only be canceled')
  }
  if (row.status === 'LIMIT') throw new ManagementError(409, 'GOAL_LIMIT', 'An identity can have at most three active goals')
  if (row.status !== 'UPDATED') throw new ManagementError(409, 'GOAL_CLOSED', 'Goal is closed or past its deadline')
  return { id: goalId, version: expected + 1 }
}

export async function readContactBoundary(db: PrismaClient, scope: Scope, contactId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_read_contact_boundary(${scope.characterId}::uuid, ${contactId}::uuid) AS view
    `
    if (!row?.view) unavailable()
    return contactBoundaryView.parse(row.view)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function changeContactBoundary(tx: Tx, scope: Scope, contactId: string, expected: number,
  input: Input<typeof contracts.contactBoundaryInput>) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT public.rica_change_contact_boundary(${scope.characterId}::uuid, ${contactId}::uuid,
      ${expected}::int, ${input.blocked}, ${input.reason}) AS status
  `
  if (row.status === 'MISSING') unavailable()
  if (row.status === 'STALE') throw new ManagementError(412, 'STALE_VERSION', 'Resource version has changed')
  return { id: contactId, version: expected + Number(row.status === 'UPDATED') }
}

export async function readMemoryProvenance(db: PrismaClient, scope: Scope, memoryId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_memory_provenance(${scope.characterId}::uuid, ${memoryId}::uuid) AS view
    `
    if (!row?.view) unavailable()
    return memoryProvenanceView.parse(row.view)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function correctMemory(tx: Tx, scope: Scope, memoryId: string, expected: number,
  input: Input<typeof contracts.memoryCorrectionInput>) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT public.rica_correct_memory(${scope.characterId}::uuid, ${memoryId}::uuid,
      ${expected}::int, ${input.content}, ${scope.actor.id}, ${input.reason}) AS status
  `
  if (row.status === 'MISSING') unavailable()
  if (row.status === 'STALE') throw new ManagementError(412, 'STALE_VERSION', 'Resource version has changed')
  if (row.status !== 'UPDATED') throw new ManagementError(409, 'MEMORY_UNAVAILABLE', 'Memory cannot be corrected')
  return { id: memoryId, version: expected + 1 }
}

export async function listMemories(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN'])
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.memory.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.memory.findMany({
      ...args, where,
      select: { id: true, identityId: true, accountId: true, conversationId: true,
        scope: true, visibility: true, status: true, expiresAt: true },
    })
    return makePage(rows, page, ({ expiresAt, ...memory }) => ({
      ...memory, expiresAt: expiresAt?.toISOString() ?? null,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listGrants(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN'])
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.memoryGrant.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.memoryGrant.findMany({
      ...args, where,
      select: { id: true, memoryId: true, recipientIdentityId: true, recipientAccountId: true,
        purpose: true, audience: true, validFrom: true, validUntil: true, revokedAt: true, createdAt: true },
    })
    return makePage(rows, page, ({ createdAt: _, validFrom, validUntil, revokedAt, ...grant }) => ({
      ...grant, validFrom: validFrom.toISOString(), validUntil: validUntil.toISOString(), revokedAt: revokedAt?.toISOString() ?? null,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listAudit(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.managementAudit.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.managementAudit.findMany({
      ...args, where,
    })
    return makePage(rows, page, ({ characterId: _, createdAt, ...entry }) => ({ ...entry, createdAt: createdAt.toISOString() }))
  }, { isolationLevel: 'RepeatableRead' })
}

async function scheduleTiming(tx: Tx, input: Input<typeof scheduleUpdate>) {
  const { zone, rule, enabled } = input
  const [zoneCheck] = await tx.$queryRaw<{ valid: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = ${zone}) AS valid
  `
  if (!zoneCheck?.valid) invalid('Unsupported schedule time zone')
  const dueAt = rule.kind === 'REMINDER' ? new Date(rule.dueAt) : null
  const localTime = rule.kind === 'DAILY' ? rule.localTime : null
  const nextAt = !enabled ? null : dueAt ?? await dailyScheduleSlot(tx, zone, localTime!, new Date())
  return { zone, kind: rule.kind, dueAt, localTime, enabled, nextAt }
}

export async function createSchedule(tx: Tx, scope: Scope, input: Input<typeof scheduleInput>) {
  const { characterId } = scope
  const { accountId, conversationId, contactId, scheduleKey } = input
  const account = await tx.platformAccount.findFirst({
    where: { id: accountId, characterId, platform: { in: ['mock-a', 'mock-b'] } },
    select: { identityId: true },
  })
  if (!account) unavailable()
  const conversation = await tx.conversation.findFirst({
    where: { id: conversationId, characterId, identityId: account.identityId, accountId },
    select: { channel: true, privateContactId: true },
  })
  if (!conversation) unavailable()
  if (conversation.channel === 'PRIVATE' && conversation.privateContactId !== contactId) unavailable()
  if (conversation.channel === 'PUBLIC' && contactId) invalid('Public schedule must not specify a private contact')
  const timing = await scheduleTiming(tx, input)
  const { id, version } = await tx.simulationSchedule.create({
    data: { ...timing, characterId, identityId: account.identityId, accountId, conversationId, contactId, scheduleKey },
    select: { id: true, version: true },
  })
  return { id, version }
}

export async function updateSchedule(
  tx: Tx, scope: Scope, id: string, expected: number, input: Input<typeof scheduleUpdate>,
) {
  const schedule = await tx.simulationSchedule.findFirst({
    where: { id, characterId: scope.characterId },
    select: { version: true, commitment: { select: { id: true } } },
  })
  if (!schedule) unavailable()
  if (schedule.commitment) throw new ManagementError(409, 'COMMITMENT_SCHEDULE', 'Update this reminder through its commitment')
  checkVersion(schedule.version, expected)
  const timing = await scheduleTiming(tx, input)
  return tx.simulationSchedule.update({
    where: { id }, data: { ...timing, version: { increment: 1 } }, select: { id: true, version: true },
  })
}

export async function listSchedules(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN'])
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.simulationSchedule.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.simulationSchedule.findMany({
      ...args, where,
      select: { id: true, scheduleKey: true, zone: true, kind: true, localTime: true, dueAt: true,
        nextAt: true, enabled: true, version: true, accountId: true, conversationId: true, contactId: true },
    })
    return makePage(rows, page, ({ kind, localTime, dueAt, nextAt, ...row }) => ({
      ...row,
      rule: kind === 'DAILY' ? { kind, localTime: localTime! } : { kind, dueAt: dueAt!.toISOString() },
      nextAt: nextAt?.toISOString() ?? null,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function createCommitment(tx: Tx, scope: Scope, input: Input<typeof commitmentInput>) {
  const { characterId, actor } = scope
  const [bound] = await tx.$queryRaw<{
    accountId: string; identityId: string; conversationId: string; contactId: string | null; zone: string
  }[]>`
    SELECT * FROM public.rica_confirmed_commitment_scope(${characterId}::uuid, ${input.actionId}::uuid)
  `
  if (!bound) unavailable()

  const id = randomUUID()
  const dueAt = new Date(input.dueAt)
  const schedule = await tx.simulationSchedule.create({
    data: {
      ...bound, characterId, scheduleKey: 'commitment:' + id, kind: 'REMINDER', dueAt, nextAt: dueAt,
    },
    select: { id: true },
  })
  const commitment = await tx.simulationCommitment.create({
    data: { id, characterId, actionId: input.actionId, scheduleId: schedule.id, title: input.title, dueAt },
    select: { id: true, version: true, state: true },
  })
  await tx.commitmentRevision.create({
    data: { commitmentId: id, characterId, version: commitment.version, state: commitment.state,
      dueAt, reason: input.reason, actorId: actor.id },
  })
  return { id, version: commitment.version, status: commitment.state }
}

export async function updateCommitment(
  tx: Tx, scope: Scope, id: string, expected: number, input: Input<typeof commitmentUpdate>,
) {
  const { characterId, actor } = scope
  const current = await tx.simulationCommitment.findFirst({ where: { id, characterId } })
  if (!current) unavailable()
  checkVersion(current.version, expected)
  if (current.state !== 'OPEN' && current.state !== 'DEFERRED') {
    throw new ManagementError(409, 'COMMITMENT_CLOSED', 'Commitment is already closed')
  }

  const deferred = input.operation === 'DEFER'
  const dueAt = deferred ? new Date(input.dueAt) : current.dueAt
  if (deferred && (dueAt <= current.dueAt || dueAt <= new Date())) invalid('New deadline must be later and in the future')
  if (input.operation === 'EXPIRE' && current.dueAt > new Date()) invalid('Commitment deadline has not passed')
  const states = { DEFER: 'DEFERRED', FULFILL: 'FULFILLED', CANCEL: 'CANCELED', EXPIRE: 'EXPIRED' } as const
  const state = states[input.operation]
  const version = expected + 1

  await tx.simulationSchedule.update({
    where: { id: current.scheduleId },
    data: { dueAt, nextAt: deferred ? dueAt : null, enabled: deferred, version: { increment: 1 } },
  })
  await tx.simulationCommitment.update({ where: { id }, data: { dueAt, state, version } })
  await tx.commitmentRevision.create({
    data: { commitmentId: id, characterId, version, state, dueAt, reason: input.reason, actorId: actor.id },
  })
  return { id, version, status: state }
}

export async function listCommitments(db: PrismaClient, scope: Scope, input: Input<typeof commitmentQuery>) {
  const page = parsePage(input)
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN'])
    const where = { characterId: scope.characterId, schedule: { accountId: input.accountId, contactId: input.contactId } }
    const args = await pageArgs(page, (id) => tx.simulationCommitment.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.simulationCommitment.findMany({
      ...args, where,
      select: { id: true, actionId: true, scheduleId: true, title: true, state: true, version: true, dueAt: true,
        schedule: { select: { accountId: true, conversationId: true, contactId: true, nextAt: true } } },
    })
    return makePage(rows, page, ({ schedule, dueAt, ...row }) => ({
      ...row, ...schedule, dueAt: dueAt.toISOString(), nextAt: schedule.nextAt?.toISOString() ?? null,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}
