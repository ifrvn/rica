import { startCognitionPlugins, startConfiguredModel, startSimulationPlatforms } from '../apps/runtime-plugins.js'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { localSimulationModel } from '@ricajs/simulation/model'
import { createHostedModelManagement, createModelSettingsStore } from '@ricajs/plugin-hosted-models'
import { hostedUsageRecorder, readHostedUsage } from '@ricajs/plugin-hosted-models/persistence/usage'
import { denyPermission } from '@ricajs/persistence/management'
import { modelSettingsContracts } from '@ricajs/plugin-hosted-models/shared'
import { startOutboxWorker } from '../apps/worker/outbox.js'
import { dailyScheduleSlot } from '@ricajs/persistence/run-context'
import { dispatchSimulationSchedule, scanSimulationSchedules } from '@ricajs/simulation/schedules'
import { after, before, test } from 'node:test'
import { actorId, hashPassword, loadManagementConfig, localIssuer } from '../apps/api/admin-auth.js'
import { createAdminAuth } from '../apps/api/admin-auth-routes.js'
import { Redis } from 'ioredis'
import { createApp } from '../apps/api/app.js'
import { createManagementApp } from '../apps/api/management.js'
import { createRemotePluginEvents } from '../apps/api/remote-plugin-events.js'
import { createRemotePluginTasks } from '../apps/api/remote-plugin-tasks.js'
import { loadRemotePluginServices } from '../apps/api/remote-plugin-services.js'
import { pluginEventPage, type PluginActivityEvent } from '@ricajs/contracts/plugin-events'
import { loadPackageManagement } from '../apps/package-plugins.js'
import { packageManagementPlugins } from '../apps/api/package-management.js'
import { createAutoReviewer } from '../apps/auto-review.js'
import { deriveMemory, revokeMemoryAccess } from '@ricajs/persistence/memory'
import { reviewTarget } from '@ricajs/simulation/contracts/review'
import { defaultSimulationSettings } from '@ricajs/simulation/contracts/settings'
import { autoReviewSimulation, decideReviewAction, listReviewActions } from '@ricajs/simulation/review'
import { autoReviewerId, defaultAutoReviewPrompt, type ReviewPublicReply } from '@ricajs/contracts/auto-review'
import { sweepSimulationRetention } from '@ricajs/simulation/retention'
import { loadRunContinuity } from '@ricajs/persistence/run-continuity'
import { createDatabase } from '@ricajs/persistence/client'
import { scanIdentityReflections } from '@ricajs/persistence/identity-reflection'
import { createSimulatedPlatformIngress, ingestSimulatedEvent } from '@ricajs/simulation/inbound'
import { draftQueuedEvent, prepareSimulatedRun, runQueuedEvent } from '@ricajs/persistence/run-context'
import { processSimulatedDraft } from '@ricajs/simulation/draft'
import { executeSimulation, recordSimulationReceipt, reserveSimulation, runSimulationBatch } from '@ricajs/simulation/execution'
import { loadConfig } from '@ricajs/runtime/config'

const config = loadConfig()
const simulationPlatforms = await startSimulationPlatforms({})
const owner = createDatabase(config.databaseUrl)
const management = createDatabase(config.databaseUrl, 'rica_admin_api')
const issuer = 'https://identity.example.test'
const fixtureOrigin = 'http://localhost:5173'
const subjects = new Set(['admin-a', 'admin-b', 'reviewer', 'auditor', 'nonmember'])
const updatedDisclosure = 'AI role, version two.\n\n' + 'This virtual character is operated by AI. '.repeat(30).trim()
const modelProfileIds = new Set<string>()
const app = createApp({ postgres: async () => true, redis: async () => true }, createManagementApp({
    db: management,
    origin: fixtureOrigin, cookie: 'fixture-session', resolveAdapter: simulationPlatforms.resolveAdapter,
    modelProfileExists: async (id) => modelProfileIds.has(id),
    authenticate: async (request) => {
      const subject = request.headers.get('Cookie')?.match(/^fixture-session=([a-z-]+)$/u)?.[1]
      return subject && subjects.has(subject) ? {
        issuer, subject, id: actorId(issuer, subject), canCreate: subject.startsWith('admin-'),
      } : null
    },
  }))

const prefix = 'management-' + randomUUID()
const characterIds: string[] = []
let a: string
let b: string
let identityA: string
let identityB: string
let accountA: string

type RequestOptions = { actor?: string | null; key?: string; ifMatch?: string; data?: unknown; target?: typeof app }
async function request(method: string, path: string, options: RequestOptions = {}) {
  const { actor = 'admin-a', data, key, ifMatch, target = app } = options
  const headers = new Headers()
  headers.set('Origin', fixtureOrigin)
  if (actor) headers.set('Cookie', 'fixture-session=' + actor)
  if (data !== undefined) headers.set('Content-Type', 'application/json')
  if (key) headers.set('Idempotency-Key', key)
  if (ifMatch) headers.set('If-Match', ifMatch)
  const response = await target.request('/v1' + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

function characterPath(id: string) { return '/characters/' + id }
function characterData(suffix: string) {
  return { slug: prefix + suffix, timezone: 'UTC', coreProfile: { name: 'Rica', aiDisclosure: 'AI role' } }
}

before(async () => {
  for (const [actor, suffix] of [['admin-a', '-a'], ['admin-b', '-b']]) {
    const created = await request('POST', '/characters', { actor, key: prefix, data: characterData(suffix) })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    characterIds.push(created.body.id)
  }
  ;[a, b] = characterIds
  const ia = await request('POST', characterPath(a) + '/identities', {
    key: 'identity-a', data: { slug: 'one', roleProfile: { writingStyle: 'formal' } },
  })
  const ib = await request('POST', characterPath(b) + '/identities', {
    actor: 'admin-b', key: 'identity-b', data: { slug: 'two', roleProfile: { writingStyle: 'casual' } },
  })
  assert.equal(ia.status, 201, JSON.stringify(ia.body))
  assert.equal(ib.status, 201, JSON.stringify(ib.body))
  identityA = ia.body.id
  identityB = ib.body.id
  const account = await request('POST', characterPath(a) + '/accounts', {
    key: 'account-a', data: {
      identityId: identityA, platform: 'mock-a', instanceKey: 'integration', remoteAccountId: prefix,
    },
  })
  assert.equal(account.status, 201, JSON.stringify(account.body))
  accountA = account.body.id
  const role = await request('POST', characterPath(a) + '/memberships', {
    key: 'role-reviewer', data: { subject: 'reviewer', action: 'GRANT', reason: 'Reviewer fixture' },
  })
  assert.equal(role.status, 200, JSON.stringify(role.body))
})

after(async () => {
  try {
    await owner.$transaction(async (tx) => {
      const where = { characterId: { in: characterIds } }
      await tx.managementIdempotency.deleteMany({ where: {
        OR: characterIds.flatMap((id) => [
          { routeScope: { contains: id } }, { response: { path: ['id'], equals: id } },
        ]),
      } })
      await tx.outboxEvent.deleteMany({ where: { run: where } })
      await tx.commitmentRevision.deleteMany({ where })
      await tx.commitmentCollaborator.deleteMany({ where })
      await tx.simulationCommitment.deleteMany({ where })
      await tx.simulationReceipt.deleteMany({ where })
      await tx.simulationAttempt.deleteMany({ where })
      await tx.actionApproval.deleteMany({ where })
      await tx.actionProposal.deleteMany({ where })
      await tx.simulatedDraft.deleteMany({ where })
      await tx.contextSnapshotEvidence.deleteMany({ where })
      await tx.contextSnapshot.deleteMany({ where })
      await tx.scheduleOccurrence.deleteMany({ where })
      await tx.simulationPlanParticipant.deleteMany({ where })
      await tx.simulationPlan.deleteMany({ where })
      await tx.simulationSchedule.deleteMany({ where })
      await tx.identityStateRevision.deleteMany({ where })
      await tx.agentRun.deleteMany({ where })
      await tx.inboundEvent.deleteMany({ where })
      await tx.managementAudit.deleteMany({ where })
      await tx.managementMembership.deleteMany({ where })
      await tx.memoryGrant.deleteMany({ where })
      await tx.goalVersion.deleteMany({ where })
      await tx.identityReflection.deleteMany({ where })
      await tx.beliefEvidence.deleteMany({ where })
      await tx.beliefVersion.deleteMany({ where })
      await tx.memorySource.deleteMany({ where })
      await tx.memoryCorrection.deleteMany({ where })
      await tx.memory.deleteMany({ where })
      await tx.sourceRecord.deleteMany({ where })
      await tx.conversation.deleteMany({ where })
      await tx.contact.deleteMany({ where })
      await tx.platformAccount.deleteMany({ where })
      await tx.identity.updateMany({ where, data: { status: 'PAUSED', activeVersion: null } })
      await tx.identityVersion.deleteMany({ where })
      await tx.identity.deleteMany({ where })
      await tx.character.updateMany({ where: { id: { in: characterIds } }, data: { status: 'PAUSED', activeCoreVersion: null } })
      await tx.coreVersion.deleteMany({ where })
      await tx.dailyEnergyProjection.deleteMany({ where })
      await tx.modelDailyUsage.deleteMany({ where })
      await tx.character.deleteMany({ where: { id: { in: characterIds } } })
    })
  } finally {
    await Promise.all([management.$disconnect(), owner.$disconnect()])
  }
})

test('an external package migrates independently and its activity preserves scope and microseconds', { timeout: 45_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rica-activity-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const migrationRole = 'rica_activity_fixture_' + randomUUID().replaceAll('-', '')
  const password = randomUUID()
  await owner.$executeRawUnsafe(`CREATE ROLE ${migrationRole} LOGIN PASSWORD '${password}'`)
  let schemaCreated = false
  t.after(async () => {
    if (schemaCreated) await owner.$executeRaw`DROP SCHEMA rica_plugin_activity_fixture CASCADE`
    await owner.$executeRawUnsafe(`DROP ROLE ${migrationRole}`)
  })
  await owner.$executeRawUnsafe(`CREATE SCHEMA rica_plugin_activity_fixture AUTHORIZATION ${migrationRole}`)
  schemaCreated = true

  const manifest = join(directory, 'plugins.json')
  const plugin = join(directory, 'node_modules', 'rica-activity-fixture')
  const migrations = join(plugin, 'migrations')
  const initial = join(migrations, '20261120000000_entries')
  await mkdir(initial, { recursive: true })
  await Promise.all([
    writeFile(manifest, JSON.stringify({ version: 1, plugins: [{ id: 'activity-fixture', package: 'rica-activity-fixture', version: '1.0.0',
      database: { migrateUrlEnv: 'RICA_PLUGIN_FIXTURE_MIGRATE_URL', runtimeUrlEnv: 'RICA_PLUGIN_FIXTURE_RUNTIME_URL' } }] })),
    writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'rica-activity-fixture', version: '1.0.0', type: 'module',
      exports: { './package.json': './package.json', './rica': './plugin.js', './rica/prisma': './prisma.config.js' } })),
    writeFile(join(plugin, 'plugin.js'), `export const ricaPlugin = { id: 'activity-fixture', sdkVersion: 1, activity: { view: 'run_activity' } }`),
    writeFile(join(plugin, 'prisma.config.js'), `export default { schema: './schema.prisma', migrations: { path: './migrations' },
      datasource: { url: process.env.RICA_PLUGIN_DATABASE_URL } }`),
    writeFile(join(plugin, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n}\n'),
    writeFile(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n'),
    writeFile(join(initial, 'migration.sql'), `
    CREATE TABLE rica_plugin_activity_fixture.entries (
      character_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL, identity text NOT NULL,
      account text NOT NULL, account_id uuid NOT NULL, state text NOT NULL, created_at timestamptz NOT NULL
    );`),
  ])
  const migrationUrl = new URL(config.databaseUrl)
  migrationUrl.username = migrationRole
  migrationUrl.password = password
  migrationUrl.searchParams.set('schema', 'rica_plugin_activity_fixture')
  const migrate = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: config.databaseUrl,
      RICA_PLUGIN_MANIFEST: manifest, RICA_PLUGIN_FIXTURE_MIGRATE_URL: migrationUrl.href },
  })
  await migrate()
  const { body: foreignAccount } = await request('POST', characterPath(b) + '/accounts', {
    actor: 'admin-b', key: 'activity-account', data: {
      identityId: identityB, platform: 'mock-b', instanceKey: 'integration', remoteAccountId: prefix + '-activity',
    },
  })
  assert.equal(typeof foreignAccount.id, 'string')
  const id = randomUUID()
  await owner.$executeRaw`
    INSERT INTO rica_plugin_activity_fixture.entries VALUES
      (${a}::uuid, ${id}::uuid, 'PROPOSAL', 'one', 'local', ${accountA}::uuid, 'WAITING', '2026-01-01T00:00:00.123457Z'),
      (${a}::uuid, ${id}::uuid, 'ASSESSMENT', 'one', 'local', ${accountA}::uuid, 'DONE', '2026-01-01T00:00:00.123456Z'),
      (${a}::uuid, ${randomUUID()}::uuid, 'PROPOSAL', 'foreign', 'foreign', ${foreignAccount.id}::uuid, 'WAITING', now()),
      (${b}::uuid, ${randomUUID()}::uuid, 'ASSESSMENT', 'foreign', 'foreign', ${foreignAccount.id}::uuid, 'DONE', now())`

  const upgrade = join(migrations, '20261120010000_activity')
  await mkdir(upgrade)
  await writeFile(join(upgrade, 'migration.sql'), `
    CREATE VIEW rica_plugin_activity_fixture.run_activity AS SELECT * FROM rica_plugin_activity_fixture.entries;
    GRANT USAGE ON SCHEMA rica_plugin_activity_fixture TO rica_admin_api;
    GRANT SELECT ON rica_plugin_activity_fixture.run_activity TO rica_admin_api;
  `)
  await migrate()
  assert.deepEqual(await owner.$queryRaw`
    SELECT migration_name FROM rica_plugin_activity_fixture._prisma_migrations ORDER BY migration_name`,
  [{ migration_name: '20261120000000_entries' }, { migration_name: '20261120010000_activity' }])
  await assert.rejects(management.$queryRaw`SELECT id FROM rica_plugin_activity_fixture.entries LIMIT 0`, /permission denied/i)
  const host = await loadPackageManagement(manifest)
  t.after(() => host.stop())
  assert.deepEqual(host.plugins, [])
  const target = createApp({ postgres: async () => true, redis: async () => true }, createManagementApp({
    db: management, origin: fixtureOrigin, cookie: 'fixture-session', resolveAdapter: () => undefined,
    activityViews: host.activityViews,
    authenticate: async (req) => {
      const subject = req.headers.get('Cookie')?.replace('fixture-session=', '')
      return subject ? { issuer, subject, id: actorId(issuer, subject) } : null
    },
  }))
  const path = characterPath(a) + '/run-activity'
  assert.equal((await request('GET', path, { target, actor: 'admin-b' })).status, 404)
  const first = await request('GET', path + '?limit=1', { target })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual(first.body.items.map((row: { id: string; platform: string; createdAt: string }) => [row.id, row.platform, row.createdAt]),
    [[id, 'plugin:activity-fixture', '2026-01-01T00:00:00.123457Z']])
  assert.ok(first.body.nextCursor)
  const second = await request('GET', path + '?limit=1&cursor=' + first.body.nextCursor, { target })
  assert.equal(second.status, 200)
  assert.equal(second.body.items[0]?.createdAt, '2026-01-01T00:00:00.123456Z')
  assert.equal(second.body.nextCursor, null)
  const filtered = await request('GET', path + '?kind=ASSESSMENT', { target })
  assert.deepEqual(filtered.body.items.map((row: { kind: string }) => row.kind), ['ASSESSMENT'])
})

test('local authentication enforces origin, membership and session revocation', { timeout: 30_000 }, async () => {
  const authConfig = loadManagementConfig({ RICA_ADMIN_ORIGIN: fixtureOrigin })!
  const redis = new Redis(config.redisUrl)
  const auth = createAdminAuth(management, redis, authConfig)
  const local = createApp({ postgres: async () => true, redis: async () => true },
    createManagementApp({
      db: management, authenticate: auth.authenticate, origin: fixtureOrigin, cookie: authConfig.cookie,
      resolveAdapter: simulationPlatforms.resolveAdapter,
    }),
    auth.app,
  )
  const suffix = randomUUID()
  const username = 'local-' + suffix
  const oldPassword = 'old fixture password'
  const newPassword = 'new fixture password'
  async function accountCommand(args: string[], password: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/admin-user.ts', ...args], {
      env: { ...process.env, MIGRATION_DATABASE_URL: config.databaseUrl }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    const closed = once(child, 'close')
    child.stdin.end(password + '\n')
    assert.equal((await closed)[0], 0, output)
  }
  const submit = (path: string, data: object, cookie = '', origin = fixtureOrigin) => local.request('/v1/auth/' + path, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  const session = (cookie: string) => local.request('/v1/auth/session', { headers: { Cookie: cookie } })
  try {
    await accountCommand(['add', username], oldPassword)
    const user = await owner.adminUser.findUniqueOrThrow({ where: { username } })
    assert.equal(user.actorId, actorId(localIssuer, username))
    assert.equal(user.canCreate, true)
    assert.ok(user.createdAt)
    assert.equal((await submit('login', { username, password: oldPassword }, '', 'https://foreign.example.test')).status, 403)
    assert.equal((await submit('login', { username, password: newPassword })).status, 401)
    const login = await submit('login', { username, password: oldPassword })
    assert.equal(login.status, 200)
    const cookieHeader = login.headers.get('set-cookie')!
    const cookie = cookieHeader.split(';')[0]
    assert.match(cookieHeader, /HttpOnly/i)
    assert.match(cookieHeader, /SameSite=Strict/i)
    const currentSession = await session(cookie)
    assert.equal(currentSession.status, 200)
    assert.deepEqual(await currentSession.json(), { username, canCreate: true })
    assert.equal((await local.request('/v1' + characterPath(b), { headers: { Cookie: cookie } })).status, 200)
    assert.equal((await local.request('/v1' + characterPath(a), { headers: { Cookie: cookie } })).status, 200)
    assert.equal((await local.request('/v1/characters', { method: 'POST', headers: { Cookie: cookie } })).status, 403)

    assert.equal((await submit('passkeys/register/options', { password: oldPassword })).status, 401)
    assert.equal((await submit('passkeys/register/options', { password: newPassword }, cookie)).status, 422)
    const options = await submit('passkeys/register/options', { password: oldPassword }, cookie)
    assert.equal(options.status, 200)
    const { challengeId } = await options.json()
    const second = await submit('login', { username, password: oldPassword })
    const secondCookie = second.headers.get('set-cookie')!.split(';')[0]
    const response = { id: 'fake', rawId: 'fake', type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: 'e30', attestationObject: 'AA' } }
    assert.equal((await submit('passkeys/register/verify', { challengeId, response }, secondCookie)).status, 422)
    assert.equal((await submit('passkeys/register/verify', { challengeId, response }, cookie)).status, 422)
    assert.equal(await owner.adminPasskey.count({ where: { userId: user.id } }), 0)

    assert.equal((await submit('logout', {}, cookie)).status, 200)
    assert.equal((await session(cookie)).status, 401)
    await accountCommand(['reset', username], newPassword)
    assert.equal((await session(secondCookie)).status, 401)
    assert.equal((await submit('login', { username, password: oldPassword })).status, 401)
    const renewed = await submit('login', { username, password: newPassword })
    assert.equal(renewed.status, 200)
    await submit('logout', {}, renewed.headers.get('set-cookie')!.split(';')[0])
  } finally {
    await owner.managementMembership.deleteMany({ where: { issuer: localIssuer, subject: username } })
    await owner.adminUser.deleteMany({ where: { username } })
    await redis.quit()
  }
})

test('account creation gives system-wide access while existing scoped accounts keep their permissions', { timeout: 30_000 }, async () => {
  const authConfig = loadManagementConfig({ RICA_ADMIN_ORIGIN: fixtureOrigin })!
  const redis = new Redis(config.redisUrl)
  const { app: auth, authenticate } = createAdminAuth(management, redis, authConfig)
  const local = createApp({ postgres: async () => true, redis: async () => true },
    createManagementApp({ db: management, authenticate, origin: fixtureOrigin, cookie: authConfig.cookie,
      resolveAdapter: simulationPlatforms.resolveAdapter }), auth)
  const suffix = randomUUID()
  const operatorName = 'web-admin-' + suffix
  const newAdminName = 'web-system-' + suffix
  const name = 'web-user-' + suffix
  const currentPassword = 'operator fixture password'
  const password = 'initial fixture password'
  const replacement = 'replacement fixture password'
  const createInput = { username: newAdminName.toUpperCase(), password, currentPassword }
  const call = (method: string, path: string, cookie = '', data?: object, origin = fixtureOrigin) => local.request(path, {
    method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
  const users = '/v1/auth/users'
  const reset = users + '/' + name + '/password'
  async function login(username: string, password: string) {
    const response = await call('POST', '/v1/auth/login', '', { username, password })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    return cookie
  }

  try {
    const operator = await owner.adminUser.create({ data: {
      username: operatorName, actorId: actorId(localIssuer, operatorName), canCreate: true,
      passwordHash: await hashPassword(currentPassword), createdAt: null,
    } })
    const operatorCookie = await login(operatorName, currentPassword)
    assert.equal((await call('POST', users, '', createInput)).status, 401)
    assert.equal((await call('POST', users, operatorCookie, createInput, 'https://foreign.example.test')).status, 403)
    assert.equal((await call('POST', users, operatorCookie, { ...createInput, canCreate: true })).status, 422)
    assert.equal((await call('POST', users, operatorCookie, { ...createInput, currentPassword: replacement })).status, 422)
    const created = await call('POST', users, operatorCookie, createInput)
    assert.equal(created.status, 201)
    assert.deepEqual(await created.json(), { username: newAdminName })
    assert.equal((await call('POST', users, operatorCookie, createInput)).status, 409)

    const user = await owner.adminUser.create({ data: {
      username: name, actorId: actorId(localIssuer, name), passwordHash: await hashPassword(password),
    } })
    const newAdmin = await owner.adminUser.findUniqueOrThrow({ where: { username: newAdminName } })
    assert.equal(newAdmin.actorId, actorId(localIssuer, newAdminName))
    assert.equal(newAdmin.canCreate, true)
    assert.ok(newAdmin.createdAt)
    const newAdminCookie = await login(newAdminName, password)
    const characters = await call('GET', '/v1/characters', newAdminCookie)
    assert.equal(characters.status, 200)
    assert.ok((await characters.json()).items.some((row: { id: string }) => row.id === b))
    assert.equal((await call('GET', '/v1' + characterPath(a), newAdminCookie)).status, 200)
    assert.equal((await call('GET', '/v1' + characterPath(b), newAdminCookie)).status, 200)
    assert.equal((await call('GET', '/v1' + characterPath(randomUUID()), newAdminCookie)).status, 404)

    const list = await call('GET', users, newAdminCookie)
    assert.equal(list.status, 200)
    const listed = await list.json()
    assert.deepEqual(listed.items.find((row: { username: string }) => row.username === newAdminName),
      { username: newAdminName, createdAt: newAdmin.createdAt.toISOString() })
    assert.deepEqual(listed.items.find((row: { username: string }) => row.username === operatorName),
      { username: operatorName, createdAt: null })
    assert.ok(!listed.items.some((row: { username: string }) => row.username === name))

    assert.equal(user.actorId, actorId(localIssuer, name))
    assert.equal(user.canCreate, false)
    const userCookie = await login(name, password)
    assert.equal((await call('GET', '/v1' + characterPath(a), userCookie)).status, 404)
    await owner.managementMembership.create({ data: { characterId: a, issuer: localIssuer, subject: name } })
    assert.equal((await call('GET', '/v1' + characterPath(a), userCookie)).status, 200)
    assert.equal((await call('GET', users, userCookie)).status, 403)
    assert.equal((await call('POST', users, userCookie, createInput)).status, 403)
    assert.equal((await call('PUT', reset, userCookie, { password: replacement, currentPassword: password })).status, 403)
    assert.equal((await call('PUT', users + '/' + operatorName + '/password', operatorCookie,
      { password: replacement, currentPassword })).status, 409)

    const [permission] = await owner.$queryRaw<{ allowed: boolean }[]>`
      SELECT has_function_privilege('rica_runtime', 'public.rica_manage_local_user(uuid,integer,text,text,text)', 'EXECUTE') AS allowed
    `
    assert.equal(permission.allowed, false)
    const [stale] = await management.$queryRaw<{ code: string }[]>`
      SELECT public.rica_manage_local_user(${operator.id}::uuid, ${operator.authVersion + 1}::int,
        ${name}::text, ${user.passwordHash}::text, 'RESET') AS code
    `
    assert.equal(stale.code, 'FORBIDDEN')

    const passkeys = '/v1/auth/passkeys'
    const removeKey = passkeys + '/' + suffix
    const retainedKey = 'retained-' + suffix
    const otherKey = 'other-' + suffix
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const { x, y } = keyPair.publicKey.export({ format: 'jwk' })
    assert.ok(x && y)
    // COSE EC2 public key with the ES256 algorithm and P-256 curve.
    const publicKey = Buffer.concat([
      Buffer.from('a5010203262001215820', 'hex'), Buffer.from(x, 'base64url'),
      Buffer.from('225820', 'hex'), Buffer.from(y, 'base64url'),
    ])
    async function authenticateFixturePasskey(counter: number) {
      const challenge = await call('POST', passkeys + '/login/options')
      assert.equal(challenge.status, 200)
      const { challengeId, options } = await challenge.json()
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: fixtureOrigin }))
      const authenticatorData = Buffer.alloc(37)
      createHash('sha256').update(authConfig.rpID).digest().copy(authenticatorData)
      authenticatorData[32] = 0x05
      authenticatorData.writeUInt32BE(counter, 33)
      const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]), keyPair.privateKey)
      return call('POST', passkeys + '/login/verify', '', {
        challengeId, response: { id: suffix, rawId: suffix, type: 'public-key', clientExtensionResults: {}, response: {
          clientDataJSON: clientData.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'), userHandle: Buffer.from(user.id).toString('base64url'),
        } },
      })
    }
    await owner.adminPasskey.createMany({ data: [
      { id: suffix, userId: user.id, publicKey, createdAt: null },
      { id: retainedKey, userId: user.id, publicKey },
      { id: otherKey, userId: operator.id, publicKey },
    ] })
    assert.equal((await call('GET', passkeys)).status, 401)
    const listedPasskeys = await call('GET', passkeys, userCookie)
    assert.equal(listedPasskeys.status, 200)
    assert.equal(listedPasskeys.headers.get('cache-control'), 'no-store')
    const [latest, legacy] = (await listedPasskeys.json()).items
    assert.deepEqual(latest, { id: retainedKey, createdAt: new Date(latest.createdAt).toISOString() })
    assert.deepEqual(legacy, { id: suffix, createdAt: null })
    assert.equal((await call('DELETE', removeKey, '', { password })).status, 401)
    assert.equal((await call('DELETE', removeKey, userCookie, { password }, 'https://foreign.example.test')).status, 403)
    assert.equal((await call('DELETE', removeKey, operatorCookie, { password: currentPassword })).status, 404)
    const shortPassword = await call('DELETE', removeKey, userCookie, { password: 'wrong' })
    assert.equal(shortPassword.status, 422)
    assert.equal((await shortPassword.json()).error.code, 'INVALID_CREDENTIALS')
    assert.equal((await call('DELETE', removeKey, userCookie, { password: replacement })).status, 422)
    assert.equal(await owner.adminPasskey.count({ where: { userId: user.id } }), 2)

    const [removePermissions] = await owner.$queryRaw<{ direct: boolean; runtime: boolean }[]>`
      SELECT has_table_privilege('rica_admin_api', 'public.admin_passkeys', 'DELETE') AS direct,
        has_function_privilege('rica_runtime', 'public.rica_remove_passkey(uuid,integer,text)', 'EXECUTE') AS runtime
    `
    assert.deepEqual(removePermissions, { direct: false, runtime: false })
    const [staleRemoval] = await management.$queryRaw<{ removed: boolean }[]>`
      SELECT public.rica_remove_passkey(${user.id}::uuid, ${user.authVersion + 1}::int, ${suffix}::text) AS removed
    `
    assert.equal(staleRemoval.removed, false)
    assert.equal((await authenticateFixturePasskey(1)).status, 200)
    assert.equal((await call('DELETE', removeKey, userCookie, { password })).status, 200)
    const remaining = await call('GET', passkeys, userCookie)
    assert.deepEqual((await remaining.json()).items, [latest])
    assert.ok(await owner.adminPasskey.findUnique({ where: { id: otherKey } }))
    assert.equal((await call('GET', '/v1/auth/session', userCookie)).status, 200)

    const removedLogin = await authenticateFixturePasskey(2)
    assert.equal(removedLogin.status, 401)
    assert.equal((await removedLogin.json()).error.code, 'INVALID_PASSKEY')
    const updated = await call('PUT', reset, operatorCookie, { password: replacement, currentPassword })
    assert.equal(updated.status, 200)
    assert.deepEqual(await updated.json(), { username: name })
    assert.equal(await owner.adminPasskey.count({ where: { userId: user.id } }), 0)
    assert.equal((await call('GET', '/v1/auth/session', userCookie)).status, 401)
    assert.equal((await call('POST', '/v1/auth/login', '', { username: name, password })).status, 401)
    const renewed = await login(name, replacement)
    assert.equal((await call('GET', '/v1' + characterPath(a), renewed)).status, 200)
    assert.equal((await call('GET', '/v1' + characterPath(b), renewed)).status, 404)
  } finally {
    await owner.managementMembership.deleteMany({ where: { issuer: localIssuer, subject: name } })
    await owner.adminUser.deleteMany({ where: { username: { in: [operatorName, newAdminName, name] } } })
    await redis.quit()
  }
})

test('self-service password change verifies the requester and expires old sessions without revoking passkeys', { timeout: 30_000 }, async () => {
  const authConfig = loadManagementConfig({ RICA_ADMIN_ORIGIN: fixtureOrigin })!
  const redis = new Redis(config.redisUrl, { keyPrefix: randomUUID() + ':' })
  const { app: auth } = createAdminAuth(management, redis, authConfig)
  const username = 'self-password-' + randomUUID()
  const currentPassword = 'original fixture password'
  const password = 'new fixture password'
  const passwordHash = await hashPassword(currentPassword)
  const passkeyId = randomUUID()
  const call = (method: string, path: string, cookie = '', data?: object, origin = fixtureOrigin) => auth.request(path, {
    method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
  async function login(secret: string) {
    const response = await call('POST', '/login', '', { username, password: secret })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    return cookie
  }

  try {
    const user = await owner.adminUser.create({ data: { username, actorId: actorId(localIssuer, username), passwordHash } })
    await owner.adminPasskey.create({ data: { id: passkeyId, userId: user.id, publicKey: Buffer.from([1]) } })
    const first = await login(currentPassword)
    const second = await login(currentPassword)
    const input = { currentPassword, password }
    assert.equal((await call('PUT', '/password', '', input)).status, 401)
    assert.equal((await call('PUT', '/password', first, input, 'https://foreign.example.test')).status, 403)
    assert.equal((await call('PUT', '/password', first, { ...input, username: 'other-user' })).status, 422)
    const incorrect = await call('PUT', '/password', first, { ...input, currentPassword: 'wrong fixture password' })
    assert.equal(incorrect.status, 422)
    assert.equal((await incorrect.json()).error.code, 'INVALID_CREDENTIALS')
    const unchanged = await call('PUT', '/password', first, { currentPassword, password: currentPassword })
    assert.equal(unchanged.status, 422)
    assert.equal((await unchanged.json()).error.code, 'PASSWORD_UNCHANGED')
    const updated = await call('PUT', '/password', first, input)
    assert.equal(updated.status, 200)
    assert.match(updated.headers.get('set-cookie') ?? '', /Max-Age=0/i)
    assert.equal((await call('GET', '/session', first)).status, 401)
    assert.equal((await call('GET', '/session', second)).status, 401)
    assert.equal((await call('POST', '/login', '', { username, password: currentPassword })).status, 401)
    const [permission] = await owner.$queryRaw<{ allowed: boolean }[]>`
      SELECT has_function_privilege('rica_runtime', 'public.rica_change_local_password(uuid,integer,text)', 'EXECUTE') AS allowed
    `
    assert.equal(permission.allowed, false)
    const [stale] = await management.$queryRaw<{ changed: boolean }[]>`
      SELECT public.rica_change_local_password(${user.id}::uuid, ${user.authVersion}::int, ${passwordHash}::text) AS changed
    `
    assert.equal(stale.changed, false)
    const next = await login(password)
    const keys = await call('GET', '/passkeys', next)
    assert.equal(keys.status, 200)
    assert.deepEqual((await keys.json()).items.map((key: { id: string }) => key.id), [passkeyId])
  } finally {
    await owner.adminUser.deleteMany({ where: { username } })
    await redis.quit()
  }
})

test('authentication and membership distinguish unauthenticated, forbidden and foreign resources', async () => {
  const absent = await request('GET', characterPath(a), { actor: null })
  assert.equal(absent.status, 401)
  assert.equal((await app.request('/v1' + characterPath(a) + '/identities', {
    method: 'POST', headers: { Cookie: 'fixture-session=admin-a', Origin: 'http://other.example' },
  })).status, 403)
  assert.equal(absent.body.error.requestId, absent.headers.get('x-request-id'))
  assert.equal((await request('GET', characterPath(b))).status, 404)
  const catalog = await request('GET', characterPath(a) + '/plugins')
  assert.equal(catalog.status, 200)
  assert.ok(catalog.body.services.some(({ service }: { service: string }) => service === 'api'))
  assert.ok(catalog.body.services.every(({ report }: { report: unknown }) => report === null))
  assert.equal((await request('GET', characterPath(a) + '/plugins', { actor: 'nonmember' })).status, 404)
  assert.equal((await request('GET', characterPath(a) + '/plugins', { actor: 'admin-b' })).status, 404)

  const adminWorkspace = await request('GET', characterPath(a))
  assert.equal(adminWorkspace.status, 200)
  assert.deepEqual(adminWorkspace.body.simulationPlatforms, ['mock-a', 'mock-b'])
  const membersPath = characterPath(a) + '/memberships'
  const firstMembers = await request('GET', membersPath + '?limit=1')
  assert.equal(firstMembers.status, 200, JSON.stringify(firstMembers.body))
  assert.deepEqual(firstMembers.body.items, [{ subject: 'admin-a' }])
  assert.equal(firstMembers.body.nextCursor, 'admin-a')
  assert.deepEqual((await request('GET', membersPath + '?limit=1&after=admin-a')).body.items,
    [{ subject: 'reviewer' }])
  assert.equal((await request('GET', membersPath, { actor: 'reviewer' })).status, 200)
  assert.equal((await request('GET', membersPath, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('POST', characterPath(a) + '/identities', {
    actor: 'nonmember', key: 'should-not-create', data: { slug: 'forbidden', roleProfile: {} },
  })).status, 404)
  assert.equal((await request('POST', characterPath(a) + '/accounts', {
    key: 'foreign-identity', data: {
      identityId: identityB, platform: 'mock-b', instanceKey: 'integration', remoteAccountId: 'foreign',
    },
  })).status, 404)
  assert.equal((await request('POST', characterPath(a) + '/memberships', {
    key: 'remove-reviewer', data: { subject: 'reviewer', action: 'REVOKE', reason: 'Remove access' },
  })).status, 200)
  assert.equal((await request('POST', characterPath(a) + '/memberships', {
    key: 'last-admin', data: { subject: 'admin-a', action: 'REVOKE', reason: 'Attempt lockout' },
  })).body.error.code, 'LAST_ADMIN')
  assert.equal((await request('GET', characterPath(a), { actor: 'reviewer' })).status, 404)
  assert.equal((await request('POST', membersPath, {
    key: 'reject-old-grant', data: { subject: 'reviewer', role: 'REVIEWER', action: 'GRANT', reason: 'Old payload' },
  })).status, 422)
  assert.equal((await request('GET', characterPath(a), { actor: 'reviewer' })).status, 404)
  assert.deepEqual((await request('GET', '/characters')).body.items.map(({ id }: { id: string }) => id), [a])
})

test('management commands reject stale updates and commit idempotency and audit atomically', async () => {
  const path = characterPath(a)
  const core = { coreProfile: { aiDisclosure: updatedDisclosure } }
  assert.equal((await request('PUT', path + '/core', { data: core })).status, 428)
  const updates = await Promise.all(Array.from({ length: 2 }, () =>
    request('PUT', path + '/core', { ifMatch: '"1"', data: core }),
  ))
  assert.deepEqual(updates.map(({ status }) => status).sort(), [200, 412])
  const character = await request('GET', path)
  assert.equal(character.headers.get('etag'), '"2"')
  assert.equal(character.body.version, 2)

  const data = { slug: 'single-create', roleProfile: { displayName: 'One', writingStyle: 'concise' } }
  assert.equal((await request('POST', path + '/identities', { data })).status, 422)
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    request('POST', path + '/identities', { key: 'same-key', data }),
  ))
  assert.ok(results.every(({ status, body }) => status === 201 && body.id === results[0].body.id))
  assert.equal((await request('POST', path + '/identities', { key: 'same-key', data: { ...data, slug: 'different' } })).status, 409)
  const id = results[0].body.id
  assert.equal((await owner.managementAudit.count({ where: { targetId: id } })), 1)
  await assert.rejects(management.managementAudit.deleteMany({ where: { targetId: id } }), /permission denied/i)
  assert.equal((await owner.managementAudit.count({ where: { targetId: a, operation: 'character.core.update' } })), 1)
  const log = await request('GET', path + '/audit?limit=1')
  assert.equal(log.status, 200)
  assert.equal(log.body.items.length, 1)
  assert.match(log.body.items[0].digest, /^[a-f0-9]{64}$/)
  const next = await request('GET', path + '/audit?limit=1&cursor=' + log.body.nextCursor)
  assert.equal(next.status, 200)
  assert.notEqual(next.body.items[0].id, log.body.items[0].id)
  assert.equal((await request('GET', path + '/identities?cursor=' + identityB)).status, 422)
  const spec = await request('GET', '/openapi.json')
  assert.equal(spec.status, 200)
  assert.ok(spec.body.paths['/characters/{characterId}/core'].put.parameters.some(
    (parameter: { name: string; required: boolean }) => parameter.name === 'if-match' && parameter.required,
  ))
})


async function databaseNow() {
  const [clock] = await owner.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS now`
  return clock.now.getTime()
}

async function proposeReview(accountId = accountA, contactId?: string, model = localSimulationModel, identityId = identityA, review?: ReviewPublicReply) {
  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    const audience = await owner.conversation.create({
      data: {
        characterId: a, identityId, accountId, remoteKey: randomUUID(),
        channel: contactId ? 'PRIVATE' : 'PUBLIC', privateContactId: contactId,
      },
    })
    const proposalText = 'unique review ' + randomUUID()
    const memory = await owner.memory.create({
      data: { characterId: a, identityId, scope: 'IDENTITY', visibility: 'PUBLIC', content: proposalText },
    })
    const source = await owner.sourceRecord.create({
      data: { characterId: a, identityId, kind: 'fixture', sourceKey: randomUUID(), classification: 'PUBLIC' },
    })
    await owner.memorySource.create({ data: { characterId: a, memoryId: memory.id, sourceId: source.id } })
    const grant = await owner.memoryGrant.create({
      data: {
        characterId: a, memoryId: memory.id, recipientIdentityId: identityId, recipientAccountId: accountId,
        ...(contactId
          ? { purpose: 'PRIVATE_REPLY', recipientConversationId: audience.id, recipientContactId: contactId }
          : { purpose: 'PUBLIC_REFERENCE', audience: audience.id }),
        validFrom: new Date('2000-01-01T00:00:00Z'),
        validUntil: new Date('2999-01-01T00:00:00Z'), approvedBy: 'fixture', reason: 'Review fixture',
      },
    })
    const result = await ingestSimulatedEvent(runtime, {
      accountId, conversationId: audience.id, contactId, sourceKey: randomUUID(), kind: 'REPLY',
      occurredAt: new Date(), messageText: proposalText,
    })
    assert.equal(result.status, 'ACCEPTED')
    const runJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, runJob.eventId)
    const draftJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, draftJob.eventId, simulationPlatforms.resolveAdapter, model, undefined, review)
    const action = await owner.actionProposal.findUniqueOrThrow({ where: { runId: result.runId } })
    return { action, grant, proposalText }
  } finally {
    await runtime.$disconnect()
  }
}

function actionPath(id: string) { return characterPath(a) + '/actions/' + id }

test('deployment usage aggregates concurrent writes by role, identity, platform and model with missing-token counts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rica-model-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(url.href)
  const record = hostedUsageRecorder(runtime)
  const day = '2026-01-02'
  const model = 'usage-fixture-' + randomUUID()
  t.after(async () => {
    await owner.hostedModelUsageDaily.deleteMany({ where: { model: { startsWith: model } } })
    await runtime.$disconnect()
  })
  const event = { day, provider: 'openai', model, purpose: 'DRAFT', outcome: 'OK',
    sentBytes: 120, receivedBytes: 75, elapsedMs: 40, tokens: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    attribution: { characterId: a, identityId: identityA, platform: 'mock-a' },
  } as const
  await Promise.all([
    ...Array.from({ length: 6 }, () => record(event)),
    record({ ...event, model: model + '-second', purpose: 'REVIEW', outcome: 'RATE_LIMITED', tokens: undefined,
      attribution: { characterId: b, identityId: identityB, platform: 'newbi' } }),
    record({ ...event, purpose: 'CHECK', attribution: undefined }),
  ])
  await assert.rejects(runtime.hostedModelUsageDaily.count(), /permission denied/i)

  const modelSettings = createModelSettingsStore(directory, modelSettingsContracts)
  const target = createApp({ postgres: async () => true, redis: async () => true }, createManagementApp({
    db: management, origin: fixtureOrigin, cookie: 'fixture-session', resolveAdapter: simulationPlatforms.resolveAdapter,
    authenticate: async (request) => request.headers.has('Cookie') ? {
      id: 'usage-fixture', subject: 'fixture', issuer: localIssuer,
      canCreate: request.headers.get('Cookie') === 'fixture-session=admin-a',
    } : null,
    plugins: [createHostedModelManagement({ modelSettings, isEnabled: async () => false,
      startModelPlugin: async () => assert.fail('Reading usage must not call a model'),
      authorize(actor) { if (actor.issuer !== localIssuer || !actor.canCreate) denyPermission() },
      readUsage: (query) => readHostedUsage(management, query),
    })],
  }))
  const path = '/model-usage?from=' + day + '&through=' + day
  assert.equal((await request('GET', path, { target, actor: null })).status, 401)
  assert.equal((await request('GET', path, { target, actor: 'reviewer' })).status, 403)
  assert.equal((await request('GET', '/model-usage?from=2026-01-01&through=2026-05-01', { target })).status, 422)
  const response = await request('GET', path, { target })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const rows = response.body.rows.filter((row: { model: string }) => row.model.startsWith(model))
  assert.equal(rows.length, 3)
  const draft = rows.find((row: { purpose: string }) => row.purpose === 'DRAFT')
  assert.deepEqual(draft, { day, provider: 'openai', model, characterId: a, character: prefix + '-a', identityId: identityA,
    identity: 'one', platform: 'mock-a', purpose: 'DRAFT', outcome: 'OK', requests: 6, tokenReports: 6,
    sentBytes: 720, receivedBytes: 450, elapsedMs: 240, inputTokens: 72, outputTokens: 48, totalTokens: 120 })
  const review = rows.find((row: { purpose: string }) => row.purpose === 'REVIEW')
  assert.deepEqual([review.characterId, review.identityId, review.platform, review.model, review.tokenReports],
    [b, identityB, 'newbi', model + '-second', 0])
  assert.equal(rows.find((row: { purpose: string }) => row.purpose === 'CHECK').characterId, '')
})

test('role administrators can see the draft and concurrent approval has one effect', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE' } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: accountA }, data: { status: 'ACTIVE' } })
  const role = await request('POST', characterPath(a) + '/memberships', {
    key: 'enable-review', data: { subject: 'reviewer', action: 'GRANT', reason: 'Review fixture' },
  })
  assert.equal(role.status, 200)
  const implementation = localSimulationModel.implementation
  const { action, proposalText } = await proposeReview(accountA, undefined, {
    ...localSimulationModel,
    implementation: { ...implementation, async write(input, signal) {
      assert.equal(input.corePrompt, updatedDisclosure)
      return implementation.write(input, signal)
    } },
  })
  await assert.rejects(proposeReview(accountA, undefined, {
    ...localSimulationModel,
    implementation: { ...implementation, async write() {
      return { text: updatedDisclosure.split('\n')[0], evidenceIds: [] }
    } },
  }), { code: 'P2025' })
  const path = actionPath(action.id)
  const { inboundEvent: trigger } = await owner.agentRun.findUniqueOrThrow({
    where: { id: action.runId }, include: { inboundEvent: true },
  })
  const binding = { characterId: trigger.characterId, identityId: trigger.identityId, accountId: trigger.accountId }
  const sender = await owner.contact.create({ data: { ...binding, remoteKey: randomUUID(), displayLabel: 'Earlier participant' } })
  const unrelated = await owner.conversation.create({ data: { ...binding, remoteKey: randomUUID(), channel: 'PUBLIC' } })
  const earlier = new Date(trigger.occurredAt.getTime() - 60_000)
  await owner.inboundEvent.createMany({ data: [
    { ...binding, conversationId: trigger.conversationId, contactId: sender.id, sourceKey: randomUUID(),
      kind: 'POST', occurredAt: earlier, receivedAt: earlier, messageText: 'Earlier conversation context' },
    { ...binding, conversationId: unrelated.id, sourceKey: randomUUID(),
      kind: 'POST', occurredAt: earlier, receivedAt: earlier, messageText: 'Unrelated conversation' },
    { ...binding, conversationId: trigger.conversationId, sourceKey: randomUUID(),
      kind: 'POST', occurredAt: earlier, receivedAt: new Date(Date.now() + 60_000), messageText: 'Received after the run' },
    { ...binding, conversationId: trigger.conversationId, sourceKey: randomUUID(),
      kind: 'POST', occurredAt: new Date(0), receivedAt: new Date(0), messageText: 'Expired history' },
  ] })
  const adminQueue = await request('GET', characterPath(a) + '/actions')
  assert.equal(adminQueue.status, 200, JSON.stringify(adminQueue.body))
  assert.ok(adminQueue.body.items.some((item: { id: string }) => item.id === action.id))
  assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
  const queue = await request('GET', characterPath(a) + '/actions', { actor: 'reviewer' })
  assert.equal(queue.body.items[0].content, null)
  assert.equal(queue.body.items[0].messageContext, null)
  const preview = await request('GET', path, { actor: 'reviewer' })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.target.accountId, accountA)
  assert.equal(preview.body.content, '供您参考：' + proposalText)
  assert.equal(preview.body.messageContext.trigger.content, proposalText)
  assert.deepEqual(preview.body.messageContext.previous.map(({ sender, content }: { sender: string; content: string }) =>
    [sender, content]), [['Earlier participant', 'Earlier conversation context']])
  const adminPreview = await request('GET', path)
  assert.equal(adminPreview.status, 200, JSON.stringify(adminPreview.body))
  assert.equal(adminPreview.body.content, preview.body.content)
  const ifMatch = preview.headers.get('etag') ?? ''
  const data = { reviewDigest: action.reviewDigest, decision: 'APPROVE', reason: 'Check target and content' }
  const submit = (key: string, body = data, version = ifMatch) =>
    request('POST', path + '/decisions', { actor: 'reviewer', key, ifMatch: version, data: body })

  assert.equal((await submit('missing-if-match', data, '')).status, 428)
  assert.equal((await submit('invalid-digest', { ...data, reviewDigest: '0'.repeat(64) })).status, 409)
  const proposerId = createHash('sha256').update(JSON.stringify([issuer, 'reviewer'])).digest('hex')
  await owner.actionProposal.update({ where: { id: action.id }, data: { proposerId } })
  assert.equal((await request('GET', path, { actor: 'reviewer' })).body.messageContext, null)
  assert.equal((await submit('own-action')).status, 403)
  await owner.actionProposal.update({ where: { id: action.id }, data: { proposerId: null } })

  const results = await Promise.all(['review-1', 'review-2'].map(async (key) => ({ key, result: await submit(key) })))
  assert.deepEqual(results.map(({ result }) => result.status).sort(), [200, 412])
  const success = results.find(({ result }) => result.status === 200)!
  assert.equal(success.result.body.status, 'READY')
  assert.equal((await submit(success.key)).status, 200)
  assert.equal(await owner.actionApproval.count({ where: { actionId: action.id } }), 1)
  assert.equal(await owner.managementAudit.count({ where: { targetId: action.id, operation: 'action.review' } }), 1)

  await owner.character.update({ where: { id: a }, data: { authEpoch: { increment: 1 } } })
  const invalidated = await request('GET', path, { actor: 'reviewer' })
  assert.equal(invalidated.body.state, 'CANCELED')
  assert.equal(invalidated.body.content, null)
  assert.equal(invalidated.body.messageContext, null)
  assert.equal(await owner.managementAudit.count({ where: { targetId: action.id, operation: 'action.invalidate' } }), 1)
})

test('role auto-review settings are private, versioned, and fence in-flight approval when disabled', async () => {
  const path = characterPath(a) + '/auto-review'
  const initial = await request('GET', path)
  assert.deepEqual(initial.body, { enabled: false, prompt: defaultAutoReviewPrompt, version: 0, model: null })
  const first = await proposeReview()
  const input = { enabled: true, prompt: '只批准常规回复。' }
  const save = (version: number, enabled: boolean, actor = 'admin-a') =>
    request('PUT', path, { actor, ifMatch: '"' + version + '"', data: { ...input, enabled } })
  assert.equal((await save(0, true, 'admin-b')).status, 404)
  assert.equal((await save(0, true)).status, 200)
  assert.equal((await save(0, false)).status, 412)
  assert.deepEqual((await request('GET', path)).body, { ...input, version: 1, model: null })

  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(url.href)
  const inspect = (id: string) => request('GET', actionPath(id))
  let verdict: unknown = 'APPROVE\nextra'
  let duringReview: (() => Promise<void>) | undefined
  let observedPrompt: string | undefined
  const review = createAutoReviewer(async (check) => check({
    ...localSimulationModel.implementation, hostedProvider: 'fixture', hostedModel: 'default-review-model',
    async review(prompt) {
      observedPrompt = prompt
      await duringReview?.()
      return verdict
    },
  }))
  try {
    const attempt = (action: typeof first) => autoReviewSimulation(runtime, a, action.action.id, action.proposalText,
      simulationPlatforms.resolveAdapter, review)
    await attempt(first)
    assert.equal(observedPrompt, input.prompt)
    const invalid = await inspect(first.action.id)
    assert.equal(invalid.body.state, 'WAITING_APPROVAL')
    assert.equal(invalid.body.autoReviewHandoff.status, 'UNAVAILABLE')
    assert.equal(invalid.body.autoReviewHandoff.category, 'MODEL')
    verdict = { status: 'REVIEW', reason: '回复含有未核实的事实。' }
    await attempt(first)
    assert.deepEqual((await inspect(first.action.id)).body.autoReviewHandoff, {
      status: 'REVIEW', category: 'RISK', reason: '回复含有未核实的事实。', model: 'fixture/default-review-model',
    })
    const queue = await request('GET', characterPath(a) + '/actions', { actor: 'reviewer' })
    assert.equal(queue.body.items.find(({ id }: { id: string }) => id === first.action.id).autoReviewHandoff, null)
    verdict = { status: 'APPROVE', reason: '回复符合当前讨论。' }
    duringReview = async () => { assert.equal((await save(1, false)).status, 200) }
    await attempt(first)
    assert.equal((await inspect(first.action.id)).body.state, 'WAITING_APPROVAL')
    assert.equal(await owner.actionApproval.count({ where: { actionId: first.action.id } }), 0)

    assert.equal((await save(2, true)).status, 200)
    duringReview = undefined
    const second = await proposeReview(accountA, undefined, localSimulationModel, identityA, review)
    const approved = await inspect(second.action.id)
    assert.equal(approved.body.state, 'READY')
    assert.equal(approved.body.autoApproved, true)
    const approval = await owner.actionApproval.findUniqueOrThrow({ where: { actionId: second.action.id } })
    assert.equal(approval.reviewerId, autoReviewerId)
    assert.equal(approval.reviewDigest, second.action.reviewDigest)
    assert.match(approval.reason, /回复符合当前讨论。\n自动审核规则第 3 版 · fixture\/default-review-model/)

    await owner.simulatedDraft.update({
      where: { characterId_runId: { characterId: a, runId: first.action.runId } }, data: { content: null },
    })
    assert.equal((await owner.actionProposal.findUniqueOrThrow({ where: { id: first.action.id } })).autoReviewHandoff, null)
  } finally {
    await runtime.$disconnect()
    // Later tests share the character and its simulator queue.
    await owner.character.update({ where: { id: a }, data: { autoReviewEnabled: false, authEpoch: { increment: 1 } } })
  }
})

test('review rechecks evidence expiry and adapter version, and records a valid rejection', async () => {
  for (const scenario of ['grant-expiry', 'adapter-change', 'proposal-expiry', 'payload-change', 'reject'] as const) {
    const { action, grant } = await proposeReview()
    const now = await databaseNow()
    if (scenario === 'grant-expiry') {
      await owner.memoryGrant.update({
        where: { id: grant.id }, data: { validFrom: new Date(now - 60_000), validUntil: new Date(now - 1000) },
      })
    } else if (scenario === 'adapter-change') {
      await owner.actionProposal.update({ where: { id: action.id }, data: { adapterVersion: '0.0.1' } })
    } else if (scenario === 'payload-change') {
      await owner.simulatedDraft.update({
        where: { characterId_runId: { characterId: a, runId: action.runId } },
        data: { content: 'Changed draft content' },
      })
    } else if (scenario === 'proposal-expiry') {
      await owner.actionProposal.update({
        where: { id: action.id },
        data: { createdAt: new Date(now - 60_000), expiresAt: new Date(now - 1000) },
      })
    }
    const path = actionPath(action.id)
    const preview = await request('GET', path, { actor: 'reviewer' })
    const rejected = scenario === 'reject'
    const expected = rejected ? 'WAITING_APPROVAL' : scenario === 'proposal-expiry' ? 'EXPIRED' : 'CANCELED'
    const queue = await request('GET', characterPath(a) + '/actions', { actor: 'reviewer' })
    assert.equal(queue.status, 200)
    const listed = queue.body.items.find(({ id }: { id: string }) => id === action.id)
    assert.equal(listed.state, expected)
    assert.equal(listed.content, null)
    assert.equal(preview.body.state, expected)
    assert.equal(Boolean(preview.body.content), rejected)
    const result = await request('POST', path + '/decisions', {
      actor: 'reviewer', key: scenario, ifMatch: preview.headers.get('etag') ?? '',
      data: { reviewDigest: action.reviewDigest, decision: 'REJECT' },
    })
    assert.equal(result.status, rejected ? 200 : 409)
    if (rejected) assert.equal(result.body.status, 'REJECTED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state,
      rejected ? 'REJECTED' : expected)
    assert.equal(await owner.managementAudit.count({ where: { targetId: action.id, operation: 'action.review' } }), 1)
    assert.equal(await owner.actionApproval.count({ where: { actionId: action.id } }), rejected ? 1 : 0)
  }
})


function simulationConnectionString() {
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_simulation_executor')
  return url.toString()
}

function simulationDatabase() {
  return createDatabase(config.databaseUrl, 'rica_simulation_executor')
}

async function approveSimulation(accountId = accountA, contactId?: string, identityId = identityA) {
  const proposal = await proposeReview(accountId, contactId, localSimulationModel, identityId)
  const response = await request('POST', actionPath(proposal.action.id) + '/decisions', {
    actor: 'reviewer', key: 'approve-' + proposal.action.id, ifMatch: '"run-v3"',
    data: { reviewDigest: proposal.action.reviewDigest, decision: 'APPROVE', reason: 'Approved simulation fixture' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return proposal
}

async function newSimulationAccount(identityId = identityA) {
  const account = await owner.platformAccount.create({
    data: {
      characterId: a, identityId, status: 'ACTIVE',
      platform: 'mock-a', instanceKey: 'integration', remoteAccountId: randomUUID(),
    },
  })
  return account.id
}

function simulationZone(hour: number) {
  const shift = (hour - new Date().getUTCHours() + 35) % 24 - 11
  return shift === 0 ? 'UTC' : 'Etc/GMT' + (shift > 0 ? '-' : '+') + Math.abs(shift)
}

test('simulation approval and permit bind adapter ID, implementation and contract version', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: accountA }, data: { status: 'ACTIVE' } })
  const { action: pending } = await proposeReview()
  const scope = { characterId: a, actor: { issuer, subject: 'reviewer', id: actorId(issuer, 'reviewer') } }
  const current = simulationPlatforms.resolveAdapter('mock-a')!
  const replacements = [
    { ...current, adapterId: 'replacement-adapter' },
    { ...current, adapterVersion: '2.0.0' },
    { ...current, adapterContractVersion: 2 },
  ]
  const executor = simulationDatabase()
  try {
    const { items: [active] } = await listReviewActions(management, scope, simulationPlatforms.resolveAdapter, pending.id)
    assert.equal(active.state, 'WAITING_APPROVAL')
    assert.ok(active.content)
    for (const changed of replacements) {
      const resolveChanged = () => changed
      const { items: [preview] } = await listReviewActions(management, scope, resolveChanged, pending.id)
      assert.equal(preview.state, 'CANCELED')
      assert.equal(preview.content, null)
      const { action } = await approveSimulation(await newSimulationAccount())

      // A permit must include the digest from the approval.
      await assert.rejects(executor.$executeRaw`
        INSERT INTO public.simulation_attempts(character_id,action_id,account_id,window_start,permit_until)
        VALUES (${a}::uuid,${action.id}::uuid,${reviewTarget.parse(action.target).accountId}::uuid,
          statement_timestamp(),statement_timestamp()+interval '10 seconds')
      `, /adapter-bound approval/)
      await executeSimulation(executor, action.id, resolveChanged, async () => assert.fail('Replacement adapter reached execution'))
      assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state, 'BLOCKED')
      assert.equal(await owner.simulationAttempt.count({ where: { actionId: action.id } }), 0)
    }
    const rejected = await management.$transaction((tx) => decideReviewAction(tx, scope, pending.id, active.version,
      { decision: 'APPROVE', reviewDigest: pending.reviewDigest, reason: 'Check replaced contract' }, () => replacements[2]))
    assert.equal(rejected.status, 'CANCELED')
    assert.equal(await owner.actionApproval.count({ where: { actionId: pending.id } }), 0)
  } finally {
    await executor.$disconnect()
  }
})

test('disabled platform prevents drafting, review preview and execution permission', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: accountA }, data: { status: 'ACTIVE' } })
  const enabled = await approveSimulation()
  const disabled = await startSimulationPlatforms({ RICA_SIMULATED_PLATFORMS: 'mock-b' })
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const scope = { characterId: a, actor: { issuer, subject: 'reviewer', id: actorId(issuer, 'reviewer') } }
    const { items: [preview] } = await listReviewActions(management, scope, disabled.resolveAdapter, enabled.action.id)
    assert.equal(preview.state, 'CANCELED')
    assert.equal(preview.content, null)

    await executeSimulation(executor, enabled.action.id, disabled.resolveAdapter, async () => assert.fail('Disabled platform reached the adapter'))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: enabled.action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: enabled.action.id } }), 0)

    const { conversationId } = reviewTarget.parse(enabled.action.target)
    const incoming = await ingestSimulatedEvent(runtime, {
      accountId: accountA, conversationId, sourceKey: randomUUID(), kind: 'REPLY',
      occurredAt: new Date(), messageText: 'Disabled platform draft fixture',
    })
    assert.equal(incoming.status, 'ACCEPTED')
    const job = await owner.outboxEvent.findFirstOrThrow({ where: { runId: incoming.runId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, job.eventId)
    const draft = await owner.outboxEvent.findFirstOrThrow({ where: { runId: incoming.runId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, draft.eventId, disabled.resolveAdapter, {
      ...localSimulationModel,
      implementation: {
        async decide() { assert.fail('Disabled platform called the model') },
        async write() { assert.fail('Disabled platform called the model') },
      },
    })
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: incoming.runId } })).state, 'CANCELED')
    assert.equal(await owner.actionProposal.count({ where: { runId: incoming.runId } }), 0)
  } finally {
    await Promise.all([disabled.stop(), runtime.$disconnect(), executor.$disconnect()])
  }
})

test('receipt rechecks an ordinary writing grant after execution is permitted', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  const { action, grant } = await approveSimulation(await newSimulationAccount())
  const executor = simulationDatabase()
  try {
    let permitted = false
    await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      permitted = true
      const now = await databaseNow()
      await owner.memoryGrant.update({
        where: { id: grant.id }, data: { validFrom: new Date(now - 60_000), validUntil: new Date(now - 1000) },
      })
      return recordSimulationReceipt(db, id)
    })
    assert.equal(permitted, true)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: action.id } })).status, 'NOT_SENT')
  } finally {
    await executor.$disconnect()
  }
})

test('simulation defers quiet hours and rejects stale evidence or a paused binding', async () => {
  const executor = simulationDatabase()
  try {
    const quiet = await approveSimulation()
    await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(1) } })
    assert.equal(await reserveSimulation(executor, quiet.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: quiet.action.runId } })).state, 'READY')
    const quietView = await request('GET', characterPath(a) + '/runs/' + quiet.action.runId + '/replay')
    assert.equal(quietView.body.executionWait.reason, 'QUIET_HOURS')
    assert.ok(Date.parse(quietView.body.executionWait.nextAt) > await databaseNow())
    await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })

    const stale = await approveSimulation()
    const now = await databaseNow()
    await owner.memoryGrant.update({
      where: { id: stale.grant.id }, data: { validFrom: new Date(now - 60_000), validUntil: new Date(now - 1000) },
    })
    assert.equal(await reserveSimulation(executor, stale.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: stale.action.runId } })).state, 'BLOCKED')
    assert.equal((await request('GET', characterPath(a) + '/runs/' + stale.action.runId + '/replay')).body.stateReason, 'PAYLOAD_INVALID')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: stale.action.id } }), 0)

    const revoked = await approveSimulation(await newSimulationAccount())
    const revokedGrant = await request('POST', characterPath(a) + '/memory-grants/' + revoked.grant.id + '/revoke', {
      key: 'revoke-before-permit', data: { reason: 'Withdraw evidence after approval' },
    })
    assert.equal(revokedGrant.status, 200)
    await executeSimulation(executor, revoked.action.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Revoked proposal reached the adapter'))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: revoked.action.runId } })).state, 'CANCELED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: revoked.action.id } }), 0)

    // Earlier approvals bind bodies that included the private core setting.
    const legacy = await approveSimulation(await newSimulationAccount())
    const content = 'Previously approved reply\n\nAI 披露：' + updatedDisclosure
    await owner.simulatedDraft.update({
      where: { characterId_runId: { characterId: a, runId: legacy.action.runId } }, data: { content },
    })
    await owner.actionProposal.update({
      where: { id: legacy.action.id }, data: { policyVersion: 3, payloadHash: createHash('sha256').update(content).digest('hex') },
    })
    assert.equal(await reserveSimulation(executor, legacy.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: legacy.action.id } }), 0)

    const paused = await approveSimulation(await newSimulationAccount())
    await executeSimulation(executor, paused.action.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      await owner.character.update({ where: { id: a }, data: { status: 'PAUSED', authEpoch: { increment: 1 } } })
      return recordSimulationReceipt(db, id)
    })
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: paused.action.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: paused.action.id } })).status, 'NOT_SENT')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: paused.action.runId } })).state, 'BLOCKED')
    assert.equal(await reserveSimulation(executor, quiet.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: quiet.action.id } }), 0)
  } finally {
    await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE' } })
    await executor.$disconnect()
  }
})

test('duplicate delivery uses one local receipt and the daily reservation cannot exceed five', async () => {
  const executor = simulationDatabase()
  try {
    const proposals = []
    for (let i = 0; i < 6; i++) proposals.push((await approveSimulation()).action)
    const first = proposals[0]
    await recordSimulationReceipt(executor, first.id)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: first.id } }), 0)

    let calls = 0
    await Promise.all(Array.from({ length: 6 }, () => executeSimulation(executor, first.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      calls++
      return recordSimulationReceipt(db, id)
    })))
    assert.equal(calls, 1)
    for (let round = 0; round < 5; round++) {
      await Promise.all(proposals.slice(1).map(({ id }) => executeSimulation(executor, id, simulationPlatforms.resolveAdapter)))
    }

    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: proposals.map(({ id }) => id) } } }), 5)
    assert.equal(await owner.simulationAttempt.count({ where: { accountId: accountA } }), 5)
    assert.equal(await owner.agentRun.count({
      where: { id: { in: proposals.map(({ runId }) => runId) }, state: 'READY' },
    }), 1)
    const remaining = await owner.agentRun.findFirstOrThrow({
      where: { id: { in: proposals.map(({ runId }) => runId) }, state: 'READY' }, select: { id: true },
    })
    const waiting = await request('GET', characterPath(a) + '/runs/' + remaining.id + '/replay')
    assert.equal(waiting.body.executionWait.reason, 'DAILY_LIMIT')
    await assert.rejects(executor.simulatedDraft.findMany({ select: { content: true } }), /permission denied/i)
  } finally {
    await executor.$disconnect()
  }
})

test('simulation rate limits the same contact across conversations for a rolling hour', async () => {
  const executor = simulationDatabase()
  try {
    const accountId = await newSimulationAccount()
    async function contact() {
      return (await owner.contact.create({
        data: { characterId: a, identityId: identityA, accountId, remoteKey: randomUUID() },
      })).id
    }
    const firstContact = await contact()
    const first = (await approveSimulation(accountId, firstContact)).action
    const second = (await approveSimulation(accountId, firstContact)).action
    const other = (await approveSimulation(accountId, await contact())).action
    await executeSimulation(executor, first.id, simulationPlatforms.resolveAdapter)
    await executeSimulation(executor, second.id, simulationPlatforms.resolveAdapter)
    await executeSimulation(executor, other.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: [first.id, other.id] } } }), 2)
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: second.id } }), 0)
    const blocked = await request('GET', characterPath(a) + '/runs/' + second.runId + '/replay')
    assert.equal(blocked.body.executionWait.reason, 'CONTACT_COOLDOWN')
    assert.ok(Date.parse(blocked.body.executionWait.nextAt) > await databaseNow())

    await owner.simulationReceipt.update({
      where: { actionId: first.id }, data: { createdAt: new Date((await databaseNow()) - 3_601_000) },
    })
    await executeSimulation(executor, second.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: second.id } }), 1)
  } finally {
    await executor.$disconnect()
  }
})

test('role simulation settings authorize and version edits and release a waiting simulation', async () => {
  const path = characterPath(a) + '/simulation-settings'
  const executor = simulationDatabase()
  const previousRole = await owner.character.findUniqueOrThrow({ where: { id: a }, select: { status: true, timezone: true } })
  const previousIdentity = await owner.identity.findUniqueOrThrow({ where: { id: identityA }, select: { status: true } })
  try {
    await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
    await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
    const original = await request('GET', path)
    assert.equal(original.status, 200, JSON.stringify(original.body))
    assert.deepEqual(original.body.settings, defaultSimulationSettings)
    assert.equal((await request('GET', path, { actor: null })).status, 401)
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    const data = { ...original.body.settings, simulationDailyLimit: 1, simulationCooldownMinutes: 90,
      simulationProposalHours: 6, simulationQuietFrom: '11:00', simulationQuietUntil: '13:00' }
    assert.equal((await request('PUT', path, { actor: 'nonmember', ifMatch: '"0"', data })).status, 404)
    assert.equal((await request('PUT', path, { data })).status, 428)
    assert.equal((await request('PUT', path, { ifMatch: '"0"', data: { ...data, simulationDailyLimit: -1 } })).status, 422)
    const changed = await request('PUT', path, { ifMatch: '"0"', data })
    assert.equal(changed.status, 200, JSON.stringify(changed.body))
    assert.equal(changed.body.version, 1)
    assert.deepEqual((await request('GET', path)).body.settings, data)
    assert.equal((await request('PUT', path, { ifMatch: '"0"', data: defaultSimulationSettings })).status, 412)
    assert.deepEqual((await request('GET', characterPath(b) + '/simulation-settings', { actor: 'admin-b' })).body.settings,
      defaultSimulationSettings)

    const accountId = await newSimulationAccount()
    const contact = await owner.contact.create({ data: { characterId: a, identityId: identityA, accountId, remoteKey: randomUUID() } })
    const first = (await approveSimulation(accountId, contact.id)).action
    const second = (await approveSimulation(accountId, contact.id)).action
    assert.ok(Math.abs(first.expiresAt.getTime() - first.createdAt.getTime() - 6 * 3_600_000) < 2_000)
    const replay = async () => (await request('GET', characterPath(a) + '/runs/' + second.runId + '/replay')).body.executionWait
    assert.equal((await replay()).reason, 'QUIET_HOURS')
    const relaxed = { ...data, simulationQuietEnabled: false }
    assert.equal((await request('PUT', path, { ifMatch: '"1"', data: relaxed })).status, 200)
    await executeSimulation(executor, first.id, simulationPlatforms.resolveAdapter)
    assert.equal((await replay()).reason, 'DAILY_LIMIT')
    assert.equal(await reserveSimulation(executor, second.id, simulationPlatforms.resolveAdapter), false)
    assert.equal((await request('PUT', path, { ifMatch: '"2"', data: { ...relaxed, simulationDailyLimit: 0 } })).status, 200)
    assert.equal((await replay()).reason, 'CONTACT_COOLDOWN')
    assert.equal((await request('PUT', path, { ifMatch: '"3"', data: {
      ...relaxed, simulationDailyLimit: 0, simulationCooldownMinutes: 0,
    } })).status, 200)
    assert.equal(await replay(), null)
    await executeSimulation(executor, second.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: [first.id, second.id] } } }), 2)
    assert.equal(await owner.managementAudit.count({ where: { characterId: a, operation: 'simulation.settings' } }), 4)
  } finally {
    await owner.character.update({ where: { id: a }, data: { ...previousRole, ...defaultSimulationSettings, simulationLimitsVersion: 0 } })
    await owner.identity.update({ where: { id: identityA }, data: previousIdentity })
    await executor.$disconnect()
  }
})

async function crashSimulationProcess(actionId: string, checkpoint: 'permit' | 'receipt') {
  const program = `
    import { createDatabase } from '@ricajs/persistence/client'
    import { reserveSimulation, recordSimulationReceipt } from '@ricajs/simulation/execution'
    import { startSimulationPlatforms } from './apps/runtime-plugins.ts'
    const simulationPlatforms = await startSimulationPlatforms({})
    const [id, phase] = process.argv.slice(1)
    const db = createDatabase(process.env.RICA_TEST_SIMULATION_URL)
    if (!await reserveSimulation(db, id, simulationPlatforms.resolveAdapter)) throw new Error('Permit was not issued')
    if (phase === 'receipt' && !await recordSimulationReceipt(db, id)) throw new Error('Receipt was not written')
    process.send(phase)
    process.on('message', () => {})
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, actionId, checkpoint], {
    env: { ...process.env, RICA_TEST_SIMULATION_URL: simulationConnectionString() },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  })
  const closed = once(child, 'close')
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(10_000) }),
      closed.then(() => { throw new Error('Simulation process exited before the checkpoint') }),
    ])
    assert.equal(message, checkpoint)
  } finally {
    child.kill('SIGKILL')
    await closed
  }
}

test('restart and adapter replacement reconcile in-flight attempts without replaying them', async () => {
  const executor = simulationDatabase()
  try {
    const unknownAccount = await newSimulationAccount()
    const lost = (await approveSimulation(unknownAccount)).action
    const waiting = (await approveSimulation(unknownAccount)).action
    const recorded = (await approveSimulation(await newSimulationAccount())).action
    const notSent = (await approveSimulation(await newSimulationAccount())).action
    await crashSimulationProcess(lost.id, 'permit')
    await crashSimulationProcess(recorded.id, 'receipt')

    // The persisted proposals belong to the old adapter after a process replacement.
    await owner.actionProposal.updateMany({
      where: { id: { in: [lost.id, recorded.id, notSent.id] } }, data: { adapterVersion: '0.0.1' },
    })
    await executeSimulation(executor, notSent.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Old approval reached the replacement adapter'))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: notSent.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: notSent.id } }), 0)

    const expired = new Date((await databaseNow()) - 1000)
    await owner.simulationAttempt.updateMany({
      where: { actionId: { in: [lost.id, recorded.id] } }, data: { permitUntil: expired },
    })
    await runSimulationBatch(executor, null, simulationPlatforms.resolveAdapter)
    await runSimulationBatch(executor, null, simulationPlatforms.resolveAdapter)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: lost.runId } })).state, 'RECONCILING')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: recorded.runId } })).state, 'SIMULATED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: waiting.runId } })).state, 'READY')
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: { in: [lost.id, waiting.id] } } }), 0)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: recorded.id } }), 1)

    const replayPath = characterPath(a) + '/runs/' + lost.runId + '/replay'
    const unknown = await request('GET', replayPath)
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body))
    assert.equal(unknown.body.proposal.attemptStatus, 'UNKNOWN')
    assert.ok(unknown.body.proposal.permittedAt)
    assert.equal(unknown.body.proposal.receiptAt, null)

    const path = actionPath(lost.id) + '/reconciliation'
    assert.equal((await request('GET', path, { actor: 'nonmember' })).status, 404)
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    const pending = await request('GET', path)
    assert.equal(pending.body.evidenceRef, null)
    assert.equal((await request('POST', path, {
      key: 'resolve-prematurely', ifMatch: pending.headers.get('etag') ?? '',
      data: { outcome: 'DEFINITELY_NOT_SENT', evidenceRef: '0'.repeat(64), reason: 'Too early' },
    })).status, 409)

    await owner.simulationAttempt.update({
      where: { actionId: lost.id }, data: { permitUntil: new Date((await databaseNow()) - 16 * 60_000) },
    })
    const review = await request('GET', path)
    assert.equal(review.status, 200)
    assert.equal(review.body.outcome, 'DEFINITELY_NOT_SENT')
    const ifMatch = review.headers.get('etag') ?? ''
    const decision = {
      outcome: review.body.outcome, evidenceRef: review.body.evidenceRef, reason: 'Checked sealed local ledger',
    }
    assert.equal((await request('POST', path, {
      key: 'forged-evidence', ifMatch, data: { ...decision, outcome: 'CONFIRMED' },
    })).status, 409)
    const resolved = await request('POST', path, { key: 'correct-resolution', ifMatch, data: decision })
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body))
    assert.equal(resolved.body.status, 'BLOCKED')
    assert.equal((await request('POST', path, { key: 'correct-resolution', ifMatch, data: decision })).status, 200)
    assert.equal(await owner.managementAudit.count({ where: { targetId: lost.id, operation: 'simulation.resolve' } }), 1)
    const attempt = await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: lost.id } })
    assert.equal(attempt.status, 'NOT_SENT')
    assert.equal(attempt.resolutionEvidence, decision.evidenceRef)
    assert.equal(attempt.resolutionReason, decision.reason)
    const closed = await request('GET', replayPath)
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.equal(closed.body.proposal.attemptStatus, 'NOT_SENT')
    assert.equal(closed.body.proposal.permittedAt, unknown.body.proposal.permittedAt)
    assert.equal(closed.body.proposal.receiptAt, null)
    assert.equal(JSON.stringify(closed.body).includes(decision.reason), false)
    await assert.rejects(executor.simulationAttempt.findMany({ select: { resolutionReason: true } }), /permission denied/i)

    await runSimulationBatch(executor, null, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: waiting.id } }), 1)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: lost.id } }), 0)
  } finally {
    await executor.$disconnect()
  }
})


function scheduleRuntimeUrl() {
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_runtime')
  return url.toString()
}

async function scheduleConversation() {
  return owner.conversation.create({
    data: {
      characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID(), channel: 'PUBLIC',
    },
  })
}

test('daily schedule slots skip spring gaps and choose the earlier fall overlap', async () => {
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const zone = 'America/New_York'
    const gap = await dailyScheduleSlot(runtime, zone, '02:30', new Date('2026-03-08T06:00:00Z'))
    assert.equal(gap.toISOString(), '2026-03-09T06:30:00.000Z')
    const fold = await dailyScheduleSlot(runtime, zone, '01:30', new Date('2026-11-01T04:00:00Z'))
    assert.equal(fold.toISOString(), '2026-11-01T05:30:00.000Z')
    const afterFirst = await dailyScheduleSlot(runtime, zone, '01:30', new Date('2026-11-01T05:45:00Z'))
    assert.equal(afterFirst.toISOString(), '2026-11-02T06:30:00.000Z')
  } finally {
    await runtime.$disconnect()
  }
})

test('parallel schedule scans catch up only the latest eligible slot and edits cancel the old run', async () => {
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    await owner.character.update({ where: { id: a }, data: { timezone: 'UTC' } })
    const conversation = await scheduleConversation()
    const path = characterPath(a) + '/schedules'
    const plan = {
      scheduleKey: 'daily-fixture', accountId: accountA, conversationId: conversation.id, enabled: true,
      zone: 'UTC', rule: { kind: 'DAILY', localTime: '09:00' },
    }
    assert.equal((await request('POST', path, { actor: 'nonmember', key: 'forbidden-schedule', data: plan })).status, 404)
    const created = await request('POST', path, { key: 'daily-fixture', data: plan })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const stale = await request('POST', path, {
      key: 'late-fixture', data: { ...plan, scheduleKey: 'late-fixture', rule: { kind: 'DAILY', localTime: '08:00' } },
    })
    assert.equal(stale.status, 201, JSON.stringify(stale.body))
    assert.deepEqual((await request('GET', path)).body.items.map(({ scheduleKey }: { scheduleKey: string }) => scheduleKey),
      ['daily-fixture', 'late-fixture'])
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    const scheduleId = created.body.id
    await owner.simulationSchedule.updateMany({
      where: { id: { in: [scheduleId, stale.body.id] } }, data: { nextAt: new Date('2026-03-10T08:00:00Z') },
    })
    const now = new Date('2026-03-12T10:30:00Z')
    await Promise.all(Array.from({ length: 6 }, () => scanSimulationSchedules(runtime, null, now)))
    await scanSimulationSchedules(runtime, null, new Date('2026-03-11T10:30:00Z'))
    const occurrences = await owner.scheduleOccurrence.findMany({ where: { scheduleId } })
    assert.equal(occurrences.length, 1)
    assert.equal(occurrences[0].scheduledAt.toISOString(), '2026-03-12T09:00:00.000Z')
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: stale.body.id } }), 0)
    const runId = occurrences[0].runId
    assert.equal(await owner.outboxEvent.count({ where: { runId, type: runQueuedEvent } }), 1)
    assert.equal(await owner.managementAudit.count({ where: { targetId: runId, operation: 'schedule.fire' } }), 1)
    await assert.rejects(ingestSimulatedEvent(runtime, {
      accountId: accountA, sourceKey: 'schedule:forged', kind: 'POST', occurredAt: now,
    }), /Invalid simulated event/)

    const disabled = await request('PUT', path + '/' + scheduleId, {
      ifMatch: '"1"', data: { zone: plan.zone, rule: plan.rule, enabled: false },
    })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.body.version, 2)
    const run = await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })
    assert.equal(run.state, 'CANCELED')
    assert.equal(run.stateReason, 'SCHEDULE_CHANGED')
    assert.equal(await owner.managementAudit.count({ where: { targetId: runId, operation: 'schedule.invalidate' } }), 1)
    assert.equal((await request('PUT', path + '/' + scheduleId, {
      ifMatch: '"1"', data: { zone: plan.zone, rule: plan.rule, enabled: true },
    })).status, 412)
    await owner.simulationSchedule.update({ where: { id: stale.body.id }, data: { enabled: false, nextAt: null } })
  } finally {
    await runtime.$disconnect()
  }
})

test('changing simulation quiet hours wakes a deferred reminder and applies the catch-up window', async () => {
  const runtime = createDatabase(scheduleRuntimeUrl())
  const settingsPath = characterPath(a) + '/simulation-settings'
  const previousRole = await owner.character.findUniqueOrThrow({ where: { id: a }, select: { status: true, timezone: true } })
  const previousIdentity = await owner.identity.findUniqueOrThrow({ where: { id: identityA }, select: { status: true } })
  const previousAccount = await owner.platformAccount.findUniqueOrThrow({ where: { id: accountA }, select: { status: true } })
  try {
    await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: 'UTC' } })
    await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
    await owner.platformAccount.update({ where: { id: accountA }, data: { status: 'ACTIVE' } })
    const now = new Date(await databaseNow())
    const next = new Date(now.getTime() + 120 * 60_000)
    const reminder = await owner.simulationSchedule.create({
      data: { characterId: a, identityId: identityA, accountId: accountA, conversationId: (await scheduleConversation()).id,
        scheduleKey: 'settings-reminder', zone: 'UTC', kind: 'REMINDER', dueAt: new Date(now.getTime() - 60_000), nextAt: next },
    })
    const dailyAt = new Date('2026-03-12T09:00:00Z')
    const daily = await owner.simulationSchedule.create({
      data: { characterId: a, identityId: identityA, accountId: accountA, conversationId: reminder.conversationId,
        scheduleKey: 'settings-daily', zone: 'UTC', kind: 'DAILY', localTime: '09:00', nextAt: dailyAt },
    })
    assert.equal((await request('PUT', settingsPath, { ifMatch: '"0"', data: {
      ...defaultSimulationSettings, simulationQuietEnabled: false, simulationCatchUpMinutes: 30,
    } })).status, 200)
    const woken = await owner.simulationSchedule.findUniqueOrThrow({ where: { id: reminder.id } })
    assert.ok(woken.nextAt!.getTime() < next.getTime())
    await dispatchSimulationSchedule(runtime, reminder.id, new Date(await databaseNow()))
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: reminder.id } }), 1)
    await dispatchSimulationSchedule(runtime, daily.id, new Date('2026-03-12T10:00:00Z'))
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: daily.id } }), 0)
    await owner.simulationSchedule.update({ where: { id: daily.id }, data: { enabled: false, nextAt: null } })
  } finally {
    await owner.character.update({ where: { id: a }, data: { ...previousRole, ...defaultSimulationSettings, simulationLimitsVersion: 0 } })
    await owner.identity.update({ where: { id: identityA }, data: previousIdentity })
    await owner.platformAccount.update({ where: { id: accountA }, data: previousAccount })
    await runtime.$disconnect()
  }
})

test('an overdue reminder survives quiet hours and reaches the normal Worker once', async () => {
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const conversation = await scheduleConversation()
    const dueAt = '2025-12-30T05:30:00.000Z'
    const created = await request('POST', characterPath(a) + '/schedules', {
      key: 'commitment-fixture',
      data: {
        scheduleKey: 'commitment-fixture', accountId: accountA, conversationId: conversation.id,
        zone: 'UTC', enabled: true, rule: { kind: 'REMINDER', dueAt },
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const id = created.body.id
    await scanSimulationSchedules(runtime, null, new Date('2026-01-02T03:00:00Z'))
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: id } }), 0)
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id } })).nextAt?.toISOString(),
      '2026-01-02T08:00:00.000Z')
    for (let i = 0; i < 2; i++) await scanSimulationSchedules(runtime, null, new Date('2026-01-02T08:00:00Z'))
    const occurrences = await owner.scheduleOccurrence.findMany({ where: { scheduleId: id } })
    assert.equal(occurrences.length, 1)
    assert.equal(occurrences[0].scheduledAt.toISOString(), dueAt)
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id } })).nextAt, null)
    const worker = await startOutboxWorker(scheduleRuntimeUrl(), config.redisUrl, () => localSimulationModel, simulationPlatforms.resolveAdapter)
    try {
      const runId = occurrences[0].runId
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if ((await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })).state === 'CONTEXT_READY') break
        await sleep(50)
      }
      assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })).state, 'CONTEXT_READY')
      assert.equal(await owner.outboxEvent.count({ where: { runId, type: runQueuedEvent, processedAt: { not: null } } }), 1)

      await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
      const live = await request('POST', characterPath(a) + '/schedules', {
        key: 'worker-scanned-reminder',
        data: {
          scheduleKey: 'worker-scanned-reminder', accountId: accountA, conversationId: conversation.id,
          zone: 'UTC', enabled: true, rule: { kind: 'REMINDER', dueAt: new Date(Math.min(await databaseNow(), Date.now()) - 10_000).toISOString() },
        },
      })
      assert.equal(live.status, 201)
      let state: string | undefined
      const scanDeadline = Date.now() + 10_000
      while (Date.now() < scanDeadline) {
        const occurrence = await owner.scheduleOccurrence.findFirst({
          where: { scheduleId: live.body.id }, select: { run: { select: { state: true } } },
        })
        state = occurrence?.run.state
        if (state === 'CONTEXT_READY') break
        await sleep(50)
      }
      assert.equal(state, 'CONTEXT_READY')
      assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: live.body.id } }), 1)
    } finally {
      await worker.close()
    }
  } finally {
    await runtime.$disconnect()
  }
})


async function commitmentFixture(privateRecipient = false) {
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12), status: 'ACTIVE' } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  const accountId = await newSimulationAccount()
  const contact = privateRecipient ? await owner.contact.create({
    data: { characterId: a, identityId: identityA, accountId, remoteKey: randomUUID() },
  }) : null
  const { action } = await approveSimulation(accountId, contact?.id)
  const due = new Date()
  due.setUTCHours(3, 0, 0, 0)
  due.setUTCDate(due.getUTCDate() + 1)
  return { accountId, contactId: contact?.id, action, due }
}

async function confirmCommitmentReceipt(actionId: string) {
  const executor = simulationDatabase()
  try {
    await executeSimulation(executor, actionId, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId } }), 1)
  } finally {
    await executor.$disconnect()
  }
}

test('ordinary replies cannot register timing from generated or previously stored follow-ups', async () => {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  for (const kind of ['PLAN', 'COMMITMENT'] as const) {
    const accountId = await newSimulationAccount()
    const followUp = {
      kind, title: 'Untrusted follow-up ' + kind, task: '整理活动报名问题',
      ...(kind === 'PLAN' ? { dailyAt: '13:00', zone: 'Asia/Hong_Kong' }
        : { dueAt: new Date(await databaseNow() + 86_400_000).toISOString() }),
    }
    const model = {
      ...localSimulationModel,
      implementation: {
        hostedModel: 'fixture',
        decide: async () => 'REPLY',
        write: async () => ({ text: '我会在明天整理活动报名问题。', evidenceIds: [], followUp }),
      },
    }
    const { action } = await proposeReview(accountId, undefined, model)
    const path = actionPath(action.id)
    assert.equal((await request('GET', path, { actor: 'reviewer' })).body.followUp, null)
    // A proposal written before the change can still carry a previously reviewed follow-up.
    await owner.actionProposal.update({ where: { id: action.id }, data: { followUp } })
    const preview = await request('GET', path, { actor: 'reviewer' })
    assert.equal(preview.body.followUp.kind, kind)
    const decide = await request('POST', path + '/decisions', {
      actor: 'reviewer', key: 'follow-up-' + action.id, ifMatch: preview.headers.get('etag')!,
      data: { decision: 'APPROVE', reason: 'Approve the simulated reply', reviewDigest: action.reviewDigest },
    })
    assert.equal(decide.status, 200, JSON.stringify(decide.body))
    await confirmCommitmentReceipt(action.id)
    await confirmCommitmentReceipt(action.id)
    assert.equal(await owner.simulationPlan.count({ where: { characterId: a, title: followUp.title } }), 0)
    assert.equal(await owner.simulationCommitment.count({ where: { actionId: action.id } }), 0)
    assert.equal(await owner.simulationSchedule.count({ where: { accountId } }), 0)
  }
})

test('commitments require a confirmed receipt and preserve its recipient across filters', async () => {
  const { accountId, contactId, action, due } = await commitmentFixture(true)
  const path = characterPath(a) + '/commitments'
  const { runId } = await owner.actionProposal.findUniqueOrThrow({ where: { id: action.id }, select: { runId: true } })
  const candidates = characterPath(a) + '/commitment-receipts?runId=' + runId
  const identity = await request('POST', characterPath(a) + '/identities', {
    key: 'commitment-collaborator-identity', data: { slug: 'commitment-helper', roleProfile: {} },
  })
  assert.equal(identity.status, 201, JSON.stringify(identity.body))
  const helper = await owner.platformAccount.create({
    data: { characterId: a, identityId: identity.body.id, platform: 'external-fixture', instanceKey: 'integration', remoteAccountId: randomUUID() },
  })
  const collaborator = { identityId: helper.identityId, accountId: helper.id }
  const details = { title: 'Follow up with the recipient', task: 'Deliver the promised report',
    dueAt: due.toISOString(), reason: 'Confirmed agreement', collaborators: [collaborator] }
  const data = { ...details, actionId: action.id }

  assert.equal((await request('POST', path, { key: 'unconfirmed-commitment', data })).status, 404)
  assert.deepEqual((await request('GET', candidates)).body.items, [])
  await confirmCommitmentReceipt(action.id)
  assert.equal((await request('GET', candidates, { actor: 'nonmember' })).status, 404)
  const choices = await request('GET', candidates)
  assert.equal(choices.status, 200, JSON.stringify(choices.body))
  assert.deepEqual(choices.body.items.map(({ id, identityId, contactId: recipient }: { id: string; identityId: string; contactId: string }) =>
    ({ id, identityId, recipient })), [{ id: action.id, identityId: identityA, recipient: contactId }])
  assert.deepEqual((await request('GET', characterPath(b) + '/commitment-receipts?runId=' + runId, { actor: 'admin-b' })).body.items, [])
  assert.equal((await request('POST', path, { actor: 'nonmember', key: 'reviewer-commitment', data })).status, 404)
  assert.equal((await request('POST', characterPath(b) + '/commitments', {
    actor: 'admin-b', key: 'foreign-commitment', data,
  })).status, 404)
  assert.equal((await request('POST', path, { key: 'forged-scope', data: { ...data, accountId: accountA } })).status, 422)
  assert.equal((await request('POST', path, { key: 'forged-collaborator', data: {
    ...data, collaborators: [{ ...collaborator, accountId: accountA }],
  } })).status, 409)
  assert.equal((await request('POST', path, { key: 'owner-as-collaborator', data: {
    ...data, collaborators: [{ identityId: identityA, accountId }],
  } })).status, 409)

  const result = await request('POST', path, { key: 'confirmed-commitment', data })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  assert.equal((await request('POST', path, { key: 'confirmed-commitment', data })).body.id, result.body.id)
  assert.equal((await request('POST', path, { key: 'duplicate-receipt', data })).status, 409)
  assert.deepEqual((await request('GET', candidates)).body.items, [])
  const list = await request('GET', path + '?accountId=' + accountId + '&contactId=' + contactId)
  assert.equal(list.status, 200)
  assert.equal(list.body.items.length, 1)
  const [commitment] = list.body.items
  assert.equal(commitment.actionId, action.id)
  assert.equal(commitment.contactId, contactId)
  assert.equal(commitment.identityId, identityA)
  assert.equal(commitment.task, details.task)
  assert.equal(commitment.collaborators[0].platform, 'external-fixture')
  assert.deepEqual((await request('GET', path + '?accountId=' + accountA)).body.items, [])

  const schedulePath = characterPath(a) + '/schedules/' + commitment.scheduleId
  assert.equal((await request('PUT', schedulePath, {
    ifMatch: '"1"', data: { zone: 'UTC', enabled: false, rule: { kind: 'REMINDER', dueAt: data.dueAt } },
  })).status, 409)
  const commitmentPath = path + '/' + result.body.id
  const edited = await request('PUT', commitmentPath, {
    ifMatch: '"1"', data: { ...details, operation: 'EDIT', task: 'Deliver a revised report', collaborators: [] },
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  const [updated] = (await request('GET', path + '?accountId=' + accountId)).body.items
  assert.equal(updated.task, 'Deliver a revised report')
  assert.deepEqual(updated.collaborators, [])
  assert.equal(updated.contactId, contactId)
  assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id: commitment.scheduleId } })).version, 1)
  assert.equal((await request('PUT', commitmentPath, {
    ifMatch: '"1"', data: { ...details, operation: 'EDIT' },
  })).status, 412)
  const fulfilled = await request('PUT', commitmentPath, {
    ifMatch: '"2"', data: { operation: 'FULFILL', reason: 'Agreement completed' },
  })
  assert.equal(fulfilled.body.status, 'FULFILLED')
  assert.equal((await request('PUT', commitmentPath, {
    ifMatch: '"3"', data: { ...details, operation: 'EDIT' },
  })).status, 409)
  assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id: commitment.scheduleId } })).nextAt, null)
  assert.equal(await owner.simulationSchedule.count({
    where: { scheduleKey: 'commitment:' + result.body.id },
  }), 1)
})

test('a commitment reminder catches up once, and defer or cancel invalidates its pending runs', async () => {
  const { action, due } = await commitmentFixture()
  await confirmCommitmentReceipt(action.id)
  await owner.character.update({ where: { id: a }, data: { timezone: 'UTC' } })
  const path = characterPath(a) + '/commitments'
  const result = await request('POST', path, {
    key: 'commitment-catchup',
    data: { actionId: action.id, title: 'Deadline reminder', task: 'Follow up on the agreement', collaborators: [],
      dueAt: due.toISOString(), reason: 'Follow-up agreement' },
  })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  const id = result.body.id
  const { scheduleId } = await owner.simulationCommitment.findUniqueOrThrow({ where: { id } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const overnight = new Date(due.getTime() + 86_400_000)
    const morning = new Date(overnight.getTime() + 5 * 3_600_000)
    await scanSimulationSchedules(runtime, null, overnight)
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId } }), 0)
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).nextAt?.toISOString(),
      morning.toISOString())
    await Promise.all([scanSimulationSchedules(runtime, null, morning), scanSimulationSchedules(runtime, null, morning)])
    const [first] = await owner.scheduleOccurrence.findMany({ where: { scheduleId } })
    assert.equal(first.scheduledAt.toISOString(), due.toISOString())
    assert.equal(await owner.outboxEvent.count({ where: { runId: first.runId, type: runQueuedEvent } }), 1)
    const replay = await request('GET', characterPath(a) + '/runs/' + first.runId + '/replay')
    assert.equal(replay.status, 200)
    assert.equal(replay.body.schedule.commitmentId, id)
    assert.equal(new Date(replay.body.schedule.scheduledAt).toISOString(), due.toISOString())

    const newDue = new Date(morning.getTime() + 86_400_000 + 3_600_000)
    const deferred = await request('PUT', path + '/' + id, {
      ifMatch: '"1"', data: { operation: 'DEFER', dueAt: newDue.toISOString(), reason: 'Recipient requested more time' },
    })
    assert.equal(deferred.status, 200, JSON.stringify(deferred.body))
    assert.equal(deferred.body.status, 'DEFERRED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: first.runId } })).stateReason, 'SCHEDULE_CHANGED')
    await scanSimulationSchedules(runtime, null, newDue)
    const occurrences = await owner.scheduleOccurrence.findMany({ where: { scheduleId }, orderBy: { scheduledAt: 'asc' } })
    assert.equal(occurrences.length, 2)
    assert.equal(occurrences[1].scheduleVersion, 2)

    const canceled = await request('PUT', path + '/' + id, {
      ifMatch: '"2"', data: { operation: 'CANCEL', reason: 'Recipient canceled' },
    })
    assert.equal(canceled.body.status, 'CANCELED')
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: occurrences[1].runId } })).state, 'CANCELED')
    assert.equal((await owner.simulationSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).nextAt, null)
    assert.deepEqual((await owner.commitmentRevision.findMany({
      where: { commitmentId: id }, orderBy: { version: 'asc' },
    })).map(({ state, reason }) => [state, reason]), [
      ['OPEN', 'Follow-up agreement'], ['DEFERRED', 'Recipient requested more time'], ['CANCELED', 'Recipient canceled'],
    ])
  } finally {
    await runtime.$disconnect()
  }
})


test('run replay masks expired and revoked evidence and keeps the original trace scoped', async () => {
  const { action, grant, proposalText } = await proposeReview(await newSimulationAccount())
  const root = characterPath(a)
  const path = root + '/runs/' + action.runId + '/replay'
  const membership = await request('POST', root + '/memberships', {
    key: 'observability-auditor', data: { subject: 'auditor', action: 'GRANT', reason: 'Audit fixture' },
  })
  assert.equal(membership.status, 200)
  assert.equal((await request('GET', path, { actor: null })).status, 401)
  assert.equal((await request('GET', path, { actor: 'nonmember' })).status, 404)
  assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('GET', characterPath(b) + '/runs/' + action.runId + '/replay', { actor: 'admin-b' })).status, 404)

  const replay = await request('GET', path, { actor: 'auditor' })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(replay.body.proposal.id, action.id)
  assert.equal(replay.body.state, 'WAITING_APPROVAL')
  assert.equal(replay.body.mode, 'SIMULATION')
  const evidence = (response: typeof replay) => response.body.snapshots.find(
    ({ purpose }: { purpose: string }) => purpose === 'PUBLIC_REFERENCE',
  ).evidence
  assert.deepEqual(evidence(replay), [{ rank: 1, available: true, memoryId: grant.memoryId, revision: 1 }])
  assert.equal(JSON.stringify(replay.body).includes(proposalText), false)

  await owner.memoryGrant.update({
    where: { id: grant.id },
    data: { validFrom: new Date((await databaseNow()) - 120_000), validUntil: new Date((await databaseNow()) - 1000) },
  })
  const expired = await request('GET', path, { actor: 'auditor' })
  assert.deepEqual(evidence(expired), [{ rank: 1, available: false }])
  assert.equal(expired.body.stateVersion, replay.body.stateVersion)
  assert.equal(expired.body.proposal.id, action.id)

  const revoked = await request('POST', root + '/memory-grants/' + grant.id + '/revoke', {
    key: 'replay-revocation', data: { reason: 'Remove replay access' },
  })
  assert.equal(revoked.status, 200)
  const after = await request('GET', path)
  assert.deepEqual(evidence(after), [{ rank: 1, available: false }])
  assert.equal(after.body.state, 'CANCELED')
  assert.equal(JSON.stringify(after.body).includes(grant.memoryId), false)
})

test('monitoring reports only the current character’s backlog without triggering work', async () => {
  const path = characterPath(a) + '/monitoring'
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const before = await request('GET', path, { actor: 'auditor' })
  assert.equal(before.status, 200, JSON.stringify(before.body))
  assert.equal((await request('GET', path, { actor: 'nonmember' })).status, 404)
  assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
  const otherBefore = await request('GET', characterPath(b) + '/monitoring', { actor: 'admin-b' })
  assert.equal(otherBefore.status, 200)

  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const { action } = await approveSimulation(await newSimulationAccount())
    await assert.rejects(executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter, async () => {
      throw new Error('Outcome unknown')
    }), /Outcome unknown/)
    await proposeReview(await newSimulationAccount())
    const run = await ingestSimulatedEvent(runtime, {
      accountId: accountA, sourceKey: randomUUID(), kind: 'MENTION', occurredAt: new Date(),
    })
    assert.equal(run.status, 'ACCEPTED')
    await owner.outboxEvent.updateMany({ where: { runId: run.runId }, data: { enqueuedAt: new Date() } })
    const conversation = await scheduleConversation()
    const created = await request('POST', characterPath(a) + '/schedules', {
      key: 'monitoring-schedule',
      data: {
        scheduleKey: 'monitoring-schedule', accountId: accountA, conversationId: conversation.id,
        zone: 'UTC', enabled: true, rule: { kind: 'REMINDER', dueAt: new Date((await databaseNow()) - 1000).toISOString() },
      },
    })
    assert.equal(created.status, 201)

    const after = await request('GET', path, { actor: 'auditor' })
    assert.equal(after.status, 200, JSON.stringify(after.body))
    for (const category of ['outbox', 'approvals', 'reconciliation', 'schedules']) {
      assert.equal(after.body[category].count, before.body[category].count + 1, category)
      assert.ok(after.body[category].oldestAt)
    }
    assert.equal(after.body.outbox.enqueued, before.body.outbox.enqueued + 1)
    const otherAfter = await request('GET', characterPath(b) + '/monitoring', { actor: 'admin-b' })
    const counts = ({ observedAt: _, ...rest }: Record<string, unknown>) => rest
    assert.deepEqual(counts(otherAfter.body), counts(otherBefore.body))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: run.runId } })).state, 'QUEUED')
    assert.equal(await owner.scheduleOccurrence.count({ where: { scheduleId: created.body.id } }), 0)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('grant and account management enforce bound references and revoke access with an epoch change', async () => {
  const path = characterPath(a)
  const memory = await owner.memory.create({
    data: { characterId: a, identityId: identityA, scope: 'IDENTITY', visibility: 'PUBLIC', content: 'Private persistence fixture' },
  })
  const audience = await owner.conversation.create({
    data: { characterId: a, identityId: identityA, accountId: accountA, remoteKey: prefix, channel: 'PUBLIC' },
  })
  const now = await databaseNow()
  const data = {
    memoryId: memory.id, recipientIdentityId: identityA, recipientAccountId: accountA,
    purpose: 'PUBLIC_REFERENCE', audience: audience.id, reason: 'Public grant',
    validFrom: new Date(now - 1000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
  }
  const foreign = await request('POST', path + '/memory-grants', {
    key: 'wrong-recipient', data: { ...data, recipientIdentityId: identityB },
  })
  assert.equal(foreign.status, 404)
  const grant = await request('POST', path + '/memory-grants', { key: 'public-grant', data })
  assert.equal(grant.status, 201, JSON.stringify(grant.body))
  const revoke = await request('POST', path + '/memory-grants/' + grant.body.id + '/revoke', {
    key: 'revoke-grant', data: { reason: 'Remove public access' },
  })
  assert.equal(revoke.status, 200)
  assert.equal(revoke.body.authEpoch, grant.body.authEpoch + 1)
  const ownContact = await owner.contact.create({ data: {
    characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID(), displayLabel: 'Grant fixture contact',
  } })
  const otherContact = await owner.contact.create({ data: { characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID() } })
  const privateConversation = await owner.conversation.create({ data: {
    characterId: a, identityId: identityA, accountId: accountA, remoteKey: randomUUID(),
    channel: 'PRIVATE', privateContactId: ownContact.id,
  } })
  const options = path + '/identities/' + identityA + '/conversations?accountId=' + accountA + '&channel=PRIVATE&limit=100'
  const choices = await request('GET', options)
  assert.equal(choices.status, 200, JSON.stringify(choices.body))
  assert.deepEqual(choices.body.items.find((item: { id: string }) => item.id === privateConversation.id), {
    id: privateConversation.id, channel: 'PRIVATE', privateContactId: ownContact.id, contactLabel: 'Grant fixture contact',
  })
  assert.ok(choices.body.items.every((item: { channel: string }) => item.channel === 'PRIVATE'))
  assert.equal((await request('GET', options + '&cursor=' + audience.id)).status, 422)
  assert.equal((await request('GET', options, { actor: 'nonmember' })).status, 404)
  const wrongIdentity = path + '/identities/' + identityB + '/conversations?accountId=' + accountA
  assert.equal((await request('GET', wrongIdentity)).status, 404)
  const privateData = { ...data, purpose: 'PRIVATE_REPLY', audience: undefined,
    recipientConversationId: privateConversation.id, recipientContactId: ownContact.id }
  assert.equal((await request('POST', path + '/memory-grants', {
    key: 'wrong-private-contact', data: { ...privateData, recipientContactId: otherContact.id },
  })).status, 404)
  const privateGrant = await request('POST', path + '/memory-grants', { key: 'private-grant', data: privateData })
  assert.equal(privateGrant.status, 201, JSON.stringify(privateGrant.body))
  const grants = await request('GET', path + '/memory-grants?memoryId=' + memory.id)
  const savedGrant = grants.body.items.find(({ id }: { id: string }) => id === grant.body.id)
  assert.ok(savedGrant)
  assert.ok(savedGrant.revokedAt)
  assert.equal(grants.body.items.length, 2)
  const privateMetadata = grants.body.items.find(({ id }: { id: string }) => id === privateGrant.body.id)
  assert.equal(privateMetadata.recipientContactId, ownContact.id)
  assert.equal(privateMetadata.recipientConversationId, privateConversation.id)
  const memories = await request('GET', path + '/memories?identityId=' + identityA + '&scope=IDENTITY&status=ACTIVE&limit=100',
    { actor: 'auditor' })
  assert.equal(memories.status, 200)
  const savedMemory = memories.body.items.find(({ id }: { id: string }) => id === memory.id)
  assert.ok(savedMemory)
  assert.ok(!('content' in savedMemory))
  assert.ok(memories.body.items.every((item: { identityId: string; scope: string; status: string }) =>
    item.identityId === identityA && item.scope === 'IDENTITY' && item.status === 'ACTIVE'))
  await assert.rejects(management.memory.findMany({ select: { content: true } }), /permission denied/i)
  const approved = (await approveSimulation()).action
  const account = await request('POST', path + '/controls', {
    key: 'revoke-account', data: { scope: 'ACCOUNT', scopeId: accountA, operation: 'REVOKE_ACCOUNT', reason: 'Unlink' },
  })
  assert.equal(account.status, 200)
  assert.equal(account.body.status, 'REVOKED')
  const bound = await owner.platformAccount.findUniqueOrThrow({ where: { id: accountA } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    const payload = {
      id: 'revoked-simulated-subject', account: bound.remoteAccountId, thread: audience.remoteKey,
      kind: 'REPLY', occurredAt: new Date().toISOString(), text: 'Reply after revocation',
    }
    assert.deepEqual(await ingest({ accountId: bound.id, platform: bound.platform, instanceKey: bound.instanceKey, verifiedRemoteAccountId: bound.remoteAccountId }, payload),
      { status: 'ACCOUNT_UNAVAILABLE' })
    assert.equal(await owner.inboundEvent.count({ where: { accountId: bound.id, sourceKey: payload.id } }), 0)
    await executeSimulation(executor, approved.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Revoked account reached the adapter'))
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: approved.id } }), 0)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
  assert.equal((await request('POST', path + '/controls', {
    key: 'resume-revoked', data: { scope: 'ACCOUNT', scopeId: accountA, operation: 'RESUME', reason: 'Rejected transition' },
  })).status, 409)
})

test('memory correction revokes old citations and descendants and keeps a metadata trail', async () => {
  const { action, grant } = await proposeReview(await newSimulationAccount())
  const memoryId = grant.memoryId
  const child = await deriveMemory(owner, { characterId: a, parentMemoryId: memoryId, content: 'Derived old claim' })
  const path = characterPath(a) + '/memories/' + memoryId
  const initial = await request('GET', path + '/provenance')
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('etag'), '"1"')
  assert.equal(initial.body.sources.length, 1)
  const detail = await request('GET', path, { actor: 'auditor' })
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  assert.deepEqual(detail.body.provenance, initial.body)
  assert.equal(detail.body.memory.id, memoryId)
  assert.equal(detail.body.memory.createdAt, (await owner.memory.findUniqueOrThrow({ where: { id: memoryId } })).createdAt.toISOString())
  assert.equal('content' in detail.body.memory, false)
  assert.equal((await request('GET', path, { actor: 'nonmember' })).status, 404)
  assert.equal((await request('GET', characterPath(b) + '/memories/' + memoryId, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('GET', characterPath(b) + '/memories/' + memoryId + '/provenance', { actor: 'admin-b' })).status, 404)
  const options = { ifMatch: '"1"', data: { content: 'Corrected claim', reason: 'Check source' } }
  assert.equal((await request('PUT', path + '/correction', { ...options, actor: 'nonmember' })).status, 404)
  const outcomes = await Promise.all([request('PUT', path + '/correction', options), request('PUT', path + '/correction', options)])
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [200, 412])
  assert.equal((await owner.memory.findUniqueOrThrow({ where: { id: memoryId } })).content, 'Corrected claim')
  const derived = await owner.memory.findUniqueOrThrow({ where: { id: child.id } })
  assert.equal(derived.status, 'REVOKED')
  assert.equal(derived.content, '')
  assert.ok((await owner.memoryGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt)
  const trace = await request('GET', path + '/provenance')
  assert.equal(trace.body.revision, 2)
  assert.deepEqual(trace.body.corrections.map(({ revision }: { revision: number }) => revision), [2])
  assert.ok(!JSON.stringify(trace.body).includes('Corrected claim'))
  const replay = await request('GET', characterPath(a) + '/runs/' + action.runId + '/replay')
  const evidence = replay.body.snapshots.flatMap((snapshot: { evidence: { available: boolean }[] }) => snapshot.evidence)
  assert.ok(evidence.length > 0 && evidence.every(({ available }: { available: boolean }) => !available))
})

test('explicit contact opt-out blocks an in-flight send and old approval stays blocked after release', async () => {
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const accountId = await newSimulationAccount()
  const otherAccountId = await newSimulationAccount()
  const remoteKey = randomUUID()
  const contact = await owner.contact.create({ data: { characterId: a, identityId: identityA, accountId, remoteKey } })
  const otherContact = await owner.contact.create({
    data: { characterId: a, identityId: identityA, accountId: otherAccountId, remoteKey },
  })
  const inFlight = (await approveSimulation(accountId, contact.id)).action
  const old = (await approveSimulation(accountId, contact.id)).action
  const independent = (await approveSimulation(otherAccountId, otherContact.id)).action
  const target = reviewTarget.parse(inFlight.target)
  const account = await owner.platformAccount.findUniqueOrThrow({ where: { id: accountId } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    let stopRunId: string | undefined
    await executeSimulation(executor, inFlight.id, simulationPlatforms.resolveAdapter, async (database, id) => {
      const result = await ingest({
        accountId, platform: account.platform, instanceKey: account.instanceKey, verifiedRemoteAccountId: account.remoteAccountId,
      }, {
        id: randomUUID(), account: account.remoteAccountId, thread: target.conversation, sender: remoteKey,
        kind: 'REPLY', occurredAt: new Date().toISOString(), text: '不要联系我。',
      })
      assert.equal(result.status, 'ACCEPTED')
      stopRunId = result.runId
      return recordSimulationReceipt(database, id)
    })
    assert.ok(stopRunId)
    const stopEvent = await owner.outboxEvent.findFirstOrThrow({ where: { runId: stopRunId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, stopEvent.eventId)
    const stopDraft = await owner.outboxEvent.findFirstOrThrow({ where: { runId: stopRunId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, stopDraft.eventId, simulationPlatforms.resolveAdapter, localSimulationModel)
    assert.equal(await owner.actionProposal.count({ where: { runId: stopRunId } }), 0)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: inFlight.id } }), 0)
    assert.equal((await owner.simulationAttempt.findUniqueOrThrow({ where: { actionId: inFlight.id } })).status, 'NOT_SENT')
    const path = characterPath(a) + '/contacts/' + contact.id + '/boundary'
    const boundary = await request('GET', path)
    assert.equal(boundary.status, 200)
    assert.equal(boundary.body.blocked, true)
    assert.equal(boundary.body.version, 1)
    const contactPath = characterPath(a) + '/identities/' + identityA + '/contacts?limit=100'
    const contactList = await request('GET', contactPath, { actor: 'auditor' })
    assert.equal(contactList.status, 200, JSON.stringify(contactList.body))
    const contactRow = contactList.body.items.find((item: { id: string }) => item.id === contact.id)
    assert.deepEqual(contactRow, { id: contact.id, accountId, version: 1, blocked: true, label: contact.displayLabel })
    assert.equal((await request('GET', contactPath, { actor: 'nonmember' })).status, 404)
    assert.equal((await owner.contact.findUniqueOrThrow({ where: { id: otherContact.id } })).noContactAt, null)
    assert.equal(await owner.managementAudit.count({ where: { targetId: contact.id, operation: 'contact.opt_out' } }), 1)

    const options = { ifMatch: '"1"', data: { blocked: false, reason: 'Verified renewed consent' } }
    assert.equal((await request('PUT', path, { ...options, actor: 'nonmember' })).status, 404)
    assert.equal((await request('PUT', path, { ...options, ifMatch: '"0"' })).status, 412)
    assert.equal((await request('PUT', path, options)).status, 200)
    await executeSimulation(executor, old.id, simulationPlatforms.resolveAdapter, async () => assert.fail('Old approval was revived'))
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: old.id } }), 0)
    await executeSimulation(executor, independent.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: independent.id } }), 1)
    const fresh = (await approveSimulation(accountId, contact.id)).action
    const released = await owner.contact.findUniqueOrThrow({ where: { id: contact.id } })
    assert.ok(released.boundaryChangedAt)
    const backdated = await owner.agentRun.update({
      where: { id: fresh.runId }, data: { createdAt: new Date(released.boundaryChangedAt.getTime() - 1000) },
    })
    assert.equal(backdated.contactBoundaryVersion, 2)
    await executeSimulation(executor, fresh.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: fresh.id } }), 1)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

async function beliefEvidence(sourceId?: string, accountId?: string, expiresAt?: Date) {
  const source = sourceId ? { id: sourceId } : await owner.sourceRecord.create({
    data: { characterId: a, identityId: identityA, accountId, kind: 'fixture', sourceKey: randomUUID(), classification: 'PERSONAL' },
  })
  const memory = await owner.memory.create({
    data: {
      characterId: a, identityId: identityA, accountId, scope: accountId ? 'ACCOUNT' : 'IDENTITY',
      visibility: 'PERSONAL', content: 'Belief fixture', expiresAt,
    },
  })
  await owner.memorySource.create({ data: { characterId: a, memoryId: memory.id, sourceId: source.id } })
  return { sourceId: source.id, citation: { memoryId: memory.id, memoryRevision: 1, direction: 'SUPPORT', weight: 1 } }
}

const beliefCollection = (identityId: string) => characterPath(a) + '/identities/' + identityId + '/beliefs'
const beliefData = (evidence: unknown[], statement = 'I prefer a quiet workspace') => ({
  kind: 'PREFERENCE', statement, reason: 'Reviewed evidence', evidence,
})

test('belief evolution counts origin sources once and records strong conflict without overwriting history', async () => {
  const first = await beliefEvidence()
  const duplicate = await beliefEvidence(first.sourceId)
  const independent = await beliefEvidence()
  const contrary = await beliefEvidence()
  const collection = beliefCollection(identityA)
  const initial = await request('POST', collection, { key: 'belief-pending', data: beliefData([first.citation]) })
  assert.equal(initial.status, 201, JSON.stringify(initial.body))
  assert.equal(initial.body.status, 'PENDING')
  const path = collection + '/' + initial.body.id
  const pendingReplay = await request('PUT', path, { ifMatch: '"1"', data: beliefData([duplicate.citation]) })
  assert.equal(pendingReplay.body.status, 'PENDING')
  assert.equal((await request('PUT', path, {
    ifMatch: '"2"', data: beliefData([first.citation, duplicate.citation]),
  })).status, 422)
  assert.equal((await request('POST', collection, {
    key: 'belief-value', data: { ...beliefData([first.citation, independent.citation]), kind: 'VALUE' },
  })).status, 422)
  const evidence = [first.citation, independent.citation]
  const promoted = await request('PUT', path, { ifMatch: '"2"', data: beliefData(evidence) })
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
  assert.equal(promoted.body.status, 'ACTIVE')
  assert.equal((await request('GET', path)).body.confidence, 0.7)
  assert.equal((await request('PUT', path, {
    ifMatch: '"3"', data: beliefData([duplicate.citation, independent.citation]),
  })).status, 200)
  assert.equal((await request('GET', path)).body.confidence, 0.7)
  const disputed = await request('PUT', path, {
    ifMatch: '"4"', data: beliefData([...evidence, { ...contrary.citation, direction: 'OPPOSE' }]),
  })
  assert.equal(disputed.body.status, 'DISPUTED')
  assert.equal((await request('GET', path + '?revision=4')).body.status, 'ACTIVE')
})

test('belief rollback appends a revision and cannot restore revoked or out-of-scope evidence', async () => {
  const first = await beliefEvidence()
  const second = await beliefEvidence()
  const third = await beliefEvidence()
  const accountOnly = await beliefEvidence(undefined, accountA)
  const collection = beliefCollection(identityA)
  assert.equal((await request('POST', collection, {
    key: 'belief-account', data: beliefData([first.citation, accountOnly.citation]),
  })).status, 422)
  const initial = await request('POST', collection, {
    key: 'belief-restore', data: beliefData([first.citation, second.citation]),
  })
  assert.equal(initial.status, 201, JSON.stringify(initial.body))
  const path = collection + '/' + initial.body.id
  assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('GET', beliefCollection(identityB) + '/' + initial.body.id)).status, 404)
  assert.equal((await request('PUT', path, {
    ifMatch: '"1"', data: beliefData([second.citation, third.citation], 'I prefer to work outside'),
  })).status, 200)
  const data = { restoreVersion: 1, reason: 'Restore the previous preference' }
  assert.equal((await request('POST', path + '/restore', { ifMatch: '"1"', data })).status, 412)
  const restored = await request('POST', path + '/restore', { ifMatch: '"2"', data })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  assert.equal(restored.body.version, 3)
  assert.equal((await request('GET', path)).body.restoredFrom, 1)
  const summaries = await request('GET', collection, { actor: 'auditor' })
  assert.equal(summaries.status, 200, JSON.stringify(summaries.body))
  assert.deepEqual(summaries.body.items.find((item: { id: string }) => item.id === initial.body.id),
    { id: initial.body.id, kind: 'PREFERENCE', version: 3 })
  assert.equal((await request('GET', beliefCollection(identityB))).status, 404)
  assert.equal((await request('GET', collection, { actor: 'nonmember' })).status, 404)

  assert.equal(await revokeMemoryAccess(owner, { kind: 'SOURCE', characterId: a, id: first.sourceId }), true)
  for (const url of [path, path + '?revision=1']) {
    const view = await request('GET', url)
    assert.equal(view.body.status, 'INVALIDATED')
    assert.equal(view.body.statement, null)
    assert.equal(view.body.confidence, null)
    assert.deepEqual(view.body.evidence, [])
    assert.deepEqual(view.body.remainingEvidence, { supportingSources: 1, opposingSources: 0, confidence: 0.6 })
  }
  assert.equal((await request('POST', path + '/restore', { ifMatch: '"3"', data })).status, 409)
  const replacement = await request('PUT', path, {
    ifMatch: '"3"', data: beliefData([second.citation, third.citation], 'I prefer to work outside'),
  })
  assert.equal(replacement.body.status, 'ACTIVE')
  assert.equal((await request('GET', path)).body.version, 4)
})

async function reflectionIdentity(roleProfile: Record<string, unknown> = {}, characterId = a) {
  const created = await request('POST', characterPath(characterId) + '/identities', {
    key: randomUUID(), data: { slug: 'reflection-' + randomUUID(), roleProfile },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id: string = created.body.id
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE' } })
  await owner.identity.update({ where: { id }, data: { status: 'ACTIVE' } })
  return id
}

function reflectionPath(identityId: string, utcDay: string) {
  return characterPath(a) + '/identities/' + identityId + '/reflections/' + utcDay
}

async function reflectionDay() {
  const date = new Date((await databaseNow()) - 86_400_000)
  date.setUTCHours(12, 0, 0, 0)
  return { date, utcDay: date.toISOString().slice(0, 10) }
}

test('daily reflection deduplicates runs and creates only an identity-local pending preference', async () => {
  const identityId = await reflectionIdentity()
  const otherIdentity = await reflectionIdentity()
  const { date, utcDay } = await reflectionDay()
  const account = await owner.platformAccount.create({
    data: {
      characterId: a, identityId, status: 'ACTIVE', platform: 'mock-a',
      instanceKey: 'integration', remoteAccountId: randomUUID(),
    },
  })
  const conversation = await owner.conversation.create({
    data: { characterId: a, identityId, accountId: account.id, remoteKey: randomUUID(), channel: 'PUBLIC' },
  })
  await owner.inboundEvent.create({
    data: {
      characterId: a, identityId, accountId: account.id, conversationId: conversation.id, sourceKey: randomUUID(), kind: 'POST',
      occurredAt: date, receivedAt: date, messageText: 'unverified fixture message',
    },
  })
  const memory = await owner.memory.create({
    data: { characterId: a, identityId, scope: 'IDENTITY', visibility: 'PERSONAL', content: 'private experience', createdAt: date },
  })
  const source = await owner.sourceRecord.create({
    data: { characterId: a, identityId, kind: 'fixture', sourceKey: randomUUID(), classification: 'PERSONAL' },
  })
  await owner.memorySource.create({ data: { characterId: a, memoryId: memory.id, sourceId: source.id } })
  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    await Promise.all([scanIdentityReflections(runtime, null), scanIdentityReflections(runtime, null)])
    const path = reflectionPath(identityId, utcDay)
    const reflection = await request('GET', path)
    assert.equal(reflection.status, 200, JSON.stringify(reflection.body))
    assert.deepEqual(reflection.body.observedActivity, { kind: 'OBSERVED_ACTIVITY', simulatedReceipts: 0 })
    assert.deepEqual(reflection.body.unverifiedExternal, { kind: 'UNVERIFIED_EXTERNAL', inboundMessages: 1 })
    assert.equal(reflection.body.fictionalProfile.kind, 'FICTIONAL_PROFILE')
    assert.equal(JSON.stringify(reflection.body).includes('unverified fixture message'), false)
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    assert.equal((await request('GET', reflectionPath(otherIdentity, utcDay))).body.candidateBeliefId, null)
    const beliefId = reflection.body.candidateBeliefId
    const beliefPath = beliefCollection(identityId) + '/' + beliefId
    const belief = await request('GET', beliefPath)
    assert.equal(belief.body.status, 'PENDING')
    assert.equal(belief.body.evidence[0].memoryId, memory.id)
    assert.equal(await owner.beliefVersion.count({ where: { characterId: a, identityId } }), 1)

    assert.equal(await revokeMemoryAccess(owner, { kind: 'SOURCE', characterId: a, id: source.id }), true)
    assert.equal((await request('GET', beliefPath)).body.status, 'INVALIDATED')
  } finally {
    await runtime.$disconnect()
  }
})

test('daily reflection plans a bounded autonomous goal only with identity permission', async () => {
  const policy = { topic: 'REVIEW_INTERACTIONS', maxDays: 2, budget: 4 }
  const identityId = await reflectionIdentity({ autonomousGoal: policy })
  const disabled = await reflectionIdentity()
  const { date, utcDay } = await reflectionDay()
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const account = await newSimulationAccount(identityId)
  const otherAccount = await newSimulationAccount(disabled)
  const executor = simulationDatabase()
  try {
    for (const [accountId, id] of [[account, identityId], [otherAccount, disabled]]) {
      const { action } = await approveSimulation(accountId, undefined, id)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state, 'SIMULATED')
      await owner.simulationReceipt.update({ where: { actionId: action.id }, data: { createdAt: date } })
    }
  } finally {
    await executor.$disconnect()
  }

  const base = characterPath(a) + '/identities/' + identityId
  const goals = base + '/goals'
  const manual = {
    title: 'Manual fixture', status: 'ACTIVE', priority: 50, budget: 5, reason: 'Existing plan',
    dueAt: new Date((await databaseNow()) + 86_400_000).toISOString(),
  }
  for (const key of ['existing-plan-1', 'existing-plan-2']) {
    assert.equal((await request('POST', goals, { key, data: manual })).status, 201)
  }

  const runtimeUrl = new URL(config.databaseUrl)
  runtimeUrl.searchParams.set('options', '-c role=rica_runtime')
  const runtime = createDatabase(runtimeUrl.toString())
  try {
    let cursor: string | null = null
    do { cursor = await scanIdentityReflections(runtime, cursor) } while (cursor)
  } finally {
    await runtime.$disconnect()
  }
  for (const id of [identityId, disabled]) {
    const reflection = await request('GET', reflectionPath(id, utcDay))
    assert.equal(reflection.status, 200, JSON.stringify(reflection.body))
    assert.equal(reflection.body.observedActivity.simulatedReceipts, 1)
  }
  const list = await request('GET', goals)
  assert.equal(list.status, 200, JSON.stringify(list.body))
  const [self] = list.body.filter(({ origin }: { origin: string }) => origin === 'SELF')
  assert.equal(list.body.length, 3)
  assert.equal(self.status, 'ACTIVE')
  assert.equal(self.reflectionDay, utcDay)
  assert.equal(self.topic, policy.topic)
  assert.equal(self.budget, policy.budget)
  assert.equal(Date.parse(self.dueAt) - Date.parse(self.createdAt), 2 * 86_400_000)
  assert.ok(self.nextStep)
  assert.deepEqual((await request('GET', characterPath(a) + '/identities/' + disabled + '/goals')).body, [])
  assert.equal((await request('POST', goals, { key: 'fourth-goal', data: manual })).body.error.code, 'GOAL_LIMIT')

  const { action } = await proposeReview(account, undefined, localSimulationModel, identityId)
  const replay = await request('GET', characterPath(a) + '/runs/' + action.runId + '/replay')
  assert.ok(replay.body.goalRefs.some(({ id, version }: { id: string; version: number }) => id === self.id && version === 1))
  const path = goals + '/' + self.id
  assert.equal((await request('PUT', path, { ifMatch: '"1"', data: manual })).body.error.code, 'GOAL_SELF_MANAGED')

  const revoked = await request('PUT', base, {
    ifMatch: '"1"', data: { roleProfile: {}, reason: 'Withdraw autonomous goal permission' },
  })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  const canceled = await request('GET', path)
  assert.equal(canceled.body.status, 'CANCELED')
  assert.equal(canceled.body.version, 2)
  assert.equal((await request('GET', path + '?revision=1')).body.status, 'ACTIVE')
})

test('external low-risk automation is assessed per account without enabling a simulator', async () => {
  const identityId = await reflectionIdentity()
  const active = await newSimulationAccount(identityId)
  const paused = await newSimulationAccount(identityId)
  await owner.platformAccount.update({ where: { id: paused }, data: { status: 'PAUSED' } })
  const path = (id: string) => characterPath(a) + '/accounts/' + id + '/automation-eligibility'
  assert.equal((await request('GET', path(active), { actor: 'nonmember' })).status, 404)
  assert.equal((await request('GET', path(active), { actor: 'admin-b' })).status, 404)
  const activeView = await request('GET', path(active))
  const pausedView = await request('GET', path(paused))
  assert.equal(activeView.status, 200, JSON.stringify(activeView.body))
  assert.deepEqual(activeView.body, {
    accountId: active, identityId, bindingVersion: 1, eligible: false, reasons: ['SIMULATION_ONLY', 'EXTERNAL_AUTO_DISABLED'],
  })
  assert.equal(pausedView.status, 200, JSON.stringify(pausedView.body))
  assert.equal(pausedView.body.eligible, false)
  assert.deepEqual(pausedView.body.reasons, ['BINDING_INACTIVE', 'SIMULATION_ONLY', 'EXTERNAL_AUTO_DISABLED'])
})

async function beliefReviewAccount() {
  await owner.character.update({ where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityA }, data: { status: 'ACTIVE' } })
  return newSimulationAccount()
}

test('subjective belief projection stays inside decisions and expired references block execution', { timeout: 20_000 }, async () => {
  const expiresAt = new Date((await databaseNow()) + 8000)
  const first = await beliefEvidence(undefined, undefined, expiresAt)
  const second = await beliefEvidence()
  const statement = 'I prefer a shaded trail'
  const created = await request('POST', beliefCollection(identityA), {
    key: 'belief-decision-projection', data: beliefData([first.citation, second.citation], statement),
  })
  assert.equal(created.body.status, 'ACTIVE')
  const reference = { id: created.body.id, version: 1 }
  const model: typeof localSimulationModel = {
    ...localSimulationModel,
    implementation: {
      async decide(input, signal) {
        assert.deepEqual(input.context.beliefs.find(({ id }) => id === reference.id), {
          ...reference, kind: 'PREFERENCE', statement, confidence: 0.7, subjective: true,
        })
        return localSimulationModel.implementation.decide(input, signal)
      },
      async write(input, signal) {
        assert.equal('context' in input, false)
        assert.equal(JSON.stringify(input).includes(statement), false)
        return localSimulationModel.implementation.write(input, signal)
      },
    },
  }
  const { action } = await proposeReview(await beliefReviewAccount(), undefined, model)
  const approval = await request('POST', actionPath(action.id) + '/decisions', {
    actor: 'reviewer', key: 'approve-belief-projection', ifMatch: '"run-v3"',
    data: { reviewDigest: action.reviewDigest, decision: 'APPROVE', reason: 'Belief projection fixture' },
  })
  assert.equal(approval.status, 200, JSON.stringify(approval.body))
  const path = characterPath(a) + '/runs/' + action.runId + '/replay'
  const replay = await request('GET', path)
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.ok(replay.body.beliefRefs.some(({ id, version }: { id: string; version: number }) => id === reference.id && version === 1))
  assert.equal(JSON.stringify(replay.body).includes(statement), false)

  const waiting = await approveSimulation(await newSimulationAccount())
  const executor = simulationDatabase()
  try {
    let permitted = false
    await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter, async (db, id) => {
      permitted = true
      while ((await databaseNow()) < expiresAt.getTime()) await sleep(100)
      return recordSimulationReceipt(db, id)
    })
    assert.equal(permitted, true)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
    assert.equal(await reserveSimulation(executor, waiting.action.id, simulationPlatforms.resolveAdapter), false)
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: waiting.action.runId } })).state, 'BLOCKED')
    assert.equal(await owner.simulationAttempt.count({ where: { actionId: waiting.action.id } }), 0)
  } finally {
    await executor.$disconnect()
  }
})

test('subjective belief supersession during decision prevents the in-flight proposal', async () => {
  const first = await beliefEvidence()
  const second = await beliefEvidence()
  const third = await beliefEvidence()
  const collection = beliefCollection(identityA)
  const created = await request('POST', collection, {
    key: 'belief-in-flight', data: beliefData([first.citation, second.citation]),
  })
  assert.equal(created.body.status, 'ACTIVE')
  let runId: string | undefined
  const model: typeof localSimulationModel = {
    ...localSimulationModel,
    implementation: {
      ...localSimulationModel.implementation,
      async decide({ context }) {
        runId = context.runId
        assert.ok(context.beliefs.some(({ id, version }) => id === created.body.id && version === 1))
        const updated = await request('PUT', collection + '/' + created.body.id, {
          ifMatch: '"1"', data: beliefData([second.citation, third.citation], 'I prefer to work outside'),
        })
        assert.equal(updated.body.status, 'ACTIVE')
        return 'REPLY'
      },
    },
  }
  await assert.rejects(proposeReview(await beliefReviewAccount(), undefined, model), { code: 'P2025' })
  assert.ok(runId)
  const run = await owner.agentRun.findUniqueOrThrow({ where: { id: runId } })
  assert.equal(run.state, 'CANCELED')
  assert.equal(run.stateReason, 'DRAFT_UNAVAILABLE')
})

test('manual goal cap is atomic and replay pins the identity version of active goals', async () => {
  const path = characterPath(a) + '/identities/' + identityA + '/goals'
  const data = {
    title: 'Preserve a local activity plan', status: 'ACTIVE', budget: 2, priority: 60,
    dueAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Configure local simulation',
  }
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    request('POST', path, { key: 'm2-goal-' + i, data })))
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 201, 201, 409])
  const initial = await request('GET', path)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.length, 3)
  const id: string = initial.body[0].id
  const goalPath = path + '/' + id
  const foreign = characterPath(b) + '/identities/' + identityA + '/goals/' + id
  assert.equal((await request('GET', foreign, { actor: 'admin-b' })).status, 404)
  const otherIdentity = await owner.identity.findFirstOrThrow({ where: { characterId: a, id: { not: identityA } } })
  assert.equal((await request('GET', characterPath(a) + '/identities/' + otherIdentity.id + '/goals/' + id)).status, 404)
  assert.equal((await request('PUT', goalPath, { ifMatch: '"1"', data, actor: 'nonmember' })).status, 404)

  const { action } = await proposeReview(await newSimulationAccount())
  const replayPath = characterPath(a) + '/runs/' + action.runId + '/replay'
  const replay = await request('GET', replayPath)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.goalRefs.length, 3)
  assert.ok(replay.body.goalRefs.some((ref: { id: string; version: number }) => ref.id === id && ref.version === 1))
  assert.ok(!JSON.stringify(replay.body).includes(data.title))
  assert.equal((await request('PUT', goalPath, { ifMatch: '"1"', data: { ...data, status: 'PAUSED' } })).status, 200)
  assert.equal((await request('GET', goalPath + '?revision=1')).body.status, 'ACTIVE')
  assert.equal((await request('GET', goalPath)).body.status, 'PAUSED')
  const current = await proposeReview(await newSimulationAccount())
  const newer = await request('GET', characterPath(a) + '/runs/' + current.action.runId + '/replay')
  assert.equal(newer.body.goalRefs.length, 2)
  assert.deepEqual((await request('GET', replayPath)).body.goalRefs, replay.body.goalRefs)
})

async function stateFixtureAccount(slug: string) {
  const created = await request('POST', characterPath(a) + '/identities', {
    key: slug, data: { slug, roleProfile: {} },
  })
  assert.equal(created.status, 201)
  const identityId: string = created.body.id
  await owner.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } })
  return owner.platformAccount.create({
    data: { characterId: a, identityId, platform: 'mock-a', status: 'ACTIVE', instanceKey: 'integration',
      remoteAccountId: randomUUID() },
  })
}

test('late state inputs replay with the rule configuration pinned to each event', async () => {
  const account = await stateFixtureAccount('rule-replay')
  const conversation = await owner.conversation.create({
    data: { characterId: a, identityId: account.identityId, accountId: account.id, channel: 'PUBLIC', remoteKey: randomUUID() },
  })
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    const source = { accountId: account.id, platform: account.platform, instanceKey: account.instanceKey,
      verifiedRemoteAccountId: account.remoteAccountId }
    async function prepare(instant: number) {
      const event = await ingest(source, {
        id: randomUUID(), account: account.remoteAccountId, thread: conversation.remoteKey, kind: 'POST',
        occurredAt: new Date(instant).toISOString(), text: 'Rule fixture',
      })
      assert.equal(event.status, 'ACCEPTED')
      const job = await owner.outboxEvent.findFirstOrThrow({ where: { runId: event.runId, type: runQueuedEvent } })
      await prepareSimulatedRun(runtime, job.eventId)
      return event.runId
    }

    const earlier = Date.now() - 48 * 3_600_000
    const original = await prepare(earlier + 24 * 3_600_000)
    const path = characterPath(a) + '/identities/' + account.identityId
    const zero = [0, 0, 0, 0, 0, 0, 0]
    const stateRule = {
      motivationHalfLifeHours: 12, affectHalfLifeHours: 6,
      deltas: { POST: [0.10, 0, 0, 0, 0, 0, 0], MENTION: zero, REPLY: zero },
    }
    const options = { ifMatch: '"1"', data: { roleProfile: { stateRule }, reason: 'Tune simulation rules' } }
    assert.equal((await request('PUT', path, { ...options, actor: 'nonmember' })).status, 404)
    assert.equal((await request('PUT', path, {
      ...options, data: { ...options.data, roleProfile: { stateRule: { ...stateRule,
        deltas: { ...stateRule.deltas, POST: [0.16, 0, 0, 0, 0, 0, 0] },
      } } },
    })).status, 422)
    const updated = await request('PUT', path, options)
    assert.equal(updated.status, 200)
    assert.equal(updated.body.version, 2)
    const late = await prepare(earlier)

    const old = await owner.identityStateRevision.findUniqueOrThrow({ where: { runId: original } })
    const current = await owner.identityStateRevision.findUniqueOrThrow({ where: { runId: late } })
    assert.equal(old.ruleConfiguration, null)
    assert.ok(Math.abs(old.values[0] - 0.58) < 1e-12)
    assert.deepEqual(current.ruleConfiguration, stateRule)
    assert.equal(current.revision, 2)
    assert.equal(current.throughEventId, old.eventId)
    // The late input adds 0.10. The original input applies v1's 24-hour decay and 0.08 increment.
    assert.ok(Math.abs(current.values[0] - 0.63) < 1e-12)
    const context = await runtime.$transaction((tx) => loadRunContinuity(tx, late))
    assert.equal(context?.identityState.configurationVersion, 2)
    const profilePath = characterPath(a) + '/identities?limit=100'
    const find = (result: Awaited<ReturnType<typeof request>>) =>
      result.body.items.find(({ id }: { id: string }) => id === account.identityId).profile
    assert.deepEqual(find(await request('GET', profilePath)).stateRule, stateRule)
    assert.equal((await request('GET', profilePath, { actor: 'nonmember' })).status, 404)
  } finally {
    await runtime.$disconnect()
  }
})

test('approved energy is immutable and visible only within its character and UTC day', async () => {
  const [clock] = await owner.$queryRaw<{ day: string }[]>`
    SELECT ((statement_timestamp() AT TIME ZONE 'UTC')::date)::text AS day
  `
  const today = new Date(clock.day + 'T00:00:00Z').getTime()
  const utcDay = new Date(today + 86_400_000).toISOString().slice(0, 10)
  const path = characterPath(a) + '/daily-energy'
  const input = { utcDay, energy: 'HIGH', reason: 'Approved abstract projection' }
  const options = { key: 'daily-energy-fixture', data: input }
  assert.equal((await request('POST', path, { ...options, actor: 'nonmember' })).status, 404)
  assert.equal((await request('POST', path, { ...options, data: { ...input, utcDay: clock.day } })).status, 422)
  const approved = await request('POST', path, options)
  assert.equal(approved.status, 201)
  assert.equal((await request('POST', path, options)).body.id, approved.body.id)
  assert.equal((await request('POST', path, { key: 'replace-daily', data: { ...input, energy: 'LOW' } })).status, 409)
  const view = await request('GET', path + '/' + utcDay)
  assert.equal(view.body.energy, 'HIGH')
  assert.ok(!('reason' in view.body))
  assert.equal((await request('GET', characterPath(b) + '/daily-energy/' + utcDay, { actor: 'admin-b' })).status, 404)

  const foreign = await request('POST', characterPath(b) + '/daily-energy', {
    actor: 'admin-b', key: 'foreign-energy', data: { ...input, energy: 'LOW' },
  })
  assert.equal(foreign.status, 201)
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    for (const slug of ['energy-first', 'energy-second']) {
      const account = await stateFixtureAccount(slug)
      const run = await ingestSimulatedEvent(runtime, {
        accountId: account.id, sourceKey: randomUUID(), kind: 'POST', occurredAt: new Date(today),
      })
      assert.equal(run.status, 'ACCEPTED')
      const runId = run.runId
      const event = await owner.outboxEvent.findFirstOrThrow({ where: { runId, type: runQueuedEvent } })
      await prepareSimulatedRun(runtime, event.eventId)
      for (const [offset, expected] of [[-1, 'NORMAL'], [0, 'HIGH'], [1, 'NORMAL']] as const) {
        await owner.agentRun.update({
          where: { id: runId }, data: { createdAt: new Date(today + (1 + offset) * 86_400_000) },
        })
        const context = await runtime.$transaction<Awaited<ReturnType<typeof loadRunContinuity>>>(
          (tx) => loadRunContinuity(tx, runId),
        )
        assert.equal(context?.identityState.sharedEnergy, expected)
        assert.equal(context?.identityState.affect.energy, 0.7)
      }
    }
    await assert.rejects(runtime.dailyEnergyProjection.count(), /permission denied/i)
  } finally {
    await runtime.$disconnect()
  }
})

async function topicAccount(identityId: string, platform: 'mock-a' | 'mock-b', privateChannel = false, characterId = a) {
  const account = await owner.platformAccount.create({
    data: { characterId, identityId, status: 'ACTIVE', platform, instanceKey: 'integration', remoteAccountId: randomUUID() },
  })
  const contact = privateChannel ? await owner.contact.create({
    data: { characterId, identityId, accountId: account.id, remoteKey: randomUUID() },
  }) : null
  const conversation = await owner.conversation.create({
    data: {
      characterId, identityId, accountId: account.id, remoteKey: randomUUID(),
      channel: privateChannel ? 'PRIVATE' : 'PUBLIC', privateContactId: contact?.id,
    },
  })
  return { account, conversation, contact }
}

async function prepareTopic(runtime: ReturnType<typeof createDatabase>, target: Awaited<ReturnType<typeof topicAccount>>,
  text: string, sourceKey = randomUUID(), occurredAt = new Date(),
) {
  const { account, conversation, contact } = target
  const source = {
    accountId: account.id, platform: account.platform, instanceKey: account.instanceKey, verifiedRemoteAccountId: account.remoteAccountId,
  }
  const payload = account.platform === 'mock-a' ? {
    id: sourceKey, account: account.remoteAccountId, thread: conversation.remoteKey, sender: contact?.remoteKey,
    kind: 'POST', occurredAt: occurredAt.toISOString(), text,
  } : {
    delivery: sourceKey, recipient: account.remoteAccountId, action: 'post', timeMs: occurredAt.getTime(),
    message: { conversation: conversation.remoteKey, author: contact?.remoteKey, body: text },
  }
  const result = await createSimulatedPlatformIngress(runtime, simulationPlatforms.find)(source, payload)
  assert.equal(result.status, 'ACCEPTED')
  const runJob = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: runQueuedEvent } })
  await prepareSimulatedRun(runtime, runJob.eventId)
  const job = await owner.outboxEvent.findFirstOrThrow({ where: { runId: result.runId, type: draftQueuedEvent } })
  return { runId: result.runId, eventId: job.eventId }
}

async function topicProposal(runtime: ReturnType<typeof createDatabase>, target: Awaited<ReturnType<typeof topicAccount>>,
  text: string, model = localSimulationModel,
) {
  const { runId, eventId } = await prepareTopic(runtime, target, text)
  await processSimulatedDraft(runtime, eventId, simulationPlatforms.resolveAdapter, model)
  return owner.actionProposal.findUniqueOrThrow({ where: { runId } })
}

test('identity draft bindings reuse profiles across roles and keep separate profiles isolated', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rica-identity-models-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const models = createModelSettingsStore(directory, modelSettingsContracts)
  const configurations = [
    { name: 'Shared', model: 'shared-model', baseUrl: 'https://shared.example/v1', apiKey: 'shared-fixture-key' },
    { name: 'Separate', model: 'separate-model', baseUrl: 'https://separate.example/v1', apiKey: 'separate-fixture-key' },
  ]
  const profiles: { id: string; model: string }[] = []
  for (const [index, configuration] of configurations.entries()) {
    const { profiles: saved } = await models.save({ ...configuration, provider: 'openai-compatible' }, index)
    const profile = saved[index]
    assert.ok(profile)
    profiles.push(profile)
    modelProfileIds.add(profile.id)
  }
  t.after(() => profiles.forEach(({ id }) => modelProfileIds.delete(id)))
  const loader = await startConfiguredModel(models)
  t.after(loader.stop)
  const runtime = createDatabase(scheduleRuntimeUrl())
  t.after(() => runtime.$disconnect())
  const upstream = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const configuration = configurations.find(({ baseUrl }) => url === baseUrl + '/chat/completions')
    assert.ok(configuration)
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer ' + configuration.apiKey)
    const body = JSON.parse(String(options.body))
    assert.equal(body.model, configuration.model)
    const content = body.messages[0].content.startsWith('Decide whether')
      ? JSON.stringify({ action: 'REPLY', reason: 'RELEVANT_TOPIC' }) : '这是用于验证模型绑定的回复。'
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
  })
  const characters = []
  for (const [actor, suffix] of [['admin-a', '-model-role-a'], ['admin-b', '-model-role-b']]) {
    const created = await request('POST', '/characters', { actor, key: randomUUID(), data: characterData(suffix) })
    assert.equal(created.status, 201)
    const id: string = created.body.id
    characterIds.push(id)
    characters.push(id)
    await owner.character.update({ where: { id }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  }
  const [firstRole, otherRole] = characters
  const [shared, separate] = profiles
  assert.ok(firstRole && otherRole && shared && separate)
  const unavailable = await request('POST', characterPath(firstRole) + '/identities', {
    key: randomUUID(), data: { slug: 'unavailable', roleProfile: { draftModelProfile: randomUUID() } },
  })
  assert.equal(unavailable.status, 422)

  const runIds: string[] = []
  for (const [index, { profile, characterId, actor }] of [
    { profile: shared, characterId: firstRole, actor: 'admin-a' },
    { profile: separate, characterId: firstRole, actor: 'admin-a' },
    { profile: shared, characterId: otherRole, actor: 'admin-b' },
  ].entries()) {
    const path = characterPath(characterId) + '/identities'
    const identity = await request('POST', path, {
      actor, key: randomUUID(), data: { slug: 'model-persona-' + index,
        roleProfile: { draftModelProfile: profile.id, writingPrompt: 'Original identity wording ' + index } },
    })
    assert.equal(identity.status, 201, JSON.stringify(identity.body))
    if (index === 0) {
      const denied = await request('PUT', path + '/' + identity.body.id, {
        actor: 'admin-b', ifMatch: '"1"', data: { roleProfile: { draftModelProfile: separate.id } },
      })
      assert.equal(denied.status, 404)
    }
    await owner.identity.update({ where: { id: identity.body.id }, data: { status: 'ACTIVE' } })
    const target = await topicAccount(identity.body.id, 'mock-a', false, characterId)
    const { runId, eventId } = await prepareTopic(runtime, target, 'Public draft model fixture ' + index)
    runIds.push(runId)
    await processSimulatedDraft(runtime, eventId, simulationPlatforms.resolveAdapter, loader.read)
    const draft = await owner.simulatedDraft.findFirstOrThrow({ where: { runId } })
    assert.equal(draft.modelVersion, profile.model)
  }
  assert.deepEqual(upstream.mock.calls.map(({ arguments: [url] }) => url), [
    ...['shared', 'separate', 'shared'].flatMap((model) => Array<string>(2).fill(`https://${model}.example/v1/chat/completions`)),
  ])
  const sharedIdentity = await owner.identity.findFirstOrThrow({
    where: { characterId: firstRole, slug: 'model-persona-0' },
  })
  const identityPath = characterPath(firstRole) + '/identities/' + sharedIdentity.id
  await models.remove(shared.id, 2)
  modelProfileIds.delete(shared.id)
  const renamed = await request('PUT', identityPath, {
    ifMatch: '"1"', data: { roleProfile: { displayName: 'Renamed', draftModelProfile: shared.id, writingPrompt: 'Updated identity wording' } },
  })
  assert.equal(renamed.status, 200)
  const oldRun = await request('GET', characterPath(firstRole) + '/runs/' + runIds[0] + '/replay')
  assert.equal(oldRun.status, 200, JSON.stringify(oldRun.body))
  assert.match(oldRun.body.modelCalls.find(({ stage }: { stage: string }) => stage === 'WRITING').systemPrompt, /Original identity wording 0/u)
  const denied = await request('PUT', identityPath, {
    actor: 'admin-b', ifMatch: '"2"', data: { roleProfile: { draftModelProfile: shared.id } },
  })
  assert.equal(denied.status, 404)
  assert.equal((await loader.read(shared.id)).id, 'simulated')
  assert.equal((await loader.read(separate.id)).implementation.hostedModel, separate.model)
})

test('outbox retry cap survives Worker restart and ADMIN can reopen it once', { timeout: 35_000 }, async () => {
  const identityId = await reflectionIdentity()
  const target = await topicAccount(identityId, 'mock-a')
  const runtimeUrl = scheduleRuntimeUrl()
  const runtime = createDatabase(runtimeUrl)
  try {
    const { runId, eventId } = await prepareTopic(runtime, target, 'Outbox recovery fixture')
    const where = { eventId }
    const read = () => owner.outboxEvent.findUniqueOrThrow({ where })
    const wait = async (predicate: (row: Awaited<ReturnType<typeof read>>) => boolean) => {
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        const row = await read()
        if (predicate(row)) return row
        await sleep(50)
      }
      assert.fail('Outbox did not reach the expected state')
    }
    let failures = 0
    const failing: typeof localSimulationModel = {
      ...localSimulationModel,
      implementation: {
        ...localSimulationModel.implementation,
        async decide(input, signal) {
          if (input.context.runId !== runId) return localSimulationModel.implementation.decide(input, signal)
          failures++
          throw new Error('synthetic model failure')
        },
      },
    }
    const first = await startOutboxWorker(runtimeUrl, config.redisUrl, () => failing, simulationPlatforms.resolveAdapter)
    try {
      await wait(({ attempts, attemptUntil }) => attempts === 3 && attemptUntil === null)
    } finally {
      await first.close()
    }
    assert.equal(failures, 3)
    await owner.outboxEvent.update({ where, data: { enqueuedAt: new Date(Date.now() - 15_000) } })
    const restarted = await startOutboxWorker(runtimeUrl, config.redisUrl, () => failing, simulationPlatforms.resolveAdapter)
    try {
      const held = await wait(({ quarantinedAt }) => quarantinedAt !== null)
      assert.equal(held.attempts, 4)
      assert.equal(held.processedAt, null)
    } finally {
      await restarted.close()
    }
    assert.equal(failures, 4)
    const list = await request('GET', characterPath(a) + '/outbox/quarantined')
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.ok(list.body.items.some((row: { id: string; generation: number }) => row.id === eventId && row.generation === 0))
    const monitoring = await request('GET', characterPath(a) + '/monitoring')
    assert.ok(monitoring.body.outbox.quarantined >= 1)

    const suffix = '/outbox/' + eventId + '/retry'
    const options = { ifMatch: '"0"', data: { reason: 'Model provider recovered' } }
    assert.equal((await request('POST', characterPath(a) + suffix, { ...options, actor: 'nonmember' })).status, 404)
    assert.equal((await request('POST', characterPath(b) + suffix, { ...options, actor: 'admin-b' })).status, 404)
    const retried = await Promise.all(Array.from({ length: 2 }, () => request('POST', characterPath(a) + suffix, options)))
    assert.deepEqual(retried.map(({ status }) => status).sort(), [200, 412])
    assert.equal(await owner.managementAudit.count({ where: { targetId: eventId, operation: 'outbox.retry' } }), 1)
    const audit = await request('GET', characterPath(a) + '/audit?runId=' + runId)
    assert.equal(audit.status, 200, JSON.stringify(audit.body))
    assert.deepEqual(audit.body.items.map((item: { targetId: string; operation: string }) => [item.targetId, item.operation]),
      [[eventId, 'outbox.retry']])

    const [stale] = await runtime.$queryRaw<{ ticket: number | null }[]>`
      SELECT public.rica_begin_outbox_attempt(${eventId}::uuid, ${draftQueuedEvent}, 0) AS ticket
    `
    assert.equal(stale.ticket, null)
    const healthy = await startOutboxWorker(runtimeUrl, config.redisUrl, () => localSimulationModel, simulationPlatforms.resolveAdapter)
    try {
      const processed = await wait(({ processedAt }) => processedAt !== null)
      assert.equal(processed.generation, 1)
      assert.equal(processed.attempts, 1)
      assert.equal(processed.quarantinedAt, null)
    } finally {
      await healthy.close()
    }
    assert.equal(await owner.actionProposal.count({ where: { runId } }), 1)
  } finally {
    await runtime.$disconnect()
  }
})

test('a crashed outbox attempt consumes its ticket and a late failure cannot release a replacement', async () => {
  const identityId = await reflectionIdentity()
  const target = await topicAccount(identityId, 'mock-a')
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const { eventId } = await prepareTopic(runtime, target, 'Outbox lease fixture')
    const claim = async () => {
      const [row] = await runtime.$queryRaw<{ ticket: number | null }[]>`
        SELECT public.rica_begin_outbox_attempt(${eventId}::uuid, ${draftQueuedEvent}, 0) AS ticket
      `
      return row.ticket
    }
    assert.deepEqual((await Promise.all([claim(), claim()])).sort(), [1, null])
    const expireLease = async () => owner.outboxEvent.update({
      where: { eventId }, data: { attemptUntil: new Date((await databaseNow()) - 1000) },
    })
    await expireLease()
    assert.equal(await claim(), 2)
    await runtime.$queryRaw`SELECT public.rica_fail_outbox_attempt(${eventId}::uuid, 0, 1)::text`
    assert.equal(await claim(), null)
    await processSimulatedDraft(runtime, eventId, simulationPlatforms.resolveAdapter, localSimulationModel, { generation: 0, ticket: 1 })
    assert.equal((await owner.outboxEvent.findUniqueOrThrow({ where: { eventId } })).processedAt, null)
    for (const ticket of [3, 4]) {
      await expireLease()
      assert.equal(await claim(), ticket)
    }
    await expireLease()
    assert.equal(await claim(), null)
    assert.ok((await owner.outboxEvent.findUniqueOrThrow({ where: { eventId } })).quarantinedAt)
  } finally {
    await runtime.$disconnect()
  }
})

async function ageSimulationRun(runId: string, days: number) {
  const createdAt = new Date((await databaseNow()) - days * 86_400_000)
  const run = await owner.agentRun.update({ where: { id: runId }, data: { createdAt } })
  const inbound = await owner.inboundEvent.update({ where: { id: run.inboundEventId }, data: { receivedAt: createdAt } })
  await owner.simulatedDraft.updateMany({ where: { runId }, data: { createdAt } })
  return inbound
}

async function drainSimulationRetention(runtime: ReturnType<typeof createDatabase>) {
  while (await sweepSimulationRetention(runtime) > 0) { /* Drain the fixture batches. */ }
}

test('simulation retention removes bodies and references at separate cutoffs while preserving deduplication and receipts', async () => {
  const identityId = await reflectionIdentity()
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const archived = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const redacted = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const fresh = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    await executeSimulation(executor, archived.id, simulationPlatforms.resolveAdapter)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: archived.id } }), 1)
    const inbound = await ageSimulationRun(archived.runId, 91)
    await ageSimulationRun(redacted.runId, 31)
    await ageSimulationRun(fresh.runId, 29)
    assert.ok(await owner.contextSnapshot.count({ where: { runId: archived.runId } }) > 0)
    await Promise.all([drainSimulationRetention(runtime), drainSimulationRetention(runtime)])
    assert.equal(await sweepSimulationRetention(runtime), 0)

    for (const { runId } of [archived, redacted, fresh]) {
      const run = await owner.agentRun.findUniqueOrThrow({ where: { id: runId }, include: { inboundEvent: true, draft: true } })
      const bodyRetained = runId === fresh.runId
      assert.equal(run.inboundEvent.messageText !== null, bodyRetained)
      assert.equal(run.draft?.content != null, bodyRetained)
      assert.equal(run.referencesExpiredAt !== null, runId === archived.runId)
    }
    assert.equal(await owner.contextSnapshot.count({ where: { runId: archived.runId } }), 0)
    assert.ok(await owner.contextSnapshot.count({ where: { runId: redacted.runId } }) > 0)
    const archivedDraft = await owner.simulatedDraft.findUniqueOrThrow({ where: {
      characterId_runId: { characterId: a, runId: archived.runId },
    } })
    assert.deepEqual(archivedDraft.writingEvidenceIds, [])
    assert.deepEqual(archivedDraft.decisionEvidenceIds, [])
    assert.deepEqual(archivedDraft.citationIds, [])
    const replay = await request('GET', characterPath(a) + '/runs/' + archived.runId + '/replay')
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.ok(replay.body.referencesExpiredAt)
    assert.deepEqual(replay.body.snapshots, [])
    assert.deepEqual(replay.body.beliefRefs, [])
    assert.deepEqual(replay.body.goalRefs, [])
    assert.equal(replay.body.proposal.attemptStatus, 'CONFIRMED')
    assert.ok(replay.body.proposal.receiptAt)
    assert.equal(await recordSimulationReceipt(executor, archived.id), true)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: archived.id } }), 1)

    const duplicate = await ingestSimulatedEvent(runtime, {
      accountId: inbound.accountId, conversationId: inbound.conversationId!, sourceKey: inbound.sourceKey,
      kind: inbound.kind, messageText: 'Retried original inbound', occurredAt: inbound.occurredAt,
    })
    assert.deepEqual(duplicate, { status: 'DUPLICATE', runId: archived.runId })
    const expired = await request('GET', actionPath(redacted.id), { actor: 'reviewer' })
    assert.equal(expired.body.content, null)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('retention preserves unknown-delivery reconciliation and stops an expired run from rebuilding drafts', async () => {
  const identityId = await reflectionIdentity()
  await owner.character.update({ where: { id: a }, data: { timezone: simulationZone(12) } })
  const unknown = (await approveSimulation(await newSimulationAccount(identityId), undefined, identityId)).action
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    await assert.rejects(executeSimulation(executor, unknown.id, simulationPlatforms.resolveAdapter, async () => { throw new Error('synthetic lost outcome') }))
    await owner.simulationAttempt.update({
      where: { actionId: unknown.id }, data: { permitUntil: new Date((await databaseNow()) - 16 * 60_000) },
    })
    await ageSimulationRun(unknown.runId, 91)
    const pending = await prepareTopic(runtime, await topicAccount(identityId, 'mock-b'), 'Retention of pending run')
    const inbound = await ageSimulationRun(pending.runId, 91)
    await drainSimulationRetention(runtime)
    const scrubbed = await owner.inboundEvent.findUniqueOrThrow({ where: { id: inbound.id } })
    assert.equal(scrubbed.messageText, null)
    assert.ok(scrubbed.bodyExpiredAt)
    assert.equal(scrubbed.adapterId, 'mock-b')

    const path = actionPath(unknown.id) + '/reconciliation'
    const proof = await request('GET', path)
    assert.equal(proof.status, 200)
    assert.equal(proof.body.outcome, 'DEFINITELY_NOT_SENT')
    assert.ok(proof.body.evidenceRef)
    const resolved = await request('POST', path, {
      key: 'retained-unknown-ledger', ifMatch: proof.headers.get('etag') ?? '',
      data: { outcome: proof.body.outcome, evidenceRef: proof.body.evidenceRef, reason: 'Checked retained ledger' },
    })
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body))
    assert.equal(resolved.body.status, 'BLOCKED')
    await processSimulatedDraft(runtime, pending.eventId, simulationPlatforms.resolveAdapter, {
      ...localSimulationModel,
      implementation: {
        ...localSimulationModel.implementation,
        async decide() { return assert.fail('Expired run reached the model') },
      },
    })
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: pending.runId } })).state, 'EXPIRED')
    assert.equal(await owner.contextSnapshot.count({ where: { runId: pending.runId } }), 0)
    assert.equal(await owner.actionProposal.count({ where: { runId: pending.runId } }), 0)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

const duplicateReview = { similarityPercent: 75, windowHours: 2 }

test('cross-platform near duplicates only flag opted-in public topics in the same identity', async () => {
  const identityId = await reflectionIdentity({ duplicateReview })
  const separate = await reflectionIdentity({ duplicateReview })
  const disabled = await reflectionIdentity()
  const first = await topicAccount(identityId, 'mock-a')
  const second = await topicAccount(identityId, 'mock-b')
  const privateTopic = await topicAccount(identityId, 'mock-a', true)
  const other = await topicAccount(separate, 'mock-b')
  const offA = await topicAccount(disabled, 'mock-a')
  const offB = await topicAccount(disabled, 'mock-b')
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    const text = 'Regional railway maintenance begins this Friday evening.'
    const original = await topicProposal(runtime, first, text)
    assert.equal(original.crossPlatformDuplicate, false)
    const near = await topicProposal(runtime, second, 'Regional railway maintenance begins this Friday evening, soon.')
    assert.equal(near.crossPlatformDuplicate, true)
    const preview = await request('GET', actionPath(near.id), { actor: 'reviewer' })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.ok(preview.body.riskCodes.includes('CROSS_PLATFORM_NEAR_DUPLICATE'))
    assert.equal(preview.body.target.accountId, second.account.id)
    assert.equal(JSON.stringify(preview.body).includes(first.account.id), false)
    assert.equal((await topicProposal(runtime, other, text)).crossPlatformDuplicate, false)
    assert.equal((await topicProposal(runtime, offA, text)).crossPlatformDuplicate, false)
    assert.equal((await topicProposal(runtime, offB, text)).crossPlatformDuplicate, false)

    const secret = 'Private autumn gardening notes for the community workshop.'
    assert.equal((await topicProposal(runtime, privateTopic, secret)).crossPlatformDuplicate, false)
    assert.equal((await topicProposal(runtime, second, secret)).crossPlatformDuplicate, false)
  } finally {
    await runtime.$disconnect()
  }
})

function metricsPath(characterId: string, from: string, through: string) {
  return characterPath(characterId) + '/monitoring/daily?from=' + from + '&through=' + through
}

async function reviewTopic(characterId: string, action: { id: string; reviewDigest: string }, decision: 'APPROVE' | 'REJECT') {
  const response = await request('POST', characterPath(characterId) + '/actions/' + action.id + '/decisions', {
    actor: 'reviewer', key: 'm4-' + action.id, ifMatch: '"run-v3"',
    data: { decision, reviewDigest: action.reviewDigest, reason: 'M4 simulation evaluation' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
}

test('M4 evaluates fourteen simulated days of scope, duplicate reviews, frequency and intervention', { timeout: 90_000 }, async () => {
  const created = await request('POST', '/characters', { key: 'm4-history', data: characterData('-history') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const role = await request('POST', characterPath(characterId) + '/memberships', {
    key: 'history-reviewer', data: { subject: 'reviewer', action: 'GRANT', reason: 'History fixture' },
  })
  assert.equal(role.status, 200, JSON.stringify(role.body))
  const identityId = await reflectionIdentity({ duplicateReview }, characterId)
  const restrictedIdentity = await reflectionIdentity({}, characterId)
  await owner.character.update({ where: { id: characterId }, data: { timezone: simulationZone(12) } })
  const first = await topicAccount(identityId, 'mock-a', false, characterId)
  const second = await topicAccount(identityId, 'mock-b', false, characterId)
  const marker = 'M4_FORBIDDEN_' + randomUUID()
  const memory = await owner.memory.create({
    data: {
      characterId, identityId: restrictedIdentity, scope: 'IDENTITY', visibility: 'CONFIDENTIAL', importance: 1,
      content: 'Regional railway maintenance begins this Friday evening ' + marker,
    },
  })
  const source = await owner.sourceRecord.create({
    data: { characterId, identityId: restrictedIdentity, kind: 'fixture', sourceKey: randomUUID(), classification: 'CONFIDENTIAL' },
  })
  await owner.memorySource.create({ data: { characterId, memoryId: memory.id, sourceId: source.id } })

  let modelInputs = 0
  const model: typeof localSimulationModel = {
    ...localSimulationModel,
    implementation: {
      async decide(input, signal) {
        modelInputs++
        assert.equal(JSON.stringify(input).includes(marker), false)
        return localSimulationModel.implementation.decide(input, signal)
      },
      async write(input, signal) {
        modelInputs++
        assert.equal(JSON.stringify(input).includes(marker), false)
        return localSimulationModel.implementation.write(input, signal)
      },
    },
  }
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  const lastDay = new Date((await databaseNow()) - 2 * 86_400_000)
  lastDay.setUTCHours(12, 0, 0, 0)
  const firstDay = new Date(lastDay.getTime() - 13 * 86_400_000)
  const utc = (value: Date) => value.toISOString().slice(0, 10)
  try {
    for (let day = 0; day < 14; day++) {
      const date = new Date(firstDay.getTime() + day * 86_400_000)
      const topic = 'Regional railway maintenance begins this Friday evening for district ' + (day + 1)
      const action = await topicProposal(runtime, first, topic, model)
      const duplicate = await topicProposal(runtime, second, topic + ', soon.', model)
      assert.equal(action.crossPlatformDuplicate, false)
      assert.equal(duplicate.crossPlatformDuplicate, true)
      for (const proposal of [action, duplicate]) {
        const review = await request('GET', characterPath(characterId) + '/actions/' + proposal.id, { actor: 'reviewer' })
        assert.equal(review.status, 200)
        assert.ok(review.body.content)
        assert.equal(review.body.content.includes(marker), false)
      }
      await reviewTopic(characterId, action, 'APPROVE')
      if (day >= 7) await reviewTopic(characterId, duplicate, 'REJECT')
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      await executeSimulation(executor, duplicate.id, simulationPlatforms.resolveAdapter)
      assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 1)
      assert.equal(await owner.simulationReceipt.count({ where: { actionId: duplicate.id } }), 0)

      // The real simulation pipeline runs above. Only the fixture's observed times are shifted into the virtual day.
      await owner.$transaction(async (tx) => {
        const ids = [action.runId, duplicate.runId]
        const runs = await tx.agentRun.findMany({ where: { id: { in: ids } }, select: { inboundEventId: true } })
        await tx.inboundEvent.updateMany({
          where: { id: { in: runs.map(({ inboundEventId }) => inboundEventId) } }, data: { receivedAt: date },
        })
        await tx.agentRun.updateMany({ where: { id: { in: ids } }, data: { createdAt: date } })
        await tx.actionProposal.updateMany({
          where: { id: { in: [action.id, duplicate.id] } }, data: { createdAt: new Date(date.getTime() + 500) },
        })
        await tx.simulationReceipt.update({ where: { actionId: action.id }, data: { createdAt: date } })
        await tx.simulationAttempt.update({ where: { actionId: action.id }, data: { windowStart: date } })
      })
    }
    assert.equal(modelInputs, 56)
    assert.equal(await owner.contextSnapshotEvidence.count({ where: { characterId, memoryId: memory.id } }), 0)
    const path = metricsPath(characterId, utc(firstDay), utc(lastDay))
    const report = await request('GET', path)
    assert.equal(report.status, 200, JSON.stringify(report.body))
    assert.equal(report.body.days.length, 14)
    assert.deepEqual(report.body.alerts, ['REVIEW_RATE_DRIFT'])
    for (const [index, row] of report.body.days.entries()) {
      assert.equal(row.utcDay, utc(new Date(firstDay.getTime() + index * 86_400_000)))
      assert.equal(row.proposals, 2)
      assert.equal(row.approvals, 1)
      assert.equal(row.rejections, Number(index >= 7))
      assert.equal(row.duplicateFlags, 1)
      assert.equal(row.receipts, 1)
      assert.equal(row.peakAccountReceipts, 1)
      assert.equal(row.flaggedReceipts, 0)
      assert.equal(row.receiptsWithoutApproval, 0)
    }
    assert.equal((await request('GET', path, { actor: 'admin-b' })).status, 404)
    assert.equal(JSON.stringify(report.body).includes(marker), false)
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('concurrent model calls share one enforced character budget and report the denial', async () => {
  const budget = 21_000
  const created = await request('POST', '/characters', {
    key: 'm4-budget', data: { ...characterData('-budget'), coreProfile: { aiDisclosure: 'AI role', dailyModelBudget: budget } },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const identityId = await reflectionIdentity({}, characterId)
  const target = await topicAccount(identityId, 'mock-a', false, characterId)
  const runtime = createDatabase(scheduleRuntimeUrl())
  let decisions = 0
  let writes = 0
  const model: typeof localSimulationModel = {
    ...localSimulationModel,
    implementation: {
      async decide(input, signal) {
        decisions++
        return localSimulationModel.implementation.decide(input, signal)
      },
      async write(input, signal) {
        writes++
        return localSimulationModel.implementation.write(input, signal)
      },
    },
  }
  try {
    const runs = await Promise.all(['first budget input', 'second budget input'].map((text) => prepareTopic(runtime, target, text)))
    await Promise.all(runs.map(({ eventId }) => processSimulatedDraft(runtime, eventId, simulationPlatforms.resolveAdapter, model)))
    assert.equal(decisions, 2)
    assert.equal(writes, 1)
    assert.equal(await owner.actionProposal.count({ where: { characterId } }), 1)
    const day = new Date(await databaseNow()).toISOString().slice(0, 10)
    const report = await request('GET', metricsPath(characterId, day, day))
    assert.equal(report.status, 200, JSON.stringify(report.body))
    assert.deepEqual(report.body.alerts, ['MODEL_BUDGET_EXHAUSTED'])
    assert.equal(report.body.days[0].modelCalls, 3)
    assert.equal(report.body.days[0].budgetDenials, 1)
    assert.ok(report.body.days[0].reservedUnits <= budget)

    const path = characterPath(characterId) + '/simulation-settings'
    const original = await request('GET', path)
    assert.equal(original.body.inheritedModelBudget, budget)
    assert.equal((await request('PUT', path, { ifMatch: '"0"', data: {
      ...original.body.settings, simulationModelBudget: 50_000,
    } })).status, 200)
    const resumed = await prepareTopic(runtime, target, 'third budget input after increasing the simulation budget')
    await processSimulatedDraft(runtime, resumed.eventId, simulationPlatforms.resolveAdapter, model)
    assert.equal(writes, 2)
    assert.equal(await owner.actionProposal.count({ where: { characterId } }), 2)
  } finally {
    await runtime.$disconnect()
  }
})

test('three identities on two platforms reach separate approved simulation receipts', async () => {
  const runtimeUrl = scheduleRuntimeUrl()
  const runtime = createDatabase(runtimeUrl)
  const executor = simulationDatabase()
  try {
    await owner.character.update({
      where: { id: a }, data: { status: 'ACTIVE', timezone: simulationZone(12) },
    })
    const ingest = createSimulatedPlatformIngress(runtime, simulationPlatforms.find)
    const occurredAt = new Date()
    const runs = []
    const memoryCount = await owner.memory.count({ where: { characterId: a } })
    const prompts = new Map([
      ['formal', '先说明结论，再列步骤。'],
      ['casual', '用轻松的语气回复。\n请对方补充背景。'],
    ])
    for (const [style, platform, expected] of [
      ['formal', 'mock-a', '感谢您的来信，我会认真考虑。'],
      ['casual', 'mock-b', '收到啦，我会看看。'],
      ['concise', 'mock-a', '收到。'],
    ] as const) {
      const identity = await request('POST', characterPath(a) + '/identities', {
        key: 'e2e-' + style, data: {
          slug: 'e2e-' + style, roleProfile: { writingStyle: style, writingPrompt: prompts.get(style) },
        },
      })
      assert.equal(identity.status, 201)
      const account = await request('POST', characterPath(a) + '/accounts', {
        key: 'e2e-account-' + style,
        data: { identityId: identity.body.id, platform, instanceKey: 'integration', remoteAccountId: randomUUID() },
      })
      assert.equal(account.status, 201)
      const identityId: string = identity.body.id
      const accountId: string = account.body.id
      await owner.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } })
      const bound = await owner.platformAccount.update({ where: { id: accountId }, data: { status: 'ACTIVE' } })
      const conversation = await owner.conversation.create({
        data: { characterId: a, identityId, accountId, channel: 'PUBLIC', remoteKey: 'e2e-thread' },
      })
      const text = 'same topic across simulation platforms'
      const payload = platform === 'mock-a' ? {
        id: 'e2e-delivery', account: bound.remoteAccountId, thread: conversation.remoteKey,
        kind: 'MENTION', occurredAt: occurredAt.toISOString(), text,
      } : {
        delivery: 'e2e-delivery', recipient: bound.remoteAccountId, action: 'mention',
        timeMs: occurredAt.getTime(), message: { conversation: conversation.remoteKey, body: text },
      }
      const source = { accountId, platform, instanceKey: bound.instanceKey, verifiedRemoteAccountId: bound.remoteAccountId }
      const deliveries = await Promise.all(Array.from({ length: 100 }, () => ingest(source, payload)))
      const accepted = deliveries.filter((delivery) => delivery.status === 'ACCEPTED')
      assert.equal(accepted.length, 1)
      const [result] = accepted
      assert.ok(deliveries.every((delivery) => 'runId' in delivery && delivery.runId === result.runId))
      assert.equal(await owner.inboundEvent.count({ where: { accountId, sourceKey: 'e2e-delivery' } }), 1)
      runs.push({ id: result.runId, accountId, identityId, expected, conversationId: conversation.id })
    }

    const identitiesPath = characterPath(a) + '/identities?limit=100'
    const adminProfiles = await request('GET', identitiesPath)
    assert.equal(adminProfiles.status, 200)
    for (const [style, prompt] of prompts) {
      assert.equal(adminProfiles.body.items.find(({ slug }: { slug: string }) => slug === 'e2e-' + style).profile.writingPrompt, prompt)
    }
    assert.equal((await request('GET', identitiesPath, { actor: 'nonmember' })).status, 404)

    const ids = runs.map(({ id }) => id)
    const observedPrompts = new Map<string, string | undefined>()
    const provider = localSimulationModel.implementation
    const recordingModel = {
      ...localSimulationModel,
      implementation: {
        async decide(input: Parameters<typeof provider.decide>[0], signal: AbortSignal) {
          assert.ok(!JSON.stringify(input).includes('writingPrompt'))
          return provider.decide(input, signal)
        },
        async write(input: Parameters<typeof provider.write>[0], signal: AbortSignal) {
          if (input.text === 'same topic across simulation platforms') observedPrompts.set(input.style, input.identityPrompt)
          return provider.write(input, signal)
        },
      },
    }
    const worker = await startOutboxWorker(runtimeUrl, config.redisUrl, () => recordingModel, simulationPlatforms.resolveAdapter)
    try {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (await owner.actionProposal.count({ where: { runId: { in: ids } } }) === runs.length) break
        await sleep(50)
      }
      assert.equal(await owner.actionProposal.count({ where: { runId: { in: ids } } }), runs.length)
      assert.deepEqual(observedPrompts, new Map([...prompts, ['concise', undefined]]))
    } finally {
      await worker.close()
    }

    const character = await owner.character.findUniqueOrThrow({ where: { id: a } })
    await Promise.all(runs.map(async ({ id, accountId, identityId, expected, conversationId }) => {
      const action = await owner.actionProposal.findUniqueOrThrow({ where: { runId: id } })
      const path = actionPath(action.id)
      const preview = await request('GET', path, { actor: 'reviewer' })
      assert.equal(preview.status, 200)
      assert.equal(preview.body.target.accountId, accountId)
      assert.equal(preview.body.target.identityId, identityId)
      assert.equal(preview.body.target.conversationId, conversationId)
      assert.equal(preview.body.content, expected)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
      const decision = await request('POST', path + '/decisions', {
        actor: 'reviewer', key: 'e2e-approve-' + id, ifMatch: preview.headers.get('etag') ?? '',
        data: { decision: 'APPROVE', reviewDigest: action.reviewDigest, reason: 'Approve bound simulation' },
      })
      assert.equal(decision.status, 200, JSON.stringify(decision.body))
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
      const receipts = await owner.simulationReceipt.findMany({
        where: { actionId: action.id }, select: { attempt: { select: { accountId: true, reviewDigest: true } } },
      })
      assert.equal(receipts.length, 1)
      assert.equal(receipts[0].attempt.accountId, accountId)
      assert.equal(receipts[0].attempt.reviewDigest, action.reviewDigest)
      const replay = await request('GET', characterPath(a) + '/runs/' + id + '/replay')
      assert.equal(replay.status, 200)
      assert.equal(replay.body.state, 'SIMULATED')
      await assert.rejects(runtime.$executeRaw`
        UPDATE public.agent_runs SET mode = mode WHERE id = ${id}::uuid
      `, /permission denied/i)
      assert.equal(replay.body.coreVersion, character.activeCoreVersion)
      assert.equal(replay.body.accountId, accountId)
      assert.equal(replay.body.identityId, identityId)
      assert.equal(replay.body.proposal.adapterId, preview.body.target.platform)
      assert.equal(replay.body.proposal.adapterVersion, '1.0.0')
      assert.equal(replay.body.proposal.adapterContractVersion, 1)
    }))
    assert.deepEqual(await owner.$queryRaw`SELECT unnest(enum_range(NULL::"RunMode"))::text AS mode`,
      [{ mode: 'SIMULATION' }])
    assert.equal(await owner.memory.count({ where: { characterId: a } }), memoryCount)
  } finally {
    await Promise.all([executor.$disconnect(), runtime.$disconnect()])
  }
})

test('console simulation runs use an isolated conversation, one approval and one receipt', { timeout: 30_000 }, async (t) => {
  const writingPrompt = '内部身份提示，仅用于这个模拟账号。'
  const created = await request('POST', '/characters', { key: randomUUID(), data: characterData('-console') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const character = characterPath(characterId)
  const identity = await request('POST', character + '/identities', {
    key: randomUUID(), data: { slug: 'console-persona', roleProfile: { writingPrompt } },
  })
  assert.equal(identity.status, 201, JSON.stringify(identity.body))
  const identityId: string = identity.body.id
  assert.equal((await request('POST', character + '/memberships', {
    key: randomUUID(), data: { subject: 'reviewer', action: 'GRANT', reason: 'Console fixture' },
  })).status, 200)
  const path = character + '/runs'
  const input = { accountId: accountA, message: 'Console simulation fixture for an isolated public discussion' }
  const denied = await request('POST', path, { actor: 'nonmember', key: randomUUID(), data: input })
  assert.equal(denied.status, 404)
  assert.equal((await request('GET', path, { actor: 'nonmember' })).status, 404)
  assert.equal((await request('GET', characterPath(b) + '/runs')).status, 404)
  const foreign = await request('POST', characterPath(b) + '/runs', { actor: 'admin-b', key: randomUUID(), data: input })
  assert.equal(foreign.status, 404)

  const account = await owner.platformAccount.create({ data: {
    characterId, identityId, platform: 'mock-a', instanceKey: 'console-fixture',
    remoteAccountId: randomUUID(), status: 'PAUSED',
  } })
  const inactive = await request('POST', path, { key: randomUUID(), data: { ...input, accountId: account.id } })
  assert.equal(inactive.status, 409)
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  await owner.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } })
  await owner.platformAccount.update({ where: { id: account.id }, data: { status: 'ACTIVE' } })
  const data = { ...input, accountId: account.id }
  const key = randomUUID()
  const [first, duplicate] = await Promise.all([
    request('POST', path, { key, data }), request('POST', path, { key, data }),
  ])
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(duplicate.status, 201)
  assert.equal(first.body.id, duplicate.body.id)
  const id = first.body.id
  const run = await owner.agentRun.findUniqueOrThrow({ where: { id }, include: { inboundEvent: { include: { conversation: true } } } })
  assert.equal(run.accountId, account.id)
  assert.equal(run.inboundEvent.conversation?.channel, 'PUBLIC')
  assert.equal(run.inboundEvent.conversation?.privateContactId, null)
  assert.equal(run.inboundEvent.adapterId, 'mock-a')
  assert.equal(await owner.conversation.count({ where: { accountId: account.id } }), 1)
  assert.equal(await owner.outboxEvent.count({ where: { runId: id, type: runQueuedEvent } }), 1)
  const listing = await request('GET', path + '?limit=1')
  assert.equal(listing.status, 200)
  assert.deepEqual(listing.body.items.map(({ id: itemId }: { id: string }) => itemId), [id])
  assert.equal('message' in listing.body.items[0], false)
  assert.equal((await request('GET', path + '?limit=1&cursor=' + id)).body.items.some((item: { id: string }) => item.id === id), false)

  const replayPath = path + '/' + id + '/replay'
  const initial = await request('GET', replayPath)
  assert.equal(initial.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.inbound.kind, run.inboundEvent.kind)
  assert.equal(Date.parse(initial.body.inbound.receivedAt), run.inboundEvent.receivedAt.getTime())
  assert.deepEqual(Object.keys(initial.body.inbound).sort(), ['kind', 'receivedAt'])
  assert.equal(initial.body.draft, null)
  assert.equal(initial.body.proposal, null)
  assert.equal(initial.body.transcript, null)
  assert.equal(initial.body.systemPrompts, null)
  assert.equal(JSON.stringify(initial.body).includes(input.message), false)

  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  try {
    const queued = await owner.outboxEvent.findFirstOrThrow({ where: { runId: id, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, queued.eventId)
    const draft = await owner.outboxEvent.findFirstOrThrow({ where: { runId: id, type: draftQueuedEvent } })
    const generatedReply = 'Welcome to the discussion. What would you like to know?'
    const plugins = await startCognitionPlugins({}, undefined, {
      provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key',
    })
    const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, request: RequestInit) => {
      const system = JSON.parse(String(request.body)).messages[0].content
      const content = system.startsWith('Decide whether')
        ? JSON.stringify({ action: 'REPLY', reason: 'RELEVANT_TOPIC' }) : generatedReply
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
    })
    try {
      await processSimulatedDraft(runtime, draft.eventId, simulationPlatforms.resolveAdapter, plugins.model)
      assert.equal(fetch.mock.callCount(), 2)
    } finally {
      fetch.mock.restore()
      await plugins.stop()
    }
    const action = await owner.actionProposal.findUniqueOrThrow({ where: { runId: id } })
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 0)
    const actionPath = character + '/actions/' + action.id
    const preview = await request('GET', actionPath)
    assert.equal(preview.status, 200)
    assert.equal(preview.body.content, generatedReply)
    const drafted = await request('GET', replayPath)
    assert.deepEqual(drafted.body.systemPrompts, { core: 'AI role', identity: writingPrompt })
    assert.equal(drafted.body.transcript, null)
    const denyNonmember = await request('POST', actionPath + '/decisions', {
      actor: 'nonmember', key: randomUUID(), ifMatch: preview.headers.get('ETag')!,
      data: { decision: 'APPROVE', reviewDigest: preview.body.reviewDigest, reason: 'Caller lacks character access' },
    })
    assert.equal(denyNonmember.status, 404)
    const decision = await request('POST', actionPath + '/decisions', {
      key: randomUUID(), ifMatch: preview.headers.get('ETag')!,
      data: { decision: 'APPROVE', reviewDigest: preview.body.reviewDigest, reason: 'Console fixture checked' },
    })
    assert.equal(decision.status, 200, JSON.stringify(decision.body))
    const approved = await request('GET', replayPath)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    assert.deepEqual(Object.keys(approved.body.draft).sort(), ['createdAt', 'modelId', 'modelVersion'])
    assert.equal(approved.body.draft.modelId, 'openai')
    assert.equal(approved.body.draft.modelVersion, 'fixture-model')
    assert.equal(Date.parse(approved.body.proposal.createdAt), action.createdAt.getTime())
    assert.equal(approved.body.proposal.reviewDecision, 'APPROVE')
    assert.ok(approved.body.proposal.reviewedAt)
    assert.equal(approved.body.proposal.permittedAt, null)
    assert.equal(approved.body.proposal.receiptAt, null)
    assert.equal(approved.body.transcript, null)
    assert.equal(JSON.stringify(approved.body).includes(preview.body.content), false)

    await executeSimulation(executor, action.id, simulationPlatforms.resolveAdapter)
    const replay = await request('GET', replayPath)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.state, 'SIMULATED')
    assert.ok(replay.body.proposal.permittedAt)
    assert.ok(replay.body.proposal.receiptAt)
    assert.deepEqual(replay.body.transcript, {
      message: input.message, draft: preview.body.content, reviewReason: 'Console fixture checked',
    })
    const auditReplay = await request('GET', replayPath, { actor: 'reviewer' })
    assert.equal(auditReplay.status, 200)
    assert.deepEqual(auditReplay.body.transcript, replay.body.transcript)
    assert.deepEqual(replay.body.systemPrompts, { core: 'AI role', identity: writingPrompt })
    assert.equal((await request('GET', replayPath, { actor: 'nonmember' })).status, 404)
    assert.equal((await request('GET', replayPath, { actor: 'nonmember' })).status, 404)
    assert.equal((await request('GET', replayPath, { actor: 'admin-b' })).status, 404)
    await owner.inboundEvent.update({ where: { id: run.inboundEventId }, data: {
      receivedAt: new Date(await databaseNow() - 31 * 86_400_000),
    } })
    assert.equal((await request('GET', replayPath)).body.transcript, null)
    assert.equal(await owner.simulationReceipt.count({ where: { actionId: action.id } }), 1)
    const second = await request('POST', path, { key: randomUUID(), data })
    assert.equal(second.status, 201)
    const recent = await request('GET', path + '?limit=1')
    assert.equal(recent.body.items.length, 1)
    assert.equal(recent.body.nextCursor, recent.body.items[0].id)
    const older = await request('GET', path + '?limit=1&cursor=' + recent.body.nextCursor)
    assert.deepEqual([...recent.body.items, ...older.body.items].map((item: { id: string }) => item.id).sort(),
      [id, second.body.id].sort())
    assert.equal(older.body.nextCursor, null)

    const filters = new URLSearchParams({ identityId, accountId: account.id, limit: '1' })
    const matchingPage = await request('GET', path + '?' + filters)
    assert.equal(matchingPage.status, 200, JSON.stringify(matchingPage.body))
    assert.equal(matchingPage.body.nextCursor, recent.body.nextCursor)
    filters.set('cursor', matchingPage.body.nextCursor)
    const matchingOlder = await request('GET', path + '?' + filters)
    assert.deepEqual(matchingOlder.body, older.body)
    filters.delete('cursor')
    filters.set('state', 'SIMULATED')
    const utcDay = run.createdAt.toISOString().slice(0, 10)
    filters.set('from', utcDay)
    filters.set('through', utcDay)
    const filtered = await request('GET', path + '?' + filters)
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body))
    assert.deepEqual(filtered.body.items.map((item: { id: string }) => item.id), [id])
    assert.equal(filtered.body.nextCursor, null)
    const previousDay = new Date(Date.parse(utcDay) - 86_400_000).toISOString().slice(0, 10)
    for (const replacement of [
      { from: previousDay, through: previousDay }, { identityId: randomUUID() }, { accountId: accountA },
    ]) {
      const unmatched = new URLSearchParams(filters)
      for (const [key, value] of Object.entries(replacement)) unmatched.set(key, value)
      assert.deepEqual((await request('GET', path + '?' + unmatched)).body, { items: [], nextCursor: null })
    }
    assert.equal((await request('GET', path + '?from=' + utcDay + '&through=' + previousDay)).status, 422)
    assert.deepEqual((await request('GET', characterPath(a) + '/runs?' + filters)).body, { items: [], nextCursor: null })

    const audit = character + '/audit?runId=' + id
    assert.equal((await request('GET', audit, { actor: 'nonmember' })).status, 404)
    assert.equal((await request('GET', characterPath(a) + '/audit?runId=' + id)).status, 404)
    const newestAudit = await request('GET', audit + '&order=desc&limit=1')
    assert.equal(newestAudit.status, 200, JSON.stringify(newestAudit.body))
    assert.equal(newestAudit.body.items.length, 1)
    assert.equal(newestAudit.body.nextCursor, newestAudit.body.items[0].id)
    assert.equal(newestAudit.body.items[0].run.id, id)
    const olderAudit = await request('GET', audit + '&order=desc&limit=3&cursor=' + newestAudit.body.nextCursor)
    const entries = [...newestAudit.body.items, ...olderAudit.body.items]
    assert.deepEqual(entries.map((item: { operation: string }) => item.operation).sort(),
      ['action.review', 'simulation.executing', 'simulation.simulated', 'simulation.start'])
    assert.equal(entries.find((item: { operation: string }) => item.operation === 'action.review').decision, 'APPROVE')
    assert.ok(entries.every((item: { run?: { id: string } }) => item.run?.id === id))
    assert.ok(Date.parse(entries[0].createdAt) >= Date.parse(entries[1].createdAt))
    assert.equal(olderAudit.body.nextCursor, null)
    const foreignCursor = await request('GET', character + '/audit?runId=' + second.body.id)
    assert.equal((await request('GET', audit + '&cursor=' + foreignCursor.body.items[0].id)).status, 422)

    const chatId = randomUUID()
    const chatPath = character + '/simulation-chats/' + chatId
    const send = (speaker: string, message: string, key = randomUUID(), accountId = account.id) =>
      request('POST', path, { key, data: { accountId, chatId, speaker, message } })
    const prepareTurn = async (turn: string) => {
      const inbound = await owner.outboxEvent.findFirstOrThrow({ where: { runId: turn, type: runQueuedEvent } })
      await prepareSimulatedRun(runtime, inbound.eventId)
      return owner.outboxEvent.findFirstOrThrow({ where: { runId: turn, type: draftQueuedEvent } })
    }
    await owner.character.update({ where: { id: characterId }, data: { autoReviewEnabled: true } })
    const firstKey = randomUUID()
    const firstTurn = await send('小林', '我们在比较两套方案。', firstKey)
    assert.equal(firstTurn.status, 201, JSON.stringify(firstTurn.body))
    assert.equal((await send('小林', '我们在比较两套方案。', firstKey)).body.id, firstTurn.body.id)
    const firstDraft = await prepareTurn(firstTurn.body.id)
    const firstReplay = path + '/' + firstTurn.body.id + '/replay'
    let reviewObserved = false
    const tracedModel = { ...localSimulationModel, implementation: {
      hostedModel: 'fixture',
      async decide(input: Parameters<typeof localSimulationModel.implementation.decide>[0]) {
        await input.capture?.('Participation system prompt\nOriginal identity context')
        return { action: 'REPLY', reason: 'SOCIAL_OPENING' }
      },
      async write(input: Parameters<typeof localSimulationModel.implementation.write>[0], signal: AbortSignal) {
        await input.capture?.('Writing system prompt\nOriginal identity context')
        return localSimulationModel.implementation.write(input, signal)
      },
    } }
    await processSimulatedDraft(runtime, firstDraft.eventId, simulationPlatforms.resolveAdapter, tracedModel, undefined, async (_settings, _reply, _attribution, capture) => {
      await capture?.('Review system prompt\nOriginal policy', 'fixture/review')
      const duringReview = await request('GET', firstReplay)
      assert.equal(duringReview.body.autoReviewPending, true)
      const proposalPath = character + '/actions/' + duringReview.body.proposal.id
      const preview = await request('GET', proposalPath)
      assert.equal(preview.body.autoReviewPending, true)
      const race = await request('POST', proposalPath + '/decisions', {
        key: randomUUID(), ifMatch: preview.headers.get('etag')!,
        data: { decision: 'APPROVE', reviewDigest: preview.body.reviewDigest },
      })
      assert.equal(race.body.error.code, 'AUTO_REVIEW_PENDING')
      reviewObserved = true
      return { status: 'APPROVE', model: 'fixture/review', reason: '讨论相关的低风险回复。' }
    })
    assert.equal(reviewObserved, true)
    const automatic = await request('GET', firstReplay)
    assert.equal(automatic.body.chatId, chatId)
    assert.equal(automatic.body.autoReviewPending, false)
    assert.equal(automatic.body.autoApproved, true)
    assert.deepEqual(automatic.body.modelCalls.map((call: { stage: string; systemPrompt: string }) => [call.stage, call.systemPrompt]), [
      ['DECISION', 'Participation system prompt\nOriginal identity context'],
      ['WRITING', 'Writing system prompt\nOriginal identity context'],
      ['REVIEW', 'Review system prompt\nOriginal policy'],
    ])
    assert.match((await request('GET', character + '/actions/' + automatic.body.proposal.id)).body.review.reason,
      /讨论相关的低风险回复/u)
    assert.equal((await request('GET', firstReplay, { actor: 'nonmember' })).status, 404)
    await assert.rejects(runtime.$queryRaw`SELECT public.rica_run_model_calls(${characterId}::uuid,${firstTurn.body.id}::uuid)`, /permission denied/i)
    // Keep the remaining group turns in quiet hours to exercise interactive receipt issuance.
    await owner.character.update({ where: { id: characterId }, data: { timezone: simulationZone(1) } })
    await executeSimulation(executor, automatic.body.proposal.id, simulationPlatforms.resolveAdapter)

    const newIdentity = await request('POST', character + '/identities', {
      key: randomUUID(), data: { slug: 'another-persona', roleProfile: { displayName: '另一个身份' } },
    })
    assert.equal(newIdentity.status, 201, JSON.stringify(newIdentity.body))
    const newIdentityId: string = newIdentity.body.id
    await owner.identity.update({ where: { id: newIdentityId }, data: { status: 'ACTIVE' } })
    const newAccount = await owner.platformAccount.create({ data: {
      characterId, identityId: newIdentityId, status: 'ACTIVE', platform: 'mock-b',
      instanceKey: 'console-fixture', remoteAccountId: randomUUID(),
    } })
    const secondTurn = await send('小周', '刚才那套方案包含运费吗？', randomUUID(), newAccount.id)
    assert.equal(secondTurn.status, 201, JSON.stringify(secondTurn.body))
    const secondDraft = await prepareTurn(secondTurn.body.id)
    let seenContext: unknown
    await processSimulatedDraft(runtime, secondDraft.eventId, simulationPlatforms.resolveAdapter, {
      ...localSimulationModel, implementation: { ...localSimulationModel.implementation, async write(input, signal) {
        seenContext = input.conversation
        return localSimulationModel.implementation.write(input, signal)
      } },
    })
    const chat = await request('GET', chatPath, { actor: 'reviewer' })
    assert.equal(chat.status, 200, JSON.stringify(chat.body))
    assert.deepEqual(chat.body.speakers, ['小林', '小周'])
    assert.deepEqual(chat.body.turns.map(({ id }: { id: string }) => id), [firstTurn.body.id, secondTurn.body.id])
    assert.deepEqual(chat.body.turns.map(({ accountId, identityId }: { accountId: string; identityId: string }) =>
      [accountId, identityId]), [[account.id, identityId], [newAccount.id, newIdentityId]])
    assert.equal(chat.body.turns[0].state, 'SIMULATED')
    assert.equal(chat.body.turns[1].reply, null)
    assert.ok(chat.body.turns[0].reply)
    assert.deepEqual(seenContext, { speaker: '小周', history: [
      { speaker: '小林', message: '我们在比较两套方案。' }, { speaker: '角色', message: chat.body.turns[0].reply },
    ] })
    const quietTurn = await send('小周', '明天交作业哈哈', randomUUID(), newAccount.id)
    const quietDraft = await prepareTurn(quietTurn.body.id)
    await processSimulatedDraft(runtime, quietDraft.eventId, simulationPlatforms.resolveAdapter, localSimulationModel)
    const quietReplay = await request('GET', path + '/' + quietTurn.body.id + '/replay')
    assert.deepEqual(quietReplay.body.participationDecision, { participation: 'balanced', action: 'NO_OP', reason: 'BYSTANDER' })
    assert.equal(quietReplay.body.state, 'SKIPPED')
    assert.equal(quietReplay.body.proposal, null)
    assert.equal((await request('GET', chatPath, { actor: 'nonmember' })).status, 404)
    assert.equal((await request('GET', characterPath(b) + '/simulation-chats/' + chatId, { actor: 'admin-b' })).status, 404)
    assert.deepEqual((await request('GET', characterPath(b) + '/simulation-chats', { actor: 'admin-b' })).body.items, [])
    await assert.rejects(runtime.$queryRaw`SELECT public.rica_console_simulation_chat(${characterId}::uuid,${chatId}::uuid)`, /permission denied/i)
    const oldChat = await owner.simulationChat.create({ data: { id: randomUUID(), characterId, createdAt: new Date(0) } })
    const chats = await request('GET', character + '/simulation-chats?limit=1')
    assert.deepEqual(chats.body.items.map(({ id }: { id: string }) => id), [chatId])
    assert.equal(chats.body.nextCursor, chatId)
    const olderChats = await request('GET', character + '/simulation-chats?limit=1&cursor=' + chatId)
    assert.deepEqual(olderChats.body.items.map(({ id }: { id: string }) => id), [oldChat.id])
    const secondAction = await owner.actionProposal.findUniqueOrThrow({ where: { runId: secondTurn.body.id } })
    const secondProposal = character + '/actions/' + secondAction.id
    const approvalPreview = await request('GET', secondProposal)
    assert.equal(approvalPreview.body.target.platform, 'mock-b')
    assert.deepEqual(approvalPreview.body.messageContext.previous.map(({ content }: { content: string }) =>
      content), ['我们在比较两套方案。'])
    assert.equal((await request('POST', secondProposal + '/decisions', {
      key: randomUUID(), ifMatch: approvalPreview.headers.get('etag')!,
      data: { decision: 'REJECT', reviewDigest: approvalPreview.body.reviewDigest, reason: 'Fixture rejection' },
    })).status, 200)
    const history = await request('GET', character + '/actions?status=HISTORY&limit=1')
    assert.equal(history.body.items[0].id, secondAction.id)
    const moreHistory = await request('GET', character + '/actions?status=HISTORY&cursor=' + history.body.nextCursor)
    assert.equal(moreHistory.body.items[0].autoApproved, true)
    assert.equal((await request('GET', secondProposal)).body.review.reason, 'Fixture rejection')

    const thirdTurn = await send('小林', '@角色 我补充一下预算。')
    const thirdDraft = await prepareTurn(thirdTurn.body.id)
    await processSimulatedDraft(runtime, thirdDraft.eventId, simulationPlatforms.resolveAdapter, localSimulationModel)
    const thirdAction = await owner.actionProposal.findUniqueOrThrow({ where: { runId: thirdTurn.body.id } })
    const thirdProposal = character + '/actions/' + thirdAction.id
    const thirdPreview = await request('GET', thirdProposal)
    assert.equal(thirdPreview.body.messageContext.trigger.sender, '小林')
    assert.equal(thirdPreview.body.target.contactId, null)
    assert.equal((await request('POST', thirdProposal + '/decisions', {
      key: randomUUID(), ifMatch: thirdPreview.headers.get('etag')!,
      data: { decision: 'APPROVE', reviewDigest: thirdPreview.body.reviewDigest },
    })).status, 200)
    await executeSimulation(executor, thirdAction.id, simulationPlatforms.resolveAdapter)
    const finalChat = await request('GET', chatPath)
    assert.deepEqual(finalChat.body.speakers, ['小林', '小周'])
    assert.equal(finalChat.body.turns.at(-1).state, 'SIMULATED')
    assert.equal(finalChat.body.turns.at(-1).accountId, account.id)

    for (const [version, participation, action] of [[1, 'talkative', 'REPLY'], [2, 'balanced', 'NO_OP'], [3, 'reserved', 'NO_OP']] as const) {
      const configured = await request('PUT', character + '/identities/' + newIdentityId, {
        ifMatch: `"${version}"`, data: { roleProfile: { participation } },
      })
      assert.equal(configured.status, 200, JSON.stringify(configured.body))
      const turn = await request('POST', path, { key: randomUUID(), data: {
        accountId: newAccount.id, chatId: randomUUID(), speaker: '小周', message: '这张照片的颜色真有意思',
      } })
      assert.equal(turn.status, 201, JSON.stringify(turn.body))
      const job = await prepareTurn(turn.body.id)
      await processSimulatedDraft(runtime, job.eventId, simulationPlatforms.resolveAdapter, localSimulationModel)
      const replay = await request('GET', path + '/' + turn.body.id + '/replay')
      assert.equal(replay.body.participationDecision.participation, participation)
      assert.equal(replay.body.participationDecision.action, action)
      assert.equal(Boolean(replay.body.proposal), action === 'REPLY')
    }
  } finally {
    await Promise.all([runtime.$disconnect(), executor.$disconnect()])
  }
})

test('group reply review drops exact repeats and stale social openings while keeping direct requests', async (t) => {
  const created = await request('POST', '/characters', { key: randomUUID(), data: characterData('-chat-review') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const root = characterPath(characterId)
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  const identity = await request('POST', root + '/identities', { key: randomUUID(), data: { slug: 'chat-reviewer', roleProfile: {} } })
  assert.equal(identity.status, 201)
  await owner.identity.update({ where: { id: identity.body.id }, data: { status: 'ACTIVE' } })
  const account = await owner.platformAccount.create({ data: {
    characterId, identityId: identity.body.id, status: 'ACTIVE', platform: 'mock-a',
    instanceKey: 'chat-review-fixture', remoteAccountId: randomUUID(),
  } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  const executor = simulationDatabase()
  t.after(() => Promise.all([runtime.$disconnect(), executor.$disconnect()]))
  const chatId = randomUUID()
  let decisions = 0
  const decline = { action: 'NO_OP', reason: 'BYSTANDER' }
  const direct = { action: 'REPLY', reason: 'DIRECT_REQUEST' }
  const social = { action: 'REPLY', reason: 'SOCIAL_OPENING' }
  const read = async (id: string) => (await request('GET', root + '/runs/' + id + '/replay')).body
  const send = async (speaker: string, message: string, decision: typeof direct, room = chatId) => {
    const accepted = await request('POST', root + '/runs', { key: randomUUID(), data: { accountId: account.id, chatId: room, speaker, message } })
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body))
    const runId: string = accepted.body.id
    const queued = await owner.outboxEvent.findFirstOrThrow({ where: { runId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, queued.eventId)
    const draft = await owner.outboxEvent.findFirstOrThrow({ where: { runId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, draft.eventId, simulationPlatforms.resolveAdapter, {
      ...localSimulationModel, implementation: {
        ...localSimulationModel.implementation, async decide() { decisions++; return decision },
      },
    })
    return read(runId)
  }
  const inspect = (id: string) => request('GET', root + '/actions/' + id)
  const approve = (id: string, preview: Awaited<ReturnType<typeof inspect>>) => request('POST', root + '/actions/' + id + '/decisions', {
    key: randomUUID(), ifMatch: preview.headers.get('etag')!,
    data: { decision: 'APPROVE', reviewDigest: preview.body.reviewDigest },
  })

  const addressed = await send('林', '@角色 方案几点开始？', direct)
  const duplicate = await send('林', '@角色　方案几点开始？', direct)
  assert.equal(duplicate.state, 'SKIPPED')
  assert.equal(duplicate.stateReason, 'CHAT_REPEAT')
  assert.equal(duplicate.proposal, null)
  assert.equal(decisions, 1)
  assert.equal((await send('林', '@角色　方案几点开始？', direct, randomUUID())).state, 'WAITING_APPROVAL')

  const queued = await send('林', '这张图太有趣了', social)
  const queuedPreview = await inspect(queued.proposal.id)
  const sweepTarget = await send('周', '我也觉得这个梗很好笑', social)
  const ready = await send('林', '这张图值得收藏', social)
  const readyPreview = await inspect(ready.proposal.id)
  assert.equal((await approve(ready.proposal.id, readyPreview)).body.status, 'READY')
  for (const [speaker, message] of [['周', '有人看了下一组照片吗'], ['林', '下一组是黑白片'],
    ['周', '我更喜欢街拍'], ['林', '这一页还有三张']]) await send(speaker, message, decline)

  const waiting = (await request('GET', root + '/actions')).body.items
  assert.ok(waiting.some(({ id }: { id: string }) => id === addressed.proposal.id))
  assert.ok(!waiting.some(({ id }: { id: string }) => id === queued.proposal.id || id === sweepTarget.proposal.id))
  assert.equal((await inspect(queued.proposal.id)).body.chatStop, 'CHAT_MOVED_ON')
  assert.equal((await read(queued.id)).chatStop, 'CHAT_MOVED_ON')
  assert.equal((await approve(queued.proposal.id, queuedPreview)).status, 409)
  assert.equal((await read(queued.id)).stateReason, 'CHAT_MOVED_ON')
  await sweepSimulationRetention(runtime)
  assert.equal((await read(sweepTarget.id)).state, 'CANCELED')
  assert.equal((await read(sweepTarget.id)).stateReason, 'CHAT_MOVED_ON')
  await executeSimulation(executor, ready.proposal.id, simulationPlatforms.resolveAdapter)
  assert.equal((await read(ready.id)).stateReason, 'CHAT_MOVED_ON')
  assert.equal(await owner.simulationReceipt.count({ where: { actionId: ready.proposal.id } }), 0)
})

test('group glossary requires independent examples, stays in its room, and obeys versions and source removal', async (t) => {
  const created = await request('POST', '/characters', { key: randomUUID(), data: characterData('-group-glossary') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const root = characterPath(characterId)
  const character = await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE', timezone: simulationZone(12) } })
  const identity = await request('POST', root + '/identities', { key: randomUUID(), data: { slug: 'glossary-reader', roleProfile: {} } })
  assert.equal(identity.status, 201)
  await owner.identity.update({ where: { id: identity.body.id }, data: { status: 'ACTIVE' } })
  const account = await owner.platformAccount.create({ data: {
    characterId: character.id, identityId: identity.body.id, status: 'ACTIVE', platform: 'mock-a',
    instanceKey: 'glossary-fixture', remoteAccountId: randomUUID(),
  } })
  const runtime = createDatabase(scheduleRuntimeUrl())
  t.after(() => runtime.$disconnect())
  const chatId = randomUUID()
  const room = root + '/simulation-chats/' + chatId
  const candidate = { term: '交作业', meaning: '发表自己拍摄的照片', tone: 'playful' }
  const observed: { decision: unknown; writing: unknown } = { decision: null, writing: null }
  let reply = false
  const hosted = { ...localSimulationModel, implementation: {
    hostedModel: 'glossary-fixture',
    async decide(input: Parameters<typeof localSimulationModel.implementation.decide>[0]) {
      observed.decision = input.glossary
      return { action: reply ? 'REPLY' : 'NO_OP', reason: reply ? 'RELEVANT_TOPIC' : 'BYSTANDER', glossaryCandidates: [candidate] }
    },
    async write(input: Parameters<typeof localSimulationModel.implementation.write>[0]) {
      observed.writing = input.glossary
      return { text: '期待看到这组新照片。', evidenceIds: [] }
    },
  } }
  const send = async (speaker: string, message: string, targetChat = chatId) => {
    const accepted = await request('POST', root + '/runs', { key: randomUUID(), data: { accountId: account.id, chatId: targetChat, speaker, message } })
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body))
    const runId: string = accepted.body.id
    const queued = await owner.outboxEvent.findFirstOrThrow({ where: { runId, type: runQueuedEvent } })
    await prepareSimulatedRun(runtime, queued.eventId)
    const draft = await owner.outboxEvent.findFirstOrThrow({ where: { runId, type: draftQueuedEvent } })
    await processSimulatedDraft(runtime, draft.eventId, simulationPlatforms.resolveAdapter, hosted)
    return (await request('GET', root + '/runs/' + runId + '/replay')).body
  }

  const first = await send('林', '周五交作业，我把海边的照片发群里。')
  await send('林', '周五交作业，我把海边的照片发群里。')
  await send('周', '上次交作业发的是黑白街拍。')
  assert.deepEqual((await request('GET', room)).body.glossary, [])
  const third = await send('林', '这回交作业想选三张逆光照片。')
  assert.equal(third.state, 'SKIPPED')
  assert.deepEqual(third.glossary, [])
  const [learned] = (await request('GET', room)).body.glossary
  assert.equal(learned.status, 'LEARNED')
  assert.equal(learned.meaning, candidate.meaning)
  assert.ok(learned.sourceRuns.includes(first.id))
  assert.equal(learned.sourceRuns.length, 3)
  assert.equal((await request('GET', characterPath(b) + '/simulation-chats/' + chatId, { actor: 'admin-b' })).status, 404)
  await assert.rejects(runtime.$queryRaw`SELECT meaning FROM public.simulation_chat_terms`, /permission denied/i)

  reply = true
  const recalled = await send('周', '等你交作业。')
  assert.equal(recalled.glossary[0].id, learned.id)
  assert.deepEqual(observed.decision, recalled.glossary)
  assert.deepEqual(observed.writing, recalled.glossary)
  const otherChat = randomUUID()
  assert.deepEqual((await send('周', '等你交作业。', otherChat)).glossary, [])
  assert.equal((await request('PUT', root + '/simulation-chats/' + otherChat + '/terms/' + learned.id, {
    ifMatch: '"1"', data: { operation: 'DISABLE' },
  })).status, 404)

  const update = (version: number, data: object) => request('PUT', room + '/terms/' + learned.id, { ifMatch: `"${version}"`, data })
  const corrected = { operation: 'CORRECT', meaning: '分享摄影练习的成片', tone: 'neutral' }
  assert.equal((await update(1, corrected)).status, 200)
  assert.equal((await update(1, corrected)).status, 412)
  assert.equal((await request('GET', root + '/runs/' + recalled.id + '/replay')).body.glossary[0].meaning, candidate.meaning)
  assert.equal((await request('GET', root + '/actions/' + recalled.proposal.id)).body.content, null)
  const updated = await send('周', '今晚交作业。')
  assert.equal(updated.glossary[0].meaning, corrected.meaning)
  const action = root + '/actions/' + updated.proposal.id
  const preview = await request('GET', action)
  const approval = await request('POST', action + '/decisions', {
    key: randomUUID(), ifMatch: preview.headers.get('etag')!,
    data: { decision: 'APPROVE', reviewDigest: preview.body.reviewDigest },
  })
  assert.equal(approval.body.status, 'READY')
  assert.equal((await update(2, { operation: 'DISABLE' })).status, 200)
  const executor = simulationDatabase()
  t.after(() => executor.$disconnect())
  await executeSimulation(executor, updated.proposal.id, simulationPlatforms.resolveAdapter)
  assert.equal((await request('GET', root + '/runs/' + updated.id + '/replay')).body.state, 'BLOCKED')
  assert.equal(await owner.simulationReceipt.count({ where: { actionId: updated.proposal.id } }), 0)
  assert.deepEqual((await send('林', '我准备交作业了。')).glossary, [])

  const sourceRun = await owner.agentRun.findUniqueOrThrow({ where: { id: first.id }, select: { inboundEventId: true } })
  await owner.inboundEvent.update({ where: { id: sourceRun.inboundEventId }, data: { messageText: null, bodyExpiredAt: new Date() } })
  assert.deepEqual((await request('GET', root + '/runs/' + recalled.id + '/replay')).body.glossary, [])
  assert.deepEqual((await request('GET', room)).body.glossary[0].sourceRuns, [])
})

test('a role can register an account before its identities and associate it only once', async () => {
  const created = await request('POST', '/characters', { key: 'pool-character', data: characterData('-pool') })
  assert.equal(created.status, 201)
  characterIds.push(created.body.id)
  const path = characterPath(created.body.id)
  const pool = path + '/account-pool'
  const data = { platform: 'mock-a', instanceKey: 'integration', remoteAccountId: prefix + '-pool' }
  assert.deepEqual((await request('GET', path + '/identities')).body.items, [])
  const registered = await request('POST', pool, { key: 'register-first', data })
  assert.equal(registered.status, 201, JSON.stringify(registered.body))
  const registrationId = registered.body.id
  assert.equal((await request('POST', pool, { key: 'register-first', data })).body.id, registrationId)
  assert.deepEqual((await request('GET', pool)).body.items, [{ id: registrationId, ...data }])
  assert.deepEqual((await request('GET', path + '/accounts')).body.items, [])
  assert.equal((await request('GET', pool, { actor: 'admin-b' })).status, 404)
  assert.equal((await request('POST', characterPath(b) + '/account-pool', {
    actor: 'admin-b', key: 'duplicate-platform-account', data,
  })).status, 409)
  assert.equal((await request('POST', characterPath(b) + '/account-pool/associations', {
    actor: 'admin-b', key: 'foreign-registration', data: { registrationId, identityId: identityB },
  })).status, 404)
  assert.equal((await request('POST', pool + '/associations', {
    key: 'foreign-identity', data: { registrationId, identityId: identityB },
  })).status, 404)
  const identity = await request('POST', path + '/identities', { key: 'pool-identity', data: { slug: 'pool-identity', roleProfile: {} } })
  assert.equal(identity.status, 201, JSON.stringify(identity.body))
  const identityId = identity.body.id
  const attempts = await Promise.all(['associate-first', 'associate-second'].map((key) => request('POST', pool + '/associations', {
    key, data: { registrationId, identityId },
  })))
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [201, 409])
  assert.deepEqual((await request('GET', pool)).body.items, [])
  const { items } = (await request('GET', path + '/accounts')).body
  assert.deepEqual(items.map(({ id, identityId, status }: { id: string; identityId: string; status: string }) =>
    ({ id, identityId, status })), [{ id: registrationId, identityId, status: 'PAUSED' }])

  const secondIdentity = await request('POST', path + '/identities', {
    key: 'second-pool-identity', data: { slug: 'second-pool-identity', roleProfile: {} },
  })
  assert.equal(secondIdentity.status, 201)
  const candidates = await Promise.all(['a', 'b'].map((suffix) => request('POST', pool, {
    key: 'register-candidate-' + suffix, data: { ...data, remoteAccountId: prefix + '-candidate-' + suffix },
  })))
  assert.deepEqual(candidates.map(({ status }) => status), [201, 201])
  const race = await Promise.all(candidates.map(({ body }, index) => request('POST', pool + '/associations', {
    key: 'associate-candidate-' + index, data: { registrationId: body.id, identityId: secondIdentity.body.id },
  })))
  assert.deepEqual(race.map(({ status }) => status).sort(), [201, 409])
  assert.equal(race.find(({ status }) => status === 409)?.body.error.code, 'IDENTITY_ALREADY_BOUND')
  const remaining = candidates[race.findIndex(({ status }) => status === 409)].body.id
  assert.deepEqual((await request('GET', pool)).body.items.map(({ id }: { id: string }) => id), [remaining])
  const winner = race.find(({ status }) => status === 201)?.body.id
  assert.equal((await request('POST', path + '/controls', {
    key: 'revoke-winner', data: { scope: 'ACCOUNT', scopeId: winner, operation: 'REVOKE_ACCOUNT' },
  })).status, 200)
  assert.equal((await request('POST', pool + '/associations', {
    key: 'associate-replacement', data: { registrationId: remaining, identityId: secondIdentity.body.id },
  })).status, 201)
})

test('collaborative plans preserve identity bindings, schedule each simulator once, and pause pending work', async () => {
  const created = await request('POST', '/characters', { key: 'collaborative-character', data: characterData('-planning') })
  assert.equal(created.status, 201)
  const characterId = created.body.id as string
  characterIds.push(characterId)
  const base = characterPath(characterId)
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE' } })
  const participants: { identityId: string; accountId: string; task: string }[] = []
  for (const platform of ['mock-a', 'mock-b', 'external-fixture']) {
    const identity = await request('POST', base + '/identities', { key: 'plan-' + platform, data: { slug: platform, roleProfile: {} } })
    assert.equal(identity.status, 201, JSON.stringify(identity.body))
    const identityId = identity.body.id as string
    await owner.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } })
    const { id: accountId } = await owner.platformAccount.create({
      data: { characterId, identityId, platform, instanceKey: 'integration', remoteAccountId: randomUUID(), status: 'ACTIVE' },
    })
    participants.push({ identityId, accountId, task: 'Prepare the ' + platform + ' update' })
  }
  const path = base + '/plans'
  const due = new Date('2026-11-12T10:00:00Z')
  const data = { title: 'Community updates', enabled: true, zone: 'UTC', rule: { kind: 'REMINDER', dueAt: due.toISOString() }, participants }
  assert.equal((await request('POST', path, { actor: 'admin-b', key: 'foreign-plan', data })).status, 404)
  assert.equal((await request('POST', path, { key: 'mismatched-plan', data: {
    ...data, participants: [{ ...participants[0], accountId: participants[1].accountId }],
  } })).status, 409)
  assert.equal((await request('POST', path, { key: 'duplicate-plan-identity', data: {
    ...data, participants: [participants[0], participants[0]],
  } })).status, 422)
  const plan = await request('POST', path, { key: 'create-plan', data })
  assert.equal(plan.status, 201, JSON.stringify(plan.body))
  const id = plan.body.id as string
  assert.equal((await request('POST', path, { key: 'create-plan', data })).body.id, id)
  const planParticipants = await owner.simulationPlanParticipant.findMany({ where: { planId: id } })
  const schedules = planParticipants.flatMap(({ scheduleId }) => scheduleId ? [scheduleId] : [])
  assert.equal(schedules.length, 2)
  assert.equal(planParticipants.find(({ accountId }) => accountId === participants[2].accountId)?.scheduleId, null)
  assert.equal((await request('GET', base + '/schedules')).body.items.length, 0)
  assert.equal((await request('PUT', base + '/schedules/' + schedules[0], {
    ifMatch: '"1"', data: { enabled: false, zone: 'UTC', rule: data.rule },
  })).status, 409)
  const runtime = createDatabase(scheduleRuntimeUrl())
  try {
    await Promise.all([...schedules, ...schedules].map((schedule) => dispatchSimulationSchedule(runtime, schedule, due)))
    const occurrences = await owner.scheduleOccurrence.findMany({ where: { scheduleId: { in: schedules } } })
    assert.equal(occurrences.length, 2)
    const list = await request('GET', path)
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.equal(list.body.items[0].source, 'MANUAL')
    assert.equal(list.body.items[0].participants.length, 3)
    for (const participant of participants) {
      const item = list.body.items[0].participants.find(({ identityId }: { identityId: string }) => identityId === participant.identityId)
      assert.equal(item.task, participant.task)
      if (item.platform === 'external-fixture') assert.equal(item.lastRunId, null)
      else assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: item.lastRunId } })).accountId, participant.accountId)
    }

    const edited = await request('PUT', path + '/' + id, {
      ifMatch: '"1"', data: { ...data, title: 'Revised title', participants: participants.slice(1) },
    })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal((await request('PUT', path + '/' + id, { ifMatch: '"1"', data })).status, 412)
    const revised = await request('GET', path)
    assert.equal(revised.body.items[0].participants.length, 2)
    const remainingRun = revised.body.items[0].participants.find(({ platform }: { platform: string }) => platform === 'mock-b').lastRunId
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: remainingRun } })).state, 'QUEUED')
    await owner.platformAccount.update({ where: { id: participants[2].accountId }, data: { status: 'REVOKED' } })
    const paused = await request('PUT', path + '/' + id + '/state', { ifMatch: '"2"', data: { enabled: false } })
    assert.equal(paused.status, 200, JSON.stringify(paused.body))
    assert.equal((await owner.agentRun.findUniqueOrThrow({ where: { id: remainingRun } })).state, 'CANCELED')
    assert.equal((await request('PUT', path + '/' + id + '/state', { ifMatch: '"3"', data: { enabled: true } })).status, 409)
  } finally {
    await runtime.$disconnect()
  }
})

test('external account operations share the host transaction and enforce account scope', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rica-account-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await owner.$executeRaw`CREATE SCHEMA rica_plugin_account_fixture`
  t.after(() => owner.$executeRaw`DROP SCHEMA rica_plugin_account_fixture CASCADE`)
  await owner.$executeRaw`CREATE TABLE rica_plugin_account_fixture.entries (
    character_id uuid NOT NULL, account_id uuid PRIMARY KEY, label text NOT NULL
  )`
  await owner.$executeRaw`CREATE VIEW rica_plugin_account_fixture.account_profiles AS
    SELECT character_id, account_id, jsonb_build_object('label', label) AS profile FROM rica_plugin_account_fixture.entries`
  await owner.$executeRaw`CREATE FUNCTION rica_plugin_account_fixture.register_account(uuid, uuid, text, text, jsonb)
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        INSERT INTO rica_plugin_account_fixture.entries VALUES ($1, $2, $5->>'label');
        RETURN $5->>'label' <> 'Reject';
      END $$`
  await owner.$executeRaw`CREATE FUNCTION rica_plugin_account_fixture.remove_account(uuid, uuid, text, text, jsonb)
    RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      WITH deleted AS (DELETE FROM rica_plugin_account_fixture.entries WHERE character_id = $1 AND account_id = $2 RETURNING 1)
      SELECT EXISTS (SELECT FROM deleted)
    $$`
  await owner.$executeRaw`CREATE FUNCTION rica_plugin_account_fixture.verify_resume(uuid, uuid, text, text, jsonb)
    RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT EXISTS (SELECT FROM rica_plugin_account_fixture.entries WHERE character_id = $1 AND account_id = $2 AND label = 'Allowed')
    $$`
  await owner.$executeRaw`CREATE TABLE rica_plugin_account_fixture.command_effects (
    id uuid PRIMARY KEY, character_id uuid NOT NULL, actor_id text NOT NULL, account_id uuid, label text NOT NULL
  )`
  await owner.$executeRaw`CREATE FUNCTION rica_plugin_account_fixture.record_command(uuid, text, uuid, jsonb)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      DECLARE effect uuid := gen_random_uuid();
      BEGIN
        INSERT INTO rica_plugin_account_fixture.command_effects VALUES (effect, $1, $2, $3, $4->>'label');
        IF $4->>'label' = 'Reject' THEN RETURN NULL; END IF;
        IF $4->>'label' = 'Malformed' THEN RETURN '{}'::jsonb; END IF;
        RETURN jsonb_build_object('id', effect, 'status', 'RECORDED');
      END $$`
  await owner.$executeRaw`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rica_plugin_account_fixture FROM PUBLIC`
  await owner.$executeRaw`GRANT USAGE ON SCHEMA rica_plugin_account_fixture TO rica_admin_api`
  await owner.$executeRaw`GRANT SELECT ON rica_plugin_account_fixture.account_profiles TO rica_admin_api`
  await owner.$executeRaw`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rica_plugin_account_fixture TO rica_admin_api`

  const manifest = join(directory, 'plugins.json')
  const plugin = join(directory, 'node_modules', 'rica-account-fixture')
  await mkdir(plugin, { recursive: true })
  await Promise.all([
    writeFile(manifest, JSON.stringify({ version: 1, plugins: [{ id: 'account-fixture', package: 'rica-account-fixture', version: '1.0.0',
      database: { migrateUrlEnv: 'RICA_PLUGIN_FIXTURE_MIGRATE_URL', runtimeUrlEnv: 'RICA_PLUGIN_FIXTURE_RUNTIME_URL' } }] })),
    writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'rica-account-fixture', version: '1.0.0', type: 'module',
      exports: { './package.json': './package.json', './rica': './plugin.js' } })),
    writeFile(join(plugin, 'plugin.js'), `export const ricaPlugin = { id: 'account-fixture', sdkVersion: 1,
      console: { title: 'Fixture console', summaryPath: '/summary', accountDetailPath: '/detail',
        accountFields: [{ key: 'label', label: 'Label', kind: 'text' }] },
      accounts: { register: 'register_account', profiles: 'account_profiles', remove: 'remove_account', verifyResume: 'verify_resume',
        async prepareRegistration({ data }) {
          if (data.label === 'RejectRemote') return { accepted: false }
          return { accepted: true, data: { label: data.label.trim() } }
        } },
      commands: [
        { id: 'record-account', function: 'record_command', scope: 'account' },
        { id: 'record-character', function: 'record_command', scope: 'character' },
      ],
      management() { return { async read(request, { readAccounts }) {
        if (request.path === '/summary') return { fields: [{ label: 'Status', value: 'Ready' }] }
        const accounts = await readAccounts(request.query.map(([, id]) => id))
        if (request.path === '/detail') return { fields: accounts.map(row => ({ label: 'Account', value: row.remoteAccountId })) }
        return accounts
      } } }
    }`),
  ])
  const fixtureUrl = new URL(config.databaseUrl)
  fixtureUrl.searchParams.set('schema', 'rica_plugin_account_fixture')
  const runtimeVariable = 'RICA_PLUGIN_FIXTURE_RUNTIME_URL'
  const previous = process.env[runtimeVariable]
  process.env[runtimeVariable] = fixtureUrl.href
  const host = await loadPackageManagement(manifest).finally(() => {
    if (previous === undefined) delete process.env[runtimeVariable]
    else process.env[runtimeVariable] = previous
  })
  t.after(() => host.stop())
  const target = createApp({ postgres: async () => true, redis: async () => true }, createManagementApp({
    db: management, origin: fixtureOrigin, cookie: 'fixture-session', resolveAdapter: () => undefined,
    plugins: packageManagementPlugins(management, host),
    consolePlugins: host.consolePlugins,
    authenticate: async (req) => {
      const subject = req.headers.get('Cookie')?.replace('fixture-session=', '')
      return subject ? { issuer, subject, id: actorId(issuer, subject) } : null
    },
  }))
  assert.equal((await request('GET', '/openapi.json', { target })).status, 200)
  const consolePath = characterPath(a) + '/package-console'
  assert.equal((await request('GET', consolePath, { target, actor: 'admin-b' })).status, 404)
  assert.deepEqual((await request('GET', consolePath, { target })).body, [{
    id: 'account-fixture', title: 'Fixture console', summaryPath: '/summary', accountDetailPath: '/detail',
    accountFields: [{ key: 'label', label: 'Label', kind: 'text' }],
  }])
  assert.deepEqual((await request('GET', characterPath(a) + '/plugins/account-fixture/summary', { target })).body,
    { fields: [{ label: 'Status', value: 'Ready' }] })
  const pool = (characterId: string) => characterPath(characterId) + '/account-pool'
  const register = (characterId: string, actor: string, key: string, label: string) => request('POST', pool(characterId), {
    target, actor, key, data: { platform: 'account-fixture', instanceKey: 'fixture', remoteAccountId: key, data: { label } },
  })
  const rejected = await register(a, 'admin-a', 'external-registration', 'Reject')
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body))
  assert.equal(rejected.body.error.code, 'PLUGIN_ACCOUNT_REJECTED')
  assert.equal(await owner.platformAccountRegistration.count({ where: { platform: 'account-fixture' } }), 0)
  assert.deepEqual(await owner.$queryRaw`SELECT label FROM rica_plugin_account_fixture.entries`, [])
  assert.equal((await register(a, 'admin-a', 'external-registration', 'RejectRemote')).status, 409)

  const local = await register(a, 'admin-a', 'external-registration', ' Allowed ')
  const foreign = await register(b, 'admin-b', 'foreign-registration', 'Blocked')
  assert.equal(local.status, 201, JSON.stringify(local.body))
  assert.equal(foreign.status, 201, JSON.stringify(foreign.body))
  assert.equal((await register(a, 'admin-a', 'external-registration', ' Allowed ')).body.id, local.body.id)
  const list = await request('GET', pool(a), { target })
  assert.deepEqual(list.body.items.filter((row: { platform: string }) => row.platform === 'account-fixture').map((row: { pluginProfile: unknown }) => row.pluginProfile), [{ label: 'Allowed' }])

  for (const [characterId, actor, registrationId] of [[a, 'admin-a', local.body.id], [b, 'admin-b', foreign.body.id]]) {
    const identity = await request('POST', characterPath(characterId) + '/identities', { actor, key: 'external-account-identity',
      data: { slug: 'external-account-fixture', roleProfile: {} } })
    assert.equal(identity.status, 201, JSON.stringify(identity.body))
    const bound = await request('POST', pool(characterId) + '/associations', { target, actor, key: 'external-account-association',
      data: { registrationId, identityId: identity.body.id } })
    assert.equal(bound.status, 201, JSON.stringify(bound.body))
    const resume = await request('POST', characterPath(characterId) + '/controls', { target, actor, key: 'external-account-resume',
      data: { scope: 'ACCOUNT', scopeId: registrationId, operation: 'RESUME' } })
    assert.equal(resume.status, characterId === a ? 200 : 409, JSON.stringify(resume.body))
  }
  const batchPath = characterPath(a) + '/plugins/account-fixture/accounts?id=' + [local.body.id, foreign.body.id, accountA].join('&id=')
  const accounts = await request('GET', batchPath, { target })
  assert.equal(accounts.status, 200)
  assert.deepEqual(accounts.body.map((row: { id: string; status: string }) => [row.id, row.status]), [[local.body.id, 'ACTIVE']])
  assert.equal((await request('GET', batchPath, { target, actor: 'admin-b' })).status, 404)
  const removable = await register(a, 'admin-a', 'removable-registration', 'Allowed')
  const removed = await request('DELETE', pool(a) + '/' + removable.body.id, { target, key: 'external-account-remove' })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  assert.deepEqual(await owner.$queryRaw`SELECT account_id FROM rica_plugin_account_fixture.entries WHERE account_id = ${removable.body.id}::uuid`, [])

  const commandPath = characterPath(a) + '/plugins/account-fixture/commands/'
  const record = (accountId: string, label: string, key = 'package-command', actor = 'admin-a') =>
    request('POST', commandPath + 'record-account', { target, actor, key, data: { accountId, data: { label } } })
  for (const accountId of [foreign.body.id, accountA]) assert.equal((await record(accountId, 'Outside scope')).status, 404)
  assert.equal((await record(local.body.id, 'Outside scope', 'package-command', 'admin-b')).status, 404)
  assert.equal((await request('POST', commandPath + 'record-account', {
    target, data: { accountId: local.body.id, data: { label: 'No key' } },
  })).status, 422)
  assert.equal((await record(local.body.id, 'Reject')).body.error.code, 'PLUGIN_COMMAND_REJECTED')
  assert.equal((await record(local.body.id, 'Malformed')).status, 500)
  assert.deepEqual(await owner.$queryRaw`SELECT id FROM rica_plugin_account_fixture.command_effects`, [])

  const [first, replay] = await Promise.all([record(local.body.id, 'Committed'), record(local.body.id, 'Committed')])
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(first.body.id, replay.body.id)
  assert.equal((await record(local.body.id, 'Changed')).body.error.code, 'IDEMPOTENCY_CONFLICT')
  assert.deepEqual(await owner.$queryRaw`
    SELECT id, character_id, actor_id, account_id, label FROM rica_plugin_account_fixture.command_effects
  `, [{ id: first.body.id, character_id: a, actor_id: actorId(issuer, 'admin-a'), account_id: local.body.id, label: 'Committed' }])
  assert.equal(await owner.managementAudit.count({ where: { characterId: a, targetId: first.body.id,
    actorId: actorId(issuer, 'admin-a'), operation: 'plugin.account-fixture.record-account' } }), 1)

  const characterCommand = await request('POST', commandPath + 'record-character', {
    target, key: 'package-command', data: { data: { label: 'Character scope' } },
  })
  assert.equal(characterCommand.status, 200, JSON.stringify(characterCommand.body))
  assert.deepEqual(await owner.$queryRaw`
    SELECT account_id FROM rica_plugin_account_fixture.command_effects WHERE id = ${characterCommand.body.id}::uuid
  `, [{ account_id: null }])
  const revoked = await request('POST', characterPath(a) + '/controls', { target, key: 'revoke-package-command',
    data: { scope: 'ACCOUNT', scopeId: local.body.id, operation: 'REVOKE_ACCOUNT', reason: 'Verify replay authorization' } })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  assert.equal((await record(local.body.id, 'Committed')).status, 404)
})

test('remote plugin publishers and subscribers are restricted to authorized account bindings and sources', async t => {
  const created = await request('POST', '/characters', { key: 'remote-event-fixture', data: characterData('-remote-event') })
  assert.equal(created.status, 201)
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const identity = await request('POST', characterPath(characterId) + '/identities', {
    key: 'remote-event-identity', data: { slug: 'remote-event', roleProfile: {} },
  })
  assert.equal(identity.status, 201)
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE' } })
  await owner.identity.update({ where: { id: identity.body.id }, data: { status: 'ACTIVE' } })
  const account = await owner.platformAccount.create({ data: {
    characterId, identityId: identity.body.id, platform: 'mock-a', instanceKey: 'integration',
    remoteAccountId: randomUUID(), status: 'ACTIVE',
  } })
  const directory = await mkdtemp(join(tmpdir(), 'rica-remote-event-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const manifest = join(directory, 'plugins.json')
  const publishers = ['source-a', 'source-b'] as const
  const publishToken = randomBytes(32).toString('base64url')
  const otherToken = randomBytes(32).toString('base64url')
  const readToken = randomBytes(32).toString('base64url')
  await writeFile(manifest, JSON.stringify({ version: 1, plugins: [
    { id: publishers[0], tokenEnv: 'RICA_REMOTE_PLUGIN_SOURCE_A', accounts: [account.id], publishActivity: true, tasks: ['analyze'] },
    { id: publishers[1], tokenEnv: 'RICA_REMOTE_PLUGIN_SOURCE_B', accounts: [account.id], publishActivity: true },
    { id: 'consumer', tokenEnv: 'RICA_REMOTE_PLUGIN_CONSUMER', accounts: [account.id], subscribeTo: [publishers[0]] },
  ] }))
  const services = await loadRemotePluginServices(manifest, {
    RICA_REMOTE_PLUGIN_SOURCE_A: publishToken, RICA_REMOTE_PLUGIN_SOURCE_B: otherToken, RICA_REMOTE_PLUGIN_CONSUMER: readToken,
  })
  const runtime = createDatabase(scheduleRuntimeUrl())
  t.after(() => runtime.$disconnect())
  const target = createApp({ postgres: async () => true, redis: async () => true },
    createManagementApp({ db: management, origin: fixtureOrigin, cookie: 'fixture-session', remoteServices: services,
      resolveAdapter: simulationPlatforms.resolveAdapter,
      async authenticate(req) {
        const subject = req.headers.get('Cookie')?.replace('fixture-session=', '')
        return subject ? { issuer, subject, id: actorId(issuer, subject) } : null
      },
    }), undefined, createRemotePluginEvents(runtime, services), createRemotePluginTasks(runtime, services))
  const sourcePath = (pluginId: string, id = account.id) => '/v1/plugin-events/' + pluginId + '/accounts/' + id
  const event: PluginActivityEvent = { id: randomUUID(), type: 'activity.recorded.v1', characterId, bindingVersion: account.bindingVersion,
    occurredAt: '2026-01-01T00:00:00.123456Z', payload: { kind: 'ASSESSMENT', state: 'DONE' } }
  const send = (data: PluginActivityEvent, token = publishToken, path = sourcePath(publishers[0])) => target.request(path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const feed = (after = '0', token = readToken, publisher = 'consumer') => target.request(sourcePath(publisher)
    + '?bindingVersion=' + account.bindingVersion + '&limit=1&after=' + after, { headers: { Authorization: 'Bearer ' + token } })

  assert.equal((await send(event, readToken)).status, 401)
  assert.equal((await send(event, readToken, sourcePath('consumer'))).status, 403)
  assert.equal((await send(event, publishToken, sourcePath(publishers[0], accountA))).status, 404)
  assert.equal((await send({ ...event, characterId: b })).status, 404)
  assert.equal((await send({ ...event, bindingVersion: account.bindingVersion + 1 })).status, 404)
  assert.equal((await send({ ...event, occurredAt: '2999-01-01T00:00:00Z' })).status, 422)
  assert.equal((await feed('0', publishToken, publishers[0])).status, 403)
  assert.equal((await feed('9223372036854775808')).status, 422)

  const retries = await Promise.all([send(event), send(event)])
  assert.deepEqual(retries.map(response => response.status).sort(), [200, 201])
  assert.equal((await send({ ...event, payload: { ...event.payload, state: 'OTHER' } })).status, 409)
  const second = { ...event, id: randomUUID(), occurredAt: '2026-01-01T00:00:00.123457Z' }
  assert.equal((await send(event, otherToken, sourcePath(publishers[1]))).status, 201)
  assert.equal((await send(second)).status, 201)

  const firstResponse = await feed()
  assert.equal(firstResponse.status, 200)
  const first = pluginEventPage.parse(await firstResponse.json())
  assert.deepEqual(first, { items: [{ ...event, pluginId: publishers[0], offset: '1' }], nextOffset: '1' })
  const page = pluginEventPage.parse(await (await feed(first.nextOffset)).json())
  assert.deepEqual(page, { items: [{ ...second, pluginId: publishers[0], offset: '3' }], nextOffset: '3' })
  assert.deepEqual(await (await feed(page.nextOffset)).json(), { items: [], nextOffset: page.nextOffset })

  const activityPath = characterPath(characterId) + '/run-activity?kind=ASSESSMENT&limit=1'
  assert.equal((await request('GET', activityPath, { target, actor: 'admin-b' })).status, 404)
  const activity = await request('GET', activityPath, { target })
  assert.equal(activity.status, 200)
  assert.deepEqual(activity.body.items.map(({ id, platform, createdAt }: { id: string; platform: string; createdAt: string }) =>
    [id, platform, createdAt]), [[second.id, 'plugin:remote:source-a', second.occurredAt]])
  const next = await request('GET', activityPath + '&cursor=' + activity.body.nextCursor, { target })
  assert.equal(next.body.items[0]?.platform, 'plugin:remote:source-b')

  await runtime.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE rica_plugin_event_api`
    const [{ direct }] = await tx.$queryRaw<[{ direct: boolean }]>`
      SELECT has_table_privilege('public.plugin_activity_events', 'SELECT,INSERT') AS direct`
    assert.equal(direct, false)
  })
  const tasksPath = characterPath(characterId) + '/remote-plugins/source-a/tasks'
  const taskInput = { accountId: account.id, bindingVersion: account.bindingVersion, type: 'analyze', data: { text: 'sample' } }
  const queue = (key: string, data = taskInput, actor = 'admin-a') => request('POST', tasksPath, { target, key, actor, data })
  const taskCall = (suffix: string, data: object, token = publishToken, id: string = publishers[0]) =>
    target.request('/v1/plugin-tasks/' + id + '/accounts/' + account.id + suffix, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
  const claim = (token = publishToken) => taskCall('/claim', { bindingVersion: account.bindingVersion }, token)
  assert.equal((await queue('unlisted-task', { ...taskInput, type: 'other' })).status, 404)
  assert.equal((await queue('foreign-task', taskInput, 'admin-b')).status, 404)
  assert.equal((await claim(otherToken)).status, 401)
  assert.equal((await taskCall('/claim', { bindingVersion: account.bindingVersion }, otherToken, publishers[1])).status, 403)
  const queued = await queue('queue-task')
  assert.equal(queued.status, 200)
  assert.equal((await queue('queue-task')).body.id, queued.body.id)
  const claims = await Promise.all([claim(), claim()].map(async response => (await response).json()))
  const job = claims.find(value => value.task)?.task
  assert.equal(claims.filter(value => value.task).length, 1)
  assert.equal(job.id, queued.body.id)
  assert.deepEqual(job.data, taskInput.data)
  await owner.$executeRaw`UPDATE public.remote_plugin_tasks SET lease_until = clock_timestamp()-interval '1 second'
    WHERE id = ${job.id}::uuid`
  const replacement = (await (await claim()).json()).task
  assert.notEqual(replacement.lease, job.lease)
  const receipt = (lease: string, result = { count: 1 }) => taskCall('/' + job.id + '/receipt', {
    bindingVersion: account.bindingVersion, lease, status: 'SUCCEEDED', result,
  })
  assert.equal((await receipt(job.lease)).status, 409)
  assert.equal((await receipt(replacement.lease)).status, 200)
  assert.equal((await receipt(replacement.lease)).status, 200)
  assert.equal((await receipt(replacement.lease, { count: 2 })).status, 409)
  assert.deepEqual((await request('GET', tasksPath + '/' + job.id, { target })).body,
    { id: job.id, status: 'SUCCEEDED', result: { count: 1 } })
  const cancelled = await queue('queue-cancelled-task')
  const cancelledJob = (await (await claim()).json()).task
  assert.equal(cancelledJob.id, cancelled.body.id)
  const revoked = await request('POST', characterPath(characterId) + '/controls', { target, key: 'revoke-remote-event-account',
    data: { scope: 'ACCOUNT', scopeId: account.id, operation: 'REVOKE_ACCOUNT', reason: 'Verify remote event scope' } })
  assert.equal(revoked.status, 200)
  assert.equal((await send(event)).status, 404)
  assert.equal((await feed(page.nextOffset)).status, 404)
  assert.equal((await queue('queue-cancelled-task')).status, 404)
  assert.equal((await claim()).status, 404)
  assert.equal((await taskCall('/' + cancelledJob.id + '/receipt', {
    bindingVersion: account.bindingVersion, lease: cancelledJob.lease, status: 'SUCCEEDED', result: null,
  })).status, 404)
  assert.equal((await request('GET', tasksPath + '/' + cancelledJob.id, { target })).body.status, 'CANCELLED')
})
