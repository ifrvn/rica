import { createHash, randomUUID } from 'node:crypto'
import type { commitmentInput, commitmentQuery, commitmentReceiptQuery, commitmentReceiptView, commitmentUpdate } from '@ricajs/contracts/commitments'
import type { z } from '@hono/zod-openapi'
import { contactBoundaryView, coreProfile, dailyEnergyView, identityProfile, isSimulationPlatform, memoryProvenanceView, simulationPlatformId } from '@ricajs/contracts/management'
import { localIssuer } from '@ricajs/contracts/local-users'
import type * as contracts from '@ricajs/contracts/management'
import type { scheduleInput, scheduleUpdate } from '@ricajs/contracts/schedules'
import { dailyScheduleSlot } from '../runtime/run-context.js'
import type { Prisma, PrismaClient } from '../generated/client.js'

type Subject = Readonly<{ issuer: string; subject: string; id: string; canCreate?: boolean }>
type Tx = Prisma.TransactionClient
type CommandResult = { id: string; status?: string; version?: number; authEpoch?: number }
type CommandApply = (tx: Tx) => Promise<CommandResult>
export type ManagementCommandHandler = CommandApply | { prepare(): Promise<CommandApply> }
type Input<T extends z.ZodType> = z.infer<T>

const managementError = Symbol.for('@ricajs/persistence/ManagementError')

export class ManagementError extends Error {
  readonly [managementError] = true

  constructor(
    readonly status: 403 | 404 | 409 | 412 | 422 | 428,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function isManagementError(value: unknown): value is ManagementError {
  return value instanceof Error && managementError in value && value[managementError] === true
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

function isSystemAdministrator(actor: Subject) {
  return actor.issuer === localIssuer && actor.canCreate === true
}

export async function authorize(tx: Tx, scope: Scope) {
  if (isSystemAdministrator(scope.actor)) {
    if (!await tx.character.findUnique({ where: { id: scope.characterId }, select: { id: true } })) unavailable()
    return
  }
  const membership = await tx.managementMembership.findUnique({
    where: { characterId_issuer_subject: { characterId: scope.characterId, issuer: scope.actor.issuer, subject: scope.actor.subject } },
    select: { subject: true },
  })
  if (!membership) unavailable()
}

export async function lockCharacter(tx: Tx, characterId: string) {
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
}

export async function executeManagementCommand(
  db: PrismaClient, command: Command, handler: ManagementCommandHandler,
) {
  const { actor, characterId, operation, requestId, input, key, targetScope } = command
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const routeScope = operation + ':' + targetScope
  const selector = key ? { principalId: actor.id, routeScope, key } : null
  const unique = selector ? { principalId_routeScope_key: selector } : null

  async function lockAndAuthorize(tx: Tx) {
    if (key) {
      // Scope the lock to the same tuple as the unique idempotency key.
      const lock = JSON.stringify([actor.id, routeScope, key])
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`
    }
    if (characterId) {
      // Check membership again after taking the same lock as administrator grants and revocations.
      await authorize(tx, { actor, characterId })
      await lockCharacter(tx, characterId)
      await authorize(tx, { actor, characterId })
    }
  }

  async function replay(tx: Tx) {
    if (unique) {
      const previous = await tx.managementIdempotency.findUnique({ where: unique })
      if (previous && previous.expiresAt > new Date()) {
        if (previous.requestHash !== digest) {
          throw new ManagementError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different input')
        }
        return previous.response as CommandResult
      }
    }
  }

  let apply: CommandApply
  if (typeof handler === 'function') apply = handler
  else {
    const previous = await db.$transaction(async (tx) => {
      await lockAndAuthorize(tx)
      return replay(tx)
    }, { isolationLevel: 'ReadCommitted' })
    if (previous) return previous
    apply = await handler.prepare()
  }

  return db.$transaction(async (tx) => {
    await lockAndAuthorize(tx)
    const previous = await replay(tx)
    if (previous) return previous
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
    data: { characterId: id, issuer: actor.issuer, subject: actor.subject },
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
    data: { characterId, version, hardProfile: input.coreProfile, actorId: actor.id, reason: input.reason ?? '' },
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
  if (identity.activeVersion === null) unavailable()
  checkVersion(identity.activeVersion, expected)
  const latest = await tx.identityVersion.findFirst({
    where: { characterId, identityId: id }, orderBy: { version: 'desc' }, select: { version: true },
  })
  if (!latest) unavailable()
  const version = latest.version + 1
  await tx.identityVersion.create({
    data: { characterId, identityId: id, version, roleProfile: input.roleProfile, actorId: actor.id, reason: input.reason ?? '' },
  })
  await tx.identity.update({ where: { id }, data: { activeVersion: version } })
  return { id, version, authEpoch: await advanceEpoch(tx, characterId) }
}

type AccountRegistration = Pick<Prisma.PlatformAccountRegistrationUncheckedCreateInput, 'platform' | 'instanceKey' | 'remoteAccountId'>

type PlatformAccountRef = { id: string; platform: string; instanceKey: string; remoteAccountId: string }
export type PlatformAccountHooks = {
  platform: string
  profiles(tx: Tx, accounts: PlatformAccountRef[], characterId: string): Promise<(account: PlatformAccountRef) => object>
  remove(tx: Tx, account: PlatformAccountRef, characterId: string): Promise<void>
  verifyResume(tx: Tx, account: PlatformAccountRef, characterId: string): Promise<void>
}

async function accountProfiles(tx: Tx, accounts: PlatformAccountRef[], hooks: readonly PlatformAccountHooks[], characterId: string) {
  const profiles = new Map(await Promise.all(hooks.map(async ({ platform, profiles }) => {
    const owned = accounts.filter((account) => account.platform === platform)
    return [platform, owned.length ? await profiles(tx, owned, characterId) : undefined] as const
  })))
  return (account: PlatformAccountRef) => profiles.get(account.platform)?.(account)
}

export async function registerAccount(tx: Tx, scope: Scope, input: AccountRegistration) {
  if (await tx.platformAccount.findUnique({ where: { platform_instanceKey_remoteAccountId: input }, select: { id: true } })) {
    throw new ManagementError(409, 'ACCOUNT_REGISTERED', 'Platform account already registered')
  }
  return tx.platformAccountRegistration.create({ data: { ...input, characterId: scope.characterId }, select: { id: true } })
}

export async function associateAccount(tx: Tx, scope: Scope, input: Input<typeof contracts.accountBindingInput>) {
  const { characterId } = scope
  const registration = await tx.platformAccountRegistration.findFirst({ where: { id: input.registrationId, characterId } })
  if (!registration || !await tx.identity.findFirst({ where: { characterId, id: input.identityId }, select: { id: true } })) unavailable()
  const claimed = await tx.platformAccountRegistration.updateMany({
    where: { id: registration.id, characterId, boundAt: null }, data: { boundAt: new Date() },
  })
  if (!claimed.count) throw new ManagementError(409, 'ACCOUNT_ALREADY_BOUND', 'Platform account already associated')
  // Management commands serialize writes under the character lock.
  const current = await tx.platformAccount.findFirst({
    where: { characterId, identityId: input.identityId, status: { not: 'REVOKED' } }, select: { id: true },
  })
  if (current) throw new ManagementError(409, 'IDENTITY_ALREADY_BOUND', 'Identity already has a platform account')
  const { id, platform, instanceKey, remoteAccountId } = registration
  const account = await tx.platformAccount.create({
    data: { id, characterId, identityId: input.identityId, platform, instanceKey, remoteAccountId, status: 'PAUSED' },
    select: { id: true, status: true, bindingVersion: true },
  })
  return { id: account.id, status: account.status, version: account.bindingVersion }
}

export async function removeAccountRegistration(tx: Tx, scope: Scope, id: string, hooks: readonly PlatformAccountHooks[] = []) {
  const registration = await tx.platformAccountRegistration.findFirst({ where: { id, characterId: scope.characterId } })
  if (!registration) unavailable()
  const removed = await tx.platformAccountRegistration.deleteMany({ where: { id, characterId: scope.characterId, boundAt: null } })
  if (!removed.count) throw new ManagementError(409, 'ACCOUNT_ALREADY_BOUND', 'Platform account already associated')
  await hooks.find(({ platform }) => platform === registration.platform)?.remove(tx, registration, scope.characterId)
  return { id }
}

export async function createAccount(tx: Tx, scope: Scope, { identityId, ...input }: Input<typeof contracts.accountInput>) {
  const { id } = await registerAccount(tx, scope, input)
  return associateAccount(tx, scope, { registrationId: id, identityId })
}

export async function listAccountPool(db: PrismaClient, scope: Scope, page: Page, hooks: readonly PlatformAccountHooks[] = []) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId, boundAt: null }
    const args = await pageArgs(page, (id) => tx.platformAccountRegistration.findFirst({
      where: { id, characterId: scope.characterId }, select: { id: true },
    }))
    const rows = await tx.platformAccountRegistration.findMany({
      ...args, where, select: { id: true, platform: true, instanceKey: true, remoteAccountId: true },
    })
    const profile = await accountProfiles(tx, rows, hooks, scope.characterId)
    return makePage(rows, page, (row) => ({ ...profile(row), ...row }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function control(tx: Tx, scope: Scope, input: Input<typeof contracts.controlInput>, hooks: readonly PlatformAccountHooks[] = []) {
  const { characterId } = scope
  const { scopeId: id, operation } = input
  const entityStatus = operation === 'RESUME' ? 'ACTIVE' : 'PAUSED'
  if (input.scope === 'ACCOUNT') {
    const account = await tx.platformAccount.findFirst({ where: { characterId, id }, select: { status: true, platform: true, instanceKey: true, remoteAccountId: true } })
    if (!account) unavailable()
    if (account.status === 'REVOKED' || (operation === 'RESUME' && account.status !== 'PAUSED' && account.status !== 'ACTIVE')) {
      throw new ManagementError(409, 'STATE_CONFLICT', 'Account cannot perform this transition')
    }
    if (operation === 'RESUME' && !isSimulationPlatform(account.platform)) {
      const connector = hooks.find(({ platform }) => platform === account.platform)
      if (!connector) {
        throw new ManagementError(409, 'STATE_CONFLICT', 'Account must complete platform authorization')
      }
      await connector.verifyResume(tx, { id, ...account }, characterId)
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
  const where = { characterId, issuer: actor.issuer, subject: input.subject }
  if (input.action === 'GRANT') {
    await tx.managementMembership.create({ data: where })
  } else {
    const existing = await tx.managementMembership.findUnique({
      where: { characterId_issuer_subject: where },
      select: { subject: true },
    })
    if (!existing) unavailable()
    if (await tx.managementMembership.count({ where: { characterId, issuer: actor.issuer } }) <= 1) {
      throw new ManagementError(409, 'LAST_ADMIN', 'Character must retain an administrator')
    }
    await tx.managementMembership.delete({ where: { characterId_issuer_subject: where } })
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

export type Page = { limit: number; cursor?: string }

export function parsePage(input: Input<typeof contracts.listQuery>): Page {
  return { limit: Number(input.limit ?? 25), cursor: input.cursor }
}

export async function pageArgs({ limit, cursor }: Page, visible: (id: string) => Promise<unknown>) {
  if (cursor && !await visible(cursor)) invalid('Invalid cursor')
  // Resolve the native timestamp through its row to preserve PostgreSQL microseconds.
  return {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  }
}

export function makePage<T extends { id: string }, View>(rows: T[], { limit }: Page, view: (row: T) => View) {
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
  const where = isSystemAdministrator(actor) ? {} : { managementMemberships: { some: { issuer: actor.issuer, subject: actor.subject } } }
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

export async function listIdentities(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const profile = identityProfile.strip()
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

export async function listAccounts(db: PrismaClient, scope: Scope, page: Page, hooks: readonly PlatformAccountHooks[] = []) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.platformAccount.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.platformAccount.findMany({
      ...args, where,
      select: { id: true, identityId: true, platform: true, instanceKey: true, remoteAccountId: true, status: true, bindingVersion: true, createdAt: true },
    })
    const profile = await accountProfiles(tx, rows, hooks, scope.characterId)
    return makePage(rows, page, (row) => {
      const { bindingVersion, createdAt: _, remoteAccountId: __, ...view } = row
      return { ...profile(row), ...view, version: bindingVersion }
    })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readAutomationEligibility(db: PrismaClient, scope: Scope, accountId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
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
    const simulated = isSimulationPlatform(account.platform)
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
    await authorize(tx, scope)
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
    await authorize(tx, scope)
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_read_identity_reflection(${scope.characterId}::uuid, ${identityId}::uuid, ${day}::date) AS view
    `
    if (!row?.view) unavailable()
    return row.view
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readBelief(db: PrismaClient, scope: Scope, identityId: string, beliefId: string, revision?: number) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
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
    await authorize(tx, scope)
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
    await authorize(tx, scope)
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

const memoryMetadata = { id: true, identityId: true, accountId: true, conversationId: true,
  scope: true, visibility: true, status: true, expiresAt: true, createdAt: true } satisfies Prisma.MemorySelect

function memoryView({ createdAt, expiresAt, ...memory }: Prisma.MemoryGetPayload<{ select: typeof memoryMetadata }>) {
  return { ...memory, createdAt: createdAt.toISOString(), expiresAt: expiresAt?.toISOString() ?? null }
}

async function memoryProvenance(tx: Tx, characterId: string, memoryId: string) {
  const [row] = await tx.$queryRaw<{ view: unknown }[]>`
    SELECT public.rica_memory_provenance(${characterId}::uuid, ${memoryId}::uuid) AS view
  `
  if (!row?.view) unavailable()
  return memoryProvenanceView.parse(row.view)
}

export async function readMemoryDetail(db: PrismaClient, scope: Scope, memoryId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const memory = await tx.memory.findFirst({ where: { id: memoryId, characterId: scope.characterId }, select: memoryMetadata })
    if (!memory) unavailable()
    return { memory: memoryView(memory), provenance: await memoryProvenance(tx, scope.characterId, memoryId) }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readMemoryProvenance(db: PrismaClient, scope: Scope, memoryId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    return memoryProvenance(tx, scope.characterId, memoryId)
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

export async function listMemories(db: PrismaClient, scope: Scope,
  page: Page, { identityId, scope: memoryScope, status }: Input<typeof contracts.memoryListQuery>) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId, identityId, scope: memoryScope, status }
    const args = await pageArgs(page, (id) => tx.memory.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.memory.findMany({
      ...args, where,
      select: memoryMetadata,
    })
    return makePage(rows, page, memoryView)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listGrants(db: PrismaClient, scope: Scope, page: Page, memoryId?: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId, memoryId }
    const args = await pageArgs(page, (id) => tx.memoryGrant.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.memoryGrant.findMany({
      ...args, where,
      select: { id: true, memoryId: true, recipientIdentityId: true, recipientAccountId: true,
        recipientConversationId: true, recipientContactId: true,
        purpose: true, audience: true, validFrom: true, validUntil: true, revokedAt: true, createdAt: true },
    })
    return makePage(rows, page, ({ createdAt: _, validFrom, validUntil, revokedAt, ...grant }) => ({
      ...grant, validFrom: validFrom.toISOString(), validUntil: validUntil.toISOString(), revokedAt: revokedAt?.toISOString() ?? null,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listAudit(db: PrismaClient, scope: Scope, page: Page & { runId?: string; targetId?: string; order?: 'asc' | 'desc' }) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const { runId, targetId, order = 'asc' } = page
    const where: Prisma.ManagementAuditWhereInput = { characterId: scope.characterId, targetId }
    if (runId) {
      const run = await tx.agentRun.findFirst({ where: { characterId: scope.characterId, id: runId }, select: { id: true } })
      if (!run) unavailable()
      const proposal = await tx.actionProposal.findFirst({
        where: { characterId: scope.characterId, runId }, select: { id: true },
      })
      const events = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM public.rica_run_audit_outbox(${scope.characterId}::uuid, ${runId}::uuid) AS event(id)
      `
      where.OR = [
        { targetId: runId, operation: 'simulation.start' },
        ...(proposal ? [{ targetId: proposal.id, operation: { in: ['action.review', 'action.auto-approve', 'action.invalidate',
          'simulation.resolve', 'simulation.executing', 'simulation.simulated', 'simulation.blocked', 'simulation.reconciling'] } }] : []),
        { targetId: { in: events.map(({ id }) => id) }, operation: 'outbox.retry' },
      ]
    }
    const args = await pageArgs(page, (id) => tx.managementAudit.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.managementAudit.findMany({
      ...args, where, orderBy: [{ createdAt: order }, { id: order }],
    })
    const scopedTargets = { characterId: scope.characterId }
    const startedRunIds = rows.filter(({ operation }) => operation === 'simulation.start').map(({ targetId }) => targetId)
    const commitmentIds = rows.filter(({ operation }) => operation.startsWith('commitment.')).map(({ targetId }) => targetId)
    const [commitments, actors] = await Promise.all([
      tx.simulationCommitment.findMany({
        where: { ...scopedTargets, id: { in: commitmentIds } }, select: { id: true, actionId: true, title: true, dueAt: true },
      }),
      tx.adminUser.findMany({ where: { actorId: { in: rows.map(({ actorId }) => actorId) } },
        select: { actorId: true, username: true } }),
    ])
    const actionIds = rows.filter(({ operation }) => operation.startsWith('action.')
      || ['simulation.resolve', 'simulation.executing', 'simulation.simulated', 'simulation.blocked', 'simulation.reconciling'].includes(operation))
      .map(({ targetId }) => targetId)
    const actions = await tx.actionProposal.findMany({
      where: { ...scopedTargets, OR: [
        { id: { in: [...actionIds, ...commitments.map(({ actionId }) => actionId)] } },
        { runId: { in: startedRunIds } },
      ] },
      select: { id: true, runId: true, target: true, approval: { select: { decision: true } } },
    })
    const commitmentById = new Map(commitments.map((item) => [item.id, item]))
    const actionById = new Map(actions.map((item) => [item.id, item]))
    const actorNames = new Map(actors.map(({ actorId, username }) => [actorId, username]))
    const actionByRun = new Map(actions.map((item) => [item.runId, item]))
    return makePage(rows, page, ({ characterId: _, createdAt, ...entry }) => {
      const commitment = commitmentById.get(entry.targetId)
      const started = entry.operation === 'simulation.start'
      const action = started ? actionByRun.get(entry.targetId) : actionById.get(commitment?.actionId ?? entry.targetId)
      const target = action?.target
      const labels = target && typeof target === 'object' && !Array.isArray(target) ? target : null
      const run = action ? { id: action.runId, platform: typeof labels?.platform === 'string' ? labels.platform : null,
        identity: typeof labels?.identity === 'string' ? labels.identity : null }
        : started ? { id: entry.targetId, platform: null, identity: null } : undefined
      return { ...entry, createdAt: createdAt.toISOString(), run,
        actorLabel: actorNames.get(entry.actorId) ?? (entry.actorId === 'system:auto-review' ? 'AI 审核' : undefined),
        decision: entry.operation === 'action.review' || entry.operation === 'action.auto-approve' ? action?.approval?.decision : undefined,
        commitment: commitment ? { title: commitment.title, dueAt: commitment.dueAt.toISOString() } : undefined }
    })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function scheduleTiming(tx: Tx, input: Input<typeof scheduleUpdate>) {
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
    where: { id: accountId, characterId, platform: { in: simulationPlatformId.options } },
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
    select: { version: true, commitment: { select: { id: true } }, planParticipant: { select: { planId: true } } },
  })
  if (!schedule) unavailable()
  if (schedule.commitment) throw new ManagementError(409, 'COMMITMENT_SCHEDULE', 'Update this reminder through its commitment')
  if (schedule.planParticipant) throw new ManagementError(409, 'PLAN_SCHEDULE', 'Update this schedule through its plan')
  checkVersion(schedule.version, expected)
  const timing = await scheduleTiming(tx, input)
  return tx.simulationSchedule.update({
    where: { id }, data: { ...timing, version: { increment: 1 } }, select: { id: true, version: true },
  })
}

export async function listSchedules(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId, planParticipant: null }
    const args = await pageArgs(page, (id) => tx.simulationSchedule.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.simulationSchedule.findMany({
      ...args, where,
      select: { id: true, scheduleKey: true, zone: true, kind: true, localTime: true, dueAt: true,
        nextAt: true, enabled: true, version: true, accountId: true, conversationId: true, contactId: true,
        commitment: { select: { id: true } } },
    })
    return makePage(rows, page, ({ kind, localTime, dueAt, nextAt, commitment, ...row }) => ({
      ...row, commitmentId: commitment?.id ?? null,
      rule: kind === 'DAILY' ? { kind, localTime: localTime! } : { kind, dueAt: dueAt!.toISOString() },
      nextAt: nextAt?.toISOString() ?? null,
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

async function saveCommitmentCollaborators(
  tx: Tx, characterId: string, commitmentId: string, ownerId: string, collaborators: Input<typeof commitmentInput>['collaborators'],
) {
  const accounts = await tx.platformAccount.findMany({
    where: { characterId, id: { in: collaborators.map(({ accountId }) => accountId) }, status: { not: 'REVOKED' } },
    select: { id: true, identityId: true },
  })
  const byId = new Map(accounts.map(({ id, identityId }) => [id, identityId]))
  if (collaborators.some(({ identityId, accountId }) => identityId === ownerId || byId.get(accountId) !== identityId)) {
    throw new ManagementError(409, 'COMMITMENT_COLLABORATOR_CHANGED', 'Select current collaborator accounts distinct from the owner')
  }
  await tx.commitmentCollaborator.deleteMany({ where: { characterId, commitmentId } })
  if (collaborators.length) {
    await tx.commitmentCollaborator.createMany({ data: collaborators.map((item) => ({ ...item, characterId, commitmentId })) })
  }
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
    data: { id, characterId, actionId: input.actionId, scheduleId: schedule.id, title: input.title, task: input.task, dueAt },
    select: { id: true, version: true, state: true },
  })
  await saveCommitmentCollaborators(tx, characterId, id, bound.identityId, input.collaborators)
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
  const current = await tx.simulationCommitment.findFirst({
    where: { id, characterId }, include: { schedule: { select: { identityId: true } } },
  })
  if (!current) unavailable()
  checkVersion(current.version, expected)
  if (current.state !== 'OPEN' && current.state !== 'DEFERRED') {
    throw new ManagementError(409, 'COMMITMENT_CLOSED', 'Commitment is already closed')
  }

  const edit = input.operation === 'EDIT'
  const dueAt = edit || input.operation === 'DEFER' ? new Date(input.dueAt) : current.dueAt
  const deferred = input.operation === 'DEFER' || (edit && dueAt.getTime() !== current.dueAt.getTime())
  if (deferred && (dueAt <= current.dueAt || dueAt <= new Date())) invalid('New deadline must be later and in the future')
  if (input.operation === 'EXPIRE' && current.dueAt > new Date()) invalid('Commitment deadline has not passed')
  const states = { DEFER: 'DEFERRED', FULFILL: 'FULFILLED', CANCEL: 'CANCELED', EXPIRE: 'EXPIRED' } as const
  const state = edit ? (deferred ? 'DEFERRED' : current.state) : states[input.operation]
  const version = expected + 1

  if (edit) await saveCommitmentCollaborators(tx, characterId, id, current.schedule.identityId, input.collaborators)
  if (!edit || deferred) {
    await tx.simulationSchedule.update({
      where: { id: current.scheduleId },
      data: { dueAt, nextAt: deferred ? dueAt : null, enabled: deferred, version: { increment: 1 } },
    })
  }
  await tx.simulationCommitment.update({
    where: { id }, data: { dueAt, state, version, ...(edit ? { title: input.title, task: input.task } : {}) },
  })
  await tx.commitmentRevision.create({
    data: { commitmentId: id, characterId, version, state, dueAt, reason: input.reason, actorId: actor.id },
  })
  return { id, version, status: state }
}

export async function listCommitments(db: PrismaClient, scope: Scope, input: Input<typeof commitmentQuery>) {
  const page = parsePage(input)
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const where = { characterId: scope.characterId, schedule: { accountId: input.accountId, contactId: input.contactId } }
    const args = await pageArgs(page, (id) => tx.simulationCommitment.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.simulationCommitment.findMany({
      ...args, where,
      select: { id: true, actionId: true, scheduleId: true, title: true, task: true, state: true, version: true, dueAt: true, source: true,
        collaborators: { orderBy: { identityId: 'asc' }, select: {
          identityId: true, accountId: true, account: { select: { platform: true, status: true } },
        } },
        schedule: { select: { accountId: true, identityId: true, conversationId: true, contactId: true, nextAt: true,
          contact: { select: { displayLabel: true } } } } },
    })
    return makePage(rows, page, ({ schedule: { contact, nextAt, ...schedule }, dueAt, collaborators, ...row }) => ({
      ...row, ...schedule, contactLabel: contact?.displayLabel ?? null,
      source: row.source === 'AI' ? 'AI' as const : 'MANUAL' as const,
      dueAt: dueAt.toISOString(), nextAt: nextAt?.toISOString() ?? null,
      collaborators: collaborators.map(({ account, ...item }) => ({ ...item, platform: account.platform, accountStatus: account.status })),
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listCommitmentReceipts(db: PrismaClient, scope: Scope, input: Input<typeof commitmentReceiptQuery>) {
  const page = parsePage(input)
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const rows = await tx.$queryRaw<(Omit<Input<typeof commitmentReceiptView>, 'receiptAt'> & { receiptAt: Date })[]>`
      SELECT * FROM public.rica_available_commitment_receipts(
        ${scope.characterId}::uuid, ${input.runId ?? null}::uuid, ${page.cursor ?? null}::uuid, ${page.limit + 1}::int
      )
    `
    return makePage(rows, page, ({ receiptAt, ...row }) => ({ ...row, receiptAt: receiptAt.toISOString() }))
  }, { isolationLevel: 'RepeatableRead' })
}
