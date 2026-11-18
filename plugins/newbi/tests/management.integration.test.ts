import { startSimulationPlatforms } from '../../../apps/runtime-plugins.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { newbiExecutorIdentity, newbiExecutorKey } from '../rica/runtime/identity.js'
import { createNewbiReplyExecutor } from '../rica/runtime/agent-adapter.js'
import { identifyNewbiAccount, startNewbiReader } from '../rica/runtime/reader.js'
import { openSavedNewbiExecutor, openSavedNewbiReader, readSavedNewbiThread, scopedNewbiDatabase } from '../rica/persistence/database.js'
import { pollNewbiEvents } from '../rica/persistence/events.js'
import { executeNewbiReply } from '../rica/persistence/execution.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { actorId } from '../../../apps/api/admin-auth.js'
import { Redis } from 'ioredis'
import { createApp } from '../../../apps/api/app.js'
import { createNewbiManagement, type NewbiManagementOptions } from '../rica/management/routes.js'
import { connectNewbiSettings } from '../rica/deployment/settings.js'
import { createManagementApp } from '../../../apps/api/management.js'
import { sweepRuntimeRetention } from '../../../apps/worker/runtime-retention.js'
import { createDatabase } from '@ricajs/persistence/client'
import { loadConfig } from '@ricajs/runtime/config'
import { createDeploymentPluginStore } from '../../../apps/deployment-plugins.js'
import { readPluginStatus, reportPluginResult } from '../../../apps/plugin-observation.js'

const config = loadConfig()
const simulationPlatforms = await startSimulationPlatforms({})
const owner = createDatabase(config.databaseUrl)
const management = createDatabase(config.databaseUrl, 'rica_admin_api')
const issuer = 'https://identity.example.test'
const fixtureOrigin = 'http://localhost:5173'
const subjects = new Set(['admin-a', 'admin-b', 'reviewer', 'auditor', 'nonmember'])
let connectorEndpoint: string | undefined
const testApp = (deploymentPlugins?: ReturnType<typeof createDeploymentPluginStore>,
  pollConnector?: NewbiManagementOptions['pollConnector'],
  sendConnector?: NewbiManagementOptions['sendConnector'],
  readConnectorThread?: NewbiManagementOptions['readConnectorThread'],
  reportConnectorOperation?: NewbiManagementOptions['reportConnectorOperation'],
  reviewReply?: NewbiManagementOptions['reviewReply']) =>
  createApp({ postgres: async () => true, redis: async () => true }, createManagementApp({
    db: management,
    origin: fixtureOrigin, cookie: 'fixture-session', resolveAdapter: simulationPlatforms.resolveAdapter,
    deploymentPlugins,
    plugins: [createNewbiManagement(management, deploymentPlugins && connectNewbiSettings(deploymentPlugins.readConfiguration), {
      identifyConnector: (credential, endpoint = connectorEndpoint) => endpoint && endpoint === connectorEndpoint
      ? identifyNewbiAccount({ endpoint, credential }) : Promise.resolve(undefined),
      pollConnector, sendConnector, readConnectorThread, reportConnectorOperation, reviewReply,
    })],
    authenticate: async (request) => {
      const subject = request.headers.get('Cookie')?.match(/^fixture-session=([a-z-]+)$/u)?.[1]
      return subject && subjects.has(subject) ? {
        issuer, subject, id: actorId(issuer, subject), canCreate: subject.startsWith('admin-'),
      } : null
    },
  }))
const app = testApp()

const prefix = 'newbi-test-' + randomUUID()
const characterIds: string[] = []
let a: string
let b: string
let identityA: string
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
  assert.equal(ia.status, 201, JSON.stringify(ia.body))
  identityA = ia.body.id
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
      await tx.managementAudit.deleteMany({ where })
      await tx.managementMembership.deleteMany({ where })
      await tx.newbiReply.deleteMany({ where })
      await tx.platformAccount.deleteMany({ where })
      await tx.identity.updateMany({ where, data: { status: 'PAUSED', activeVersion: null } })
      await tx.identityVersion.deleteMany({ where })
      await tx.identity.deleteMany({ where })
      await tx.character.updateMany({ where: { id: { in: characterIds } }, data: { status: 'PAUSED', activeCoreVersion: null } })
      await tx.coreVersion.deleteMany({ where })
      await tx.character.deleteMany({ where: { id: { in: characterIds } } })
    })
  } finally {
    await Promise.all([management.$disconnect(), owner.$disconnect()])
  }
})

async function databaseNow() {
  const [clock] = await owner.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS now`
  return clock.now.getTime()
}

function runtimeUrl() {
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_runtime')
  return url.toString()
}

async function activeIdentity(roleProfile: Record<string, unknown> = {}, characterId = a) {
  const created = await request('POST', characterPath(characterId) + '/identities', {
    key: randomUUID(), data: { slug: 'newbi-' + randomUUID(), roleProfile },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id: string = created.body.id
  await owner.character.update({ where: { id: characterId }, data: { status: 'ACTIVE' } })
  await owner.identity.update({ where: { id }, data: { status: 'ACTIVE' } })
  return id
}

test('Newbi database permissions are scoped to each host operation', async () => {
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL SESSION AUTHORIZATION rica_runtime`
    const grants = () => tx.$queryRaw<{ reader: boolean; sender: boolean }[]>`
      SELECT has_function_privilege('public.rica_claim_newbi_event_page(uuid,text)', 'EXECUTE') AS reader,
        has_function_privilege('public.rica_claim_newbi_reply(uuid,boolean,uuid,text,text)', 'EXECUTE') AS sender
    `
    assert.deepEqual(await grants(), [{ reader: false, sender: false }])
    await tx.$executeRaw`SET LOCAL ROLE rica_newbi_poller`
    assert.deepEqual(await grants(), [{ reader: true, sender: false }])
    await tx.$executeRaw`SET LOCAL ROLE rica_newbi_executor`
    assert.deepEqual(await grants(), [{ reader: false, sender: true }])
    await tx.$executeRaw`RESET ROLE`
    assert.deepEqual(await grants(), [{ reader: false, sender: false }])
  })
})

test('Newbi installation gates new proposals and approvals while preserving review history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rica-connector-lifecycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const plugins = createDeploymentPluginStore(directory)
  const target = testApp(plugins)
  const change = (input: Parameters<typeof plugins.save>[0], expected: number) => plugins.save(input, expected, async () => 'simulated')
  const endpoint = 'http://127.0.0.1:5000/agent-api/v1'
  const created = await request('POST', '/characters', { key: 'newbi-lifecycle-character', data: characterData('-newbi-lifecycle') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const base = characterPath(characterId)
  assert.equal((await request('POST', base + '/memberships', {
    key: 'newbi-lifecycle-reviewer', data: { subject: 'reviewer', action: 'GRANT', reason: 'Review fixture' },
  })).status, 200)
  assert.equal((await request('POST', base + '/memberships', {
    key: 'newbi-lifecycle-admin', data: { subject: 'admin-b', action: 'GRANT', reason: 'Admin review fixture' },
  })).status, 200)
  const { id: accountId } = await owner.platformAccount.create({ data: {
    characterId, identityId: await activeIdentity({}, characterId), status: 'ACTIVE',
    platform: 'newbi', instanceKey: endpoint, remoteAccountId: randomUUID(),
  } })
  const list = base + '/newbi/replies'
  const data = { accountId, postId: randomUUID(), content: 'Test reply' }
  const propose = () => request('POST', list, { target, key: 'newbi-lifecycle-propose', data })
  assert.equal((await request('GET', base, { target, actor: 'reviewer' })).body.newbiInstalled, false)
  assert.equal((await propose()).body.error.code, 'PLUGIN_STATE_CONFLICT')

  await change({ action: 'INSTALL', id: 'newbi' }, 0)
  assert.equal((await request('GET', base, { target, actor: 'reviewer' })).body.newbiInstalled, true)
  await change({ action: 'ENABLE', id: 'newbi' }, 1)
  await change({ action: 'CONFIGURE_NEWBI', endpoint }, 2)
  const checkedAt = new Date(await databaseNow())
  await owner.newbiEventCheckpoint.upsert({
    where: { accountId }, create: { accountId, lastSucceededAt: checkedAt, readError: 'RATE_LIMITED' },
    update: { lastSucceededAt: checkedAt, readError: 'RATE_LIMITED' },
  })
  const connectionStatus = (id: string, actor: string) => request('GET', characterPath(id) + '/plugins', { target, actor })
  const observed = await connectionStatus(characterId, 'admin-a')
  assert.equal(observed.status, 200, JSON.stringify(observed.body))
  assert.deepEqual(observed.body.newbiConnections, { activeAccounts: 1, readFailures: 1, lastReadAt: checkedAt.toISOString(),
    hasReceipt: false, hasUnknown: false })
  assert.equal((await connectionStatus(characterId, 'nonmember')).status, 404)
  assert.deepEqual((await connectionStatus(b, 'admin-b')).body.newbiConnections,
    { activeAccounts: 0, readFailures: 0, lastReadAt: null, hasReceipt: false, hasUnknown: false })
  const proposal = await propose()
  assert.equal(proposal.status, 201, JSON.stringify(proposal.body))
  const path = list + '/' + proposal.body.id
  const preview = () => request('GET', path, { target, actor: 'reviewer' })
  const initial = await preview()
  assert.equal(initial.body.connectorAvailable, true)
  const decide = (decision: 'APPROVE' | 'REJECT', actor = 'reviewer') => request('POST', path + '/decision', {
    target, actor, key: 'newbi-lifecycle-' + decision,
    data: { decision, reviewDigest: initial.body.reviewDigest, reason: 'Verified lifecycle fixture' },
  })
  await change({ action: 'CONFIGURE_NEWBI', endpoint: 'http://127.0.0.1:5001/agent-api/v1' }, 3)
  assert.equal((await preview()).body.connectorAvailable, false)
  assert.equal((await decide('APPROVE')).body.error.code, 'PLUGIN_STATE_CONFLICT')
  await change({ action: 'DISABLE', id: 'newbi' }, 4)
  assert.equal((await connectionStatus(characterId, 'admin-a')).body.newbiConnections, undefined)
  const disabled = await preview()
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.status, 'WAITING')
  assert.equal(disabled.body.connectorAvailable, false)
  assert.equal((await decide('APPROVE')).body.error.code, 'PLUGIN_STATE_CONFLICT')
  assert.equal((await decide('REJECT', 'admin-b')).body.status, 'REJECTED')
})

test('Newbi auto-approval requires a confirmed prior reply in the same discussion and never sends on creation', async () => {
  const created = await request('POST', '/characters', { key: randomUUID(), data: characterData('-auto-review') })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const characterId: string = created.body.id
  characterIds.push(characterId)
  const base = characterPath(characterId)
  const { id: accountId } = await owner.platformAccount.create({ data: {
    characterId, identityId: await activeIdentity({ writingPrompt: 'Internal account writing instructions' }, characterId), status: 'ACTIVE',
    platform: 'newbi', instanceKey: 'http://127.0.0.1:5000/agent-api/v1', remoteAccountId: randomUUID(),
  } })
  assert.equal((await request('POST', base + '/memberships', {
    key: randomUUID(), data: { subject: 'reviewer', action: 'GRANT', reason: 'Auto-review fixture' },
  })).status, 200)
  const prompt = '批准清楚简短的回复。'
  assert.equal((await request('PUT', base + '/auto-review', {
    ifMatch: '"0"', data: { enabled: true, prompt },
  })).status, 200)
  const previousComment = { id: randomUUID(), content: 'Previously approved', author: { username: 'fixture-agent' } }
  let calls = 0
  let writes = 0
  let locked = false
  let handoff = false
  const target = testApp(undefined, undefined, async () => {
    writes++
    return { status: 'UNAVAILABLE' }
  }, async () => ({
    post: { title: 'Test thread', content: 'Public topic', isLocked: locked }, comments: [previousComment],
  }), undefined, async (settings, { draft }) => {
    calls++
    assert.equal(settings.prompt, prompt)
    if (handoff) {
      assert.equal(draft, 'New assertion')
      return { status: 'REVIEW', reason: '回复含有未核实的事实。', model: 'fixture/default-review-model' }
    }
    assert.equal(draft, 'Routine follow-up')
    return { status: 'APPROVE', model: 'fixture/default-review-model' }
  })
  const list = base + '/newbi/replies'
  const postId = randomUUID()
  const propose = (content: string, key = randomUUID()) =>
    request('POST', list, { target, key, data: { accountId, postId, content } })
  const inspect = (id: string) => request('GET', list + '/' + id, { target })
  const first = await propose('First reply')
  assert.equal(first.status, 201)
  const waiting = await inspect(first.body.id)
  assert.equal(waiting.body.status, 'WAITING')
  assert.match(waiting.body.autoReviewHandoff.reason, /首次互动/)
  assert.equal(calls, 0)
  assert.equal((await propose('Pasted core settings: AI role')).body.error.code, 'PRIVATE_WRITING_PROMPT')
  assert.equal((await propose('Internal account writing instructions')).body.error.code, 'PRIVATE_WRITING_PROMPT')
  const human = await request('POST', list + '/' + first.body.id + '/decision', {
    target, actor: 'reviewer', key: randomUUID(),
    data: { decision: 'APPROVE', reviewDigest: waiting.body.reviewDigest },
  })
  assert.equal(human.status, 200)
  await owner.newbiReply.update({ where: { id: first.body.id },
    data: { status: 'SENT', attempts: 1, remoteCommentId: previousComment.id } })

  const key = randomUUID()
  const second = await propose('Routine follow-up', key)
  assert.equal(second.status, 201)
  assert.equal((await propose('Routine follow-up', key)).body.id, second.body.id)
  const approved = await inspect(second.body.id)
  assert.equal(approved.body.status, 'READY')
  assert.equal(approved.body.autoApproved, true)
  assert.equal(calls, 1)
  assert.equal(writes, 0)
  assert.equal(await owner.managementAudit.count({ where: { targetId: second.body.id, operation: 'newbi.reply.auto-approve' } }), 1)

  handoff = true
  const escalated = await propose('New assertion')
  const manual = await inspect(escalated.body.id)
  assert.equal(manual.body.status, 'WAITING')
  assert.deepEqual(manual.body.autoReviewHandoff, {
    status: 'REVIEW', reason: '回复含有未核实的事实。', model: 'fixture/default-review-model',
  })
  await owner.newbiReply.update({ where: { id: escalated.body.id }, data: { content: null } })
  assert.equal((await owner.newbiReply.findUniqueOrThrow({ where: { id: escalated.body.id } })).autoReviewHandoff, null)

  locked = true
  const third = await propose('Locked discussion')
  const closedThread = await inspect(third.body.id)
  assert.equal(closedThread.body.status, 'WAITING')
  assert.match(closedThread.body.autoReviewHandoff.reason, /已锁定/)
  assert.equal(calls, 2)
})

test('Newbi binds an agent, enforces independent approval and recovers the original remote receipt', { timeout: 30_000 }, async (t) => {
  const agentId = randomUUID()
  let currentAgent = agentId
  const postId = randomUUID()
  const discussionComment = { id: randomUUID(), author: { id: 123, username: 'fixture-user' },
    content: 'Public context', isHidden: false, replyToCommentId: null }
  const secret = 'nbi_agent_' + 'x'.repeat(43)
  const sent = new Map<string, { id: string; content: string }>()
  let writes = 0
  let reads = 0
  let dropResponse = false
  let observeSend: (() => Promise<void>) | undefined
  let preflightLimit = false
  let writeFailure: 'LIMIT' | 'LOCKED' | 'DROP' | undefined
  let locked = false
  const server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0]
    const reply = (data: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ code: 0, data }))
    if (path === '/agent-api/v1/status') return reply({ state: 'OPEN', protocolVersion: 1 })
    if (req.headers.authorization !== 'Bearer ' + secret) return res.writeHead(401).end()
    if (path === '/agent-api/v1/me') {
      if (preflightLimit) return res.writeHead(429, { 'Retry-After': '30' }).end()
      return reply({ id: currentAgent, username: 'fixture-agent', accessStatus: 'ACTIVE' })
    }
    if (path === '/agent-api/v1/rules') return reply({ idempotencyDays: 7 })
    if (path === '/agent-api/v1/quota') return reply({ comments: [{ remaining: 5 }] })
    if (path === '/agent-api/v1/posts/' + postId) {
      reads++
      return reply({ id: postId, title: 'Fixture discussion', content: 'Original context', isHidden: false, isLocked: locked })
    }
    if (path === '/agent-api/v1/posts/' + postId + '/comments') {
      if (req.method === 'GET') {
        reads++
        return reply({ items: [discussionComment, { ...discussionComment, id: randomUUID(), isHidden: true, content: 'Hidden context' }],
          nextCursor: null, hasMore: false })
      }
      writes++
      if (writeFailure === 'LIMIT') return res.writeHead(429, { 'Retry-After': '30' }).end()
      if (writeFailure === 'LOCKED') return res.writeHead(409).end(JSON.stringify({ errorCode: 'POST_LOCKED' }))
      const key = req.headers['idempotency-key']
      if (typeof key !== 'string') return res.writeHead(400).end()
      let body = ''
      for await (const chunk of req) body += chunk
      const { content } = JSON.parse(body) as { content: string }
      const previous = sent.get(key)
      if (previous && previous.content !== content) return res.writeHead(409).end()
      const id = previous?.id ?? randomUUID()
      sent.set(key, { id, content })
      await observeSend?.()
      if (writeFailure === 'DROP' || (dropResponse && !previous)) return res.destroy()
      return reply({ id, postId, replayed: !!previous }, 201)
    }
    return res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const endpoint = 'http://localhost:' + port + '/agent-api/v1'
  const settingsDir = await mkdtemp(join(tmpdir(), 'rica-newbi-host-'))
  t.after(() => rm(settingsDir, { recursive: true, force: true }))
  const settings = createDeploymentPluginStore(settingsDir)
  await settings.save({ action: 'INSTALL', id: 'newbi' }, 0, async () => 'simulated')
  await settings.save({ action: 'ENABLE', id: 'newbi' }, 1, async () => 'simulated')
  await settings.save({ action: 'CONFIGURE_NEWBI', endpoint }, 2, async () => 'simulated')
  const executorUrl = new URL(config.databaseUrl)
  executorUrl.searchParams.set('options', '-c role=rica_newbi_executor')
  const executor = createDatabase(executorUrl.toString())
  const runtime = createDatabase(runtimeUrl())
  const executorDb = scopedNewbiDatabase(runtime, 'executor')
  const readerDb = scopedNewbiDatabase(runtime, 'reader')
  const sendReports: boolean[] = []
  const sendApp = testApp(settings, undefined, async (id, retry) => {
    const host = await openSavedNewbiExecutor(executorDb, connectNewbiSettings(settings.readConfiguration), id)
    if (!host) return { status: 'UNAVAILABLE' }
    try { return await executeNewbiReply(executorDb, host.plugin.implementation, newbiExecutorKey(host.plugin), id, retry) }
    finally { await host.stop() }
  }, (target) => readSavedNewbiThread(readerDb, connectNewbiSettings(settings.readConfiguration), target), (service, succeeded) => {
    assert.equal(service, 'connector-executor')
    sendReports.push(succeeded)
  })
  t.after(() => runtime.$disconnect())
  try {
    const identityId = await activeIdentity()
    const prefix = characterPath(a) + '/newbi'
    connectorEndpoint = endpoint
    const binding = await request('POST', prefix + '/accounts', { key: 'newbi-test-bind', data: { identityId, credential: secret, agentId } })
    assert.equal(binding.status, 201, JSON.stringify(binding.body))
    const accountId = binding.body.id
    assert.equal(binding.body.status, 'PAUSED')
    const resume = (key: string, actor = 'admin-a') => request('POST', characterPath(a) + '/controls', { actor, key,
      data: { scope: 'ACCOUNT', scopeId: accountId, operation: 'RESUME', reason: 'Local protocol fixture' } })
    const checkPath = prefix + '/accounts/' + accountId + '/check'
    assert.equal((await request('POST', checkPath, { actor: 'nonmember' })).status, 404)
    assert.equal((await request('POST', characterPath(b) + '/newbi/accounts/' + accountId + '/check', { actor: 'admin-b' })).status, 404)
    assert.equal((await resume('newbi-unassigned-resume', 'nonmember')).status, 404)
    currentAgent = randomUUID()
    assert.equal((await request('POST', checkPath)).body.verified, false)
    const unverified = await resume('newbi-test-resume')
    assert.equal(unverified.status, 409, JSON.stringify(unverified.body))
    assert.equal(unverified.body.error.code, 'CONNECTOR_VERIFICATION_FAILED')
    assert.equal((await owner.platformAccount.findUniqueOrThrow({ where: { id: accountId } })).status, 'PAUSED')
    currentAgent = agentId
    const checked = await request('POST', checkPath)
    assert.equal(checked.status, 200, JSON.stringify(checked.body))
    assert.equal(checked.body.verified, true)
    assert.equal((await owner.platformAccount.findUniqueOrThrow({ where: { id: accountId } })).status, 'PAUSED')
    const resumed = await resume('newbi-test-resume')
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    connectorEndpoint = undefined
    assert.equal((await resume('newbi-test-resume')).status, 200)
    assert.equal(writes, 0)
    const client = createNewbiReplyExecutor(endpoint, secret)
    const executorKey = newbiExecutorKey(newbiExecutorIdentity)

    const propose = async (text: string, key: string) => {
      const created = await request('POST', prefix + '/replies', { key, data: { accountId, postId, content: text } })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const id: string = created.body.id
      const path = prefix + '/replies/' + id
      const preview = await request('GET', path, { actor: 'reviewer' })
      assert.equal(preview.status, 200, JSON.stringify(preview.body))
      assert.equal(preview.body.agentId, agentId)
      assert.equal(preview.body.identity, (await owner.identity.findUniqueOrThrow({ where: { id: identityId } })).slug)
      assert.equal(preview.body.postId, postId)
      assert.equal(preview.body.accountId, accountId)
      assert.equal(preview.body.content, text)
      const decide = (decision: 'APPROVE' | 'REJECT', actor = 'reviewer') => request('POST', path + '/decision', {
        actor, key: randomUUID(), data: { decision, reviewDigest: preview.body.reviewDigest, reason: 'Checked bound reply' },
      })
      return { id, path, decide, content: preview.body.content }
    }
    const denied = await propose('Rejected fixture text', 'newbi-denied')
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, denied.id), { status: 'UNAVAILABLE' })
    assert.equal((await denied.decide('REJECT')).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, denied.id), { status: 'UNAVAILABLE' })
    assert.equal(writes, 0)
    await assert.rejects(executor.newbiReply.count(), /permission denied/i)

    const approved = await propose('Ordinary fixture reply', 'newbi-success')
    const threadPath = approved.path + '/thread'
    const readsBeforeThread = reads
    assert.equal((await request('GET', threadPath, { target: sendApp, actor: 'nonmember' })).status, 404)
    assert.equal((await request('GET', characterPath(b) + '/newbi/replies/' + approved.id + '/thread', { target: sendApp, actor: 'admin-b' })).status, 404)
    assert.equal(reads, readsBeforeThread)
    currentAgent = randomUUID()
    assert.equal((await request('GET', threadPath, { target: sendApp, actor: 'reviewer' })).status, 503)
    assert.equal(reads, readsBeforeThread)
    currentAgent = agentId
    const context = await request('GET', threadPath + '?postId=' + randomUUID(), { target: sendApp, actor: 'reviewer' })
    assert.equal(context.status, 200, JSON.stringify(context.body))
    assert.deepEqual(context.body, { post: { title: 'Fixture discussion', content: 'Original context', isLocked: false },
      comments: [{ id: discussionComment.id, author: { username: 'fixture-user' }, content: discussionComment.content }] })
    assert.equal(writes, 0)
    const sendFromConsole = (path: string, actor = 'admin-a', retry = false) =>
      request('POST', path + '/send', { actor, target: sendApp, data: { retry } })
    assert.equal((await sendFromConsole(approved.path)).status, 409)
    const queuePath = prefix + '/replies'
    const waitingQueue = await request('GET', queuePath + '?status=WAITING', { actor: 'reviewer' })
    assert.equal(waitingQueue.status, 200, JSON.stringify(waitingQueue.body))
    assert.deepEqual((await request('GET', queuePath + '?status=WAITING&accountId=' + accountId)).body, waitingQueue.body)
    assert.deepEqual((await request('GET', queuePath + '?accountId=' + accountA)).body, { items: [], nextCursor: null })
    assert.deepEqual(waitingQueue.body.items.map((item: { id: string }) => item.id), [approved.id])
    assert.deepEqual(Object.keys(waitingQueue.body.items[0]).sort(), ['agentId', 'createdAt', 'id', 'identity', 'postId', 'status'])
    assert.equal((await request('GET', queuePath, { actor: 'admin-b' })).status, 404)
    assert.equal((await request('GET', queuePath + '?status=WAITING&cursor=' + denied.id)).status, 422)
    const firstPage = await request('GET', queuePath + '?limit=1')
    assert.equal(firstPage.body.items.length, 1)
    assert.equal(firstPage.body.nextCursor, firstPage.body.items[0].id)
    const secondPage = await request('GET', queuePath + '?limit=1&cursor=' + firstPage.body.nextCursor)
    assert.deepEqual([...firstPage.body.items, ...secondPage.body.items].map((item: { id: string }) => item.id).sort(),
      [approved.id, denied.id].sort())
    assert.equal(secondPage.body.nextCursor, null)
    assert.equal((await approved.decide('APPROVE', 'admin-a')).status, 403)
    await assert.rejects(management.$executeRaw`
      UPDATE public.newbi_replies SET status = 'READY', reviewer_id = 'unbound-reviewer' WHERE id = ${approved.id}::uuid
    `, /Approval must bind the reply executor/)
    assert.equal((await approved.decide('APPROVE')).status, 200)
    assert.equal((await sendFromConsole(approved.path, 'nonmember')).status, 404)
    assert.equal((await sendFromConsole(characterPath(b) + '/newbi/replies/' + approved.id, 'admin-b')).status, 404)
    assert.equal((await sendFromConsole(approved.path, 'admin-a', true)).status, 409)
    assert.deepEqual(sendReports, [])
    const nextExecutor = newbiExecutorKey({ ...newbiExecutorIdentity, version: '2.0.0' })
    const readCount = reads
    assert.deepEqual(await executeNewbiReply(executor, client, nextExecutor, approved.id), { status: 'UNAVAILABLE' })
    assert.equal(reads, readCount)
    const [foreignClaim] = await executor.$queryRaw<{ claim: unknown }[]>`
      SELECT public.rica_claim_newbi_reply(${approved.id}::uuid,false,${agentId}::uuid,${endpoint},${nextExecutor}) AS claim
    `
    assert.equal(foreignClaim.claim, null)
    await owner.newbiReply.update({ where: { id: approved.id }, data: { content: approved.content + '\n\nAI 披露：AI role' } })
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, approved.id), { status: 'UNAVAILABLE' })
    assert.equal(reads, readCount)
    assert.equal(writes, 0)
    await owner.newbiReply.update({ where: { id: approved.id }, data: { content: approved.content } })
    currentAgent = randomUUID()
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, approved.id), { status: 'UNAVAILABLE' })
    assert.equal(writes, 0)
    currentAgent = agentId
    const normal = await Promise.all([sendFromConsole(approved.path), sendFromConsole(approved.path)])
    assert.deepEqual(normal.filter(({ body }) => body.status === 'SENT').map(({ status, body }) => [status, body]),
      [[200, { status: 'SENT', commentId: sent.get(approved.id)?.id }]])
    assert.equal(normal.filter(({ status, body }) => (status === 200 && body.status === 'UNAVAILABLE') || status === 409).length, 1)
    assert.equal((await request('GET', approved.path)).body.remoteCommentId, sent.get(approved.id)?.id)
    assert.equal(sent.get(approved.id)?.content, 'Ordinary fixture reply')
    assert.equal(writes, 1)

    const lost = await propose('Lost response fixture reply', 'newbi-unknown')
    assert.equal((await lost.decide('APPROVE')).status, 200)
    const pluginStatusPath = characterPath(a) + '/plugins'
    let inFlightDuringSend: unknown
    observeSend = async () => {
      inFlightDuringSend = (await request('GET', pluginStatusPath, { target: sendApp })).body.newbiPendingDeliveries
    }
    dropResponse = true
    assert.deepEqual((await sendFromConsole(lost.path)).body, { status: 'UNKNOWN' })
    observeSend = undefined
    assert.deepEqual(inFlightDuringSend, { inFlight: 1, unknown: 0 })
    assert.equal(sendReports.at(-1), false)
    assert.equal((await request('GET', lost.path)).body.status, 'UNKNOWN')
    const pending = await request('GET', pluginStatusPath, { target: sendApp })
    assert.equal(pending.status, 200)
    assert.deepEqual(pending.body.newbiPendingDeliveries, { inFlight: 0, unknown: 1 })
    assert.deepEqual((await request('GET', characterPath(b) + '/plugins', { target: sendApp, actor: 'admin-b' })).body.newbiPendingDeliveries,
      { inFlight: 0, unknown: 0 })
    assert.equal(sent.get(lost.id)?.content, lost.content)
    const waiting = await propose('Fixture queued behind unknown result', 'newbi-waiting')
    assert.equal((await waiting.decide('APPROVE')).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, waiting.id), { status: 'UNAVAILABLE' })
    assert.equal(writes, 2)
    assert.deepEqual(await executeNewbiReply(executor, client, nextExecutor, lost.id, true), { status: 'UNAVAILABLE' })
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, lost.id), { status: 'UNAVAILABLE' })
    assert.equal(writes, 2)
    assert.equal((await sendFromConsole(lost.path)).status, 409)
    const recovered = await sendFromConsole(prefix + '/replies/' + lost.id.toUpperCase(), 'admin-a', true)
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
    assert.deepEqual(recovered.body, { status: 'SENT', commentId: sent.get(lost.id)?.id })
    assert.equal(sendReports.at(-1), true)
    const receipt = await request('GET', lost.path)
    assert.equal(receipt.body.remoteCommentId, sent.get(lost.id)?.id)
    assert.equal(receipt.body.attempts, 2)
    assert.deepEqual((await request('GET', pluginStatusPath, { target: sendApp })).body.newbiPendingDeliveries, { inFlight: 0, unknown: 0 })
    assert.equal(sent.size, 2)
    assert.equal(writes, 3)
    assert.ok(reads >= 8)

    const auditPath = characterPath(a) + '/audit?targetId=' + lost.id
    const audit = await request('GET', auditPath)
    assert.equal(audit.status, 200)
    assert.deepEqual(audit.body.items.map(({ operation, targetId, actorId }: { operation: string; targetId: string; actorId: string }) =>
      [operation, targetId, actorId]), [
      ['newbi.reply.create', lost.id, actorId(issuer, 'admin-a')],
      ['newbi.reply.review', lost.id, actorId(issuer, 'reviewer')],
      ['newbi.reply.send', lost.id, actorId(issuer, 'admin-a')],
      ['newbi.reply.retry', lost.id, actorId(issuer, 'admin-a')],
    ])
    assert.equal((await request('GET', auditPath, { actor: 'nonmember' })).status, 404)
    assert.deepEqual((await request('GET', characterPath(b) + '/audit?targetId=' + lost.id, { actor: 'admin-b' })).body,
      { items: [], nextCursor: null })

    // Invalid credentials and locked threads never reach the comment endpoint.
    const invalidClient = createNewbiReplyExecutor(endpoint, 'nbi_agent_' + 'y'.repeat(43))
    assert.deepEqual(await executeNewbiReply(executor, invalidClient, executorKey, waiting.id),
      { status: 'UNAVAILABLE', reason: 'CREDENTIAL_INVALID' })
    assert.equal((await request('GET', waiting.path)).body.attempts, 0)
    locked = true
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, waiting.id), { status: 'CLOSED', reason: 'POST_LOCKED' })
    assert.equal((await request('GET', waiting.path)).body.status, 'CLOSED')
    assert.equal(writes, 3)
    locked = false

    // A 429 during preflight costs no write, and both kinds of 429 block early calls across the account.
    const limited = await propose('Rate-limited fixture reply', 'newbi-limited')
    assert.equal((await limited.decide('APPROVE')).status, 200)
    preflightLimit = true
    const limitTime = Date.now()
    const preflight = await executeNewbiReply(executor, client, executorKey, limited.id)
    assert.equal(preflight.status, 'UNAVAILABLE')
    assert.ok('reason' in preflight && preflight.reason === 'RATE_LIMITED')
    let preview = (await request('GET', limited.path)).body
    assert.equal(preview.attempts, 0)
    assert.ok(Date.parse(preview.retryNotBefore) >= limitTime + 30_000)
    const unrelated = await propose('Fixture reply behind a cooldown', 'newbi-cooldown')
    assert.equal((await unrelated.decide('APPROVE')).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, unrelated.id),
      { status: 'UNAVAILABLE', retryNotBefore: preview.retryNotBefore })
    assert.equal(writes, 3)
    preflightLimit = false
    const passCooldown = () => owner.newbiReply.update({ where: { id: limited.id }, data: { retryNotBefore: new Date(0) } })
    await passCooldown()
    writeFailure = 'LIMIT'
    const rateLimited = await executeNewbiReply(executor, client, executorKey, limited.id)
    assert.equal(rateLimited.status, 'UNKNOWN')
    assert.ok('reason' in rateLimited && rateLimited.reason === 'RATE_LIMITED')
    preview = (await request('GET', limited.path)).body
    assert.equal(preview.attempts, 1)
    assert.ok(Date.parse(preview.retryNotBefore) > Date.now() + 29_000)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true),
      { status: 'UNAVAILABLE', retryNotBefore: preview.retryNotBefore })
    assert.equal(writes, 4)

    // A lost response followed by a lock conflict cannot be treated as a confirmed failure.
    await passCooldown()
    writeFailure = 'DROP'
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNKNOWN' })
    writeFailure = 'LOCKED'
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNKNOWN', reason: 'POST_LOCKED' })
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNAVAILABLE' })
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, unrelated.id), { status: 'UNAVAILABLE' })
    assert.equal(sent.get(limited.id)?.content, limited.content)
    assert.equal(writes, 6)

    const closeReason = 'Checked the discussion and ended delivery attempts'
    const close = (actor: string, key: string, path = limited.path) => request('POST', path + '/close',
      { actor, key, data: { reason: closeReason } })
    assert.equal((await close('nonmember', 'newbi-close-unassigned')).status, 404)
    assert.equal((await close('admin-a', 'newbi-close-ready', unrelated.path)).status, 409)
    assert.equal((await close('admin-a', 'newbi-close')).status, 200)
    assert.equal((await close('admin-a', 'newbi-close')).status, 200)
    preview = (await request('GET', limited.path)).body
    assert.equal(preview.status, 'CLOSED')
    assert.equal(preview.attempts, 3)
    assert.equal(preview.closureReason, closeReason)
    assert.equal(preview.remoteCommentId, null)
    assert.equal(await owner.managementAudit.count({ where: { targetId: limited.id, operation: 'newbi.reply.close' } }), 1)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, limited.id, true), { status: 'UNAVAILABLE' })
    dropResponse = false
    writeFailure = 'LOCKED'
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, unrelated.id), { status: 'CLOSED', reason: 'POST_LOCKED' })
    assert.equal((await request('GET', unrelated.path)).body.status, 'CLOSED')
    assert.equal(writes, 7)
    const paused = await propose('Pause blocks new permits', 'newbi-pause-fixture')
    assert.equal((await paused.decide('APPROVE')).status, 200)
    assert.equal((await request('POST', characterPath(a) + '/controls', { key: 'newbi-test-pause',
      data: { scope: 'ACCOUNT', scopeId: accountId, operation: 'PAUSE', reason: 'Check claim boundary' } })).status, 200)
    assert.deepEqual(await executeNewbiReply(executor, client, executorKey, paused.id), { status: 'UNAVAILABLE' })
    assert.equal((await request('GET', paused.path)).body.attempts, 0)
    assert.equal(writes, 7)
  } finally {
    connectorEndpoint = undefined
    await executor.$disconnect()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('Newbi event polling checkpoints empty and replayed pages, backs off, and fences revoked work', { timeout: 30_000 }, async (t) => {
  const agentId = randomUUID()
  const otherAgentId = randomUUID()
  const otherKey = 'nbi_agent_' + 'y'.repeat(43)
  const avatarUrl = 'https://example.test/avatar.png'
  const postId = randomUUID()
  const commentId = randomUUID()
  const secret = 'nbi_agent_' + 'z'.repeat(43)
  const cursors: (string | null)[] = []
  const opaque = 'cursor/? +&=汉'
  let verifiedAgent = agentId
  const seq = '9007199254740993'
  const event = { seq, type: 'COMMENT_REPLIED', postId, commentId, createdAt: new Date().toISOString() }
  let mode: 'PAGES' | 'LIMIT' | 'EXPIRED' | 'RESUME' | 'PAUSE' = 'PAGES'
  let releasePage!: () => void
  const holdPage = new Promise<void>((resolve) => { releasePage = resolve })
  let confirmRequest!: () => void
  const requestEntered = new Promise<void>((resolve) => { confirmRequest = resolve })
  let calls = 0
  let writes = 0
  const server = createServer(async (req, res) => {
    calls++
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (data: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
    const reply = (data: unknown) => json({ code: 0, data })
    if (req.method !== 'GET') { writes++; return res.writeHead(405).end() }
    if (url.pathname.endsWith('/status')) return reply({ state: 'READ_ONLY', protocolVersion: 1 })
    const otherAgent = req.headers.authorization === 'Bearer ' + otherKey
    if (!otherAgent && req.headers.authorization !== 'Bearer ' + secret) return res.writeHead(401).end()
    if (url.pathname.endsWith('/me')) return reply({ id: otherAgent ? otherAgentId : verifiedAgent,
      username: otherAgent ? 'other-agent' : 'fixture-events', accessStatus: 'ACTIVE', avatarUrl })
    if (url.pathname.endsWith('/rules')) return reply({ idempotencyDays: 7, pollIntervalSeconds: 30 })
    if (url.pathname.endsWith('/quota')) return reply({ comments: [{ remaining: 0 }] })
    if (!url.pathname.endsWith('/events')) return res.writeHead(404).end()
    const cursor = url.searchParams.get('cursor')
    cursors.push(cursor)
    if (mode === 'LIMIT') return res.writeHead(429, { 'Retry-After': '30' }).end()
    if (mode === 'EXPIRED') return json({ errorCode: 'EVENT_CURSOR_EXPIRED', data: { historyLost: true, resetCursor: 'reset' } }, 410)
    if (mode === 'RESUME') return reply({ items: [], nextCursor: 'after-reset', hasMore: false })
    if (mode === 'PAUSE') {
      confirmRequest()
      await holdPage
      return reply({ items: [{ ...event, seq: '9007199254740999' }], nextCursor: 'discarded', hasMore: false })
    }
    if (cursor === null) return reply({ items: [], nextCursor: opaque, hasMore: true })
    if (cursor === opaque) return reply({ items: [event], nextCursor: 'next-page', hasMore: true })
    if (cursor === 'next-page') return reply({ items: [event, { ...event, seq: '9007199254740995' }], nextCursor: 'tail', hasMore: false })
    return res.writeHead(400).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const endpoint = 'http://localhost:' + port + '/agent-api/v1'
  const settingsDir = await mkdtemp(join(tmpdir(), 'rica-newbi-host-'))
  t.after(() => rm(settingsDir, { recursive: true, force: true }))
  const settings = createDeploymentPluginStore(settingsDir)
  await settings.save({ action: 'INSTALL', id: 'newbi' }, 0, async () => 'simulated')
  await settings.save({ action: 'ENABLE', id: 'newbi' }, 1, async () => 'simulated')
  await settings.save({ action: 'CONFIGURE_NEWBI', endpoint }, 2, async () => 'simulated')
  const url = new URL(config.databaseUrl)
  url.searchParams.set('options', '-c role=rica_newbi_poller')
  const db = createDatabase(url.toString())
  const runtime = createDatabase(runtimeUrl())
  const readerEnv = { endpoint, credential: secret }
  const host = await startNewbiReader(readerEnv)
  try {
    const identityId = await activeIdentity()
    const character = characterPath(a)
    const pool = character + '/account-pool'
    const data = { platform: 'newbi', agentId, credential: secret }
    connectorEndpoint = endpoint
    const testConnection = await request('POST', pool + '/newbi/test', { data: { credential: secret } })
    assert.equal(testConnection.status, 200)
    assert.deepEqual(testConnection.body, { agentId, username: 'fixture-events', avatarUrl })
    assert.ok(!JSON.stringify(testConnection.body).includes(secret))
    assert.equal((await request('GET', pool)).body.items.filter(({ platform }: { platform: string }) => platform === 'newbi').length, 0)
    assert.equal((await request('POST', pool, { key: 'newbi-events-mismatch', data: { ...data, agentId: otherAgentId } })).status, 409)
    assert.equal((await request('POST', pool, { key: 'newbi-events-register', data: { ...data, credential: 'nbi_agent_' + 'x'.repeat(43) } })).body.error.code, 'CONNECTOR_VERIFICATION_FAILED')
    connectorEndpoint = endpoint
    assert.equal((await request('POST', pool, { actor: 'nonmember', key: 'newbi-events-forbidden', data })).status, 404)
    assert.equal((await request('POST', pool, { key: 'newbi-events-spoof', data: { ...data, agentId, endpoint } })).status, 422)
    const registered = await request('POST', pool, { key: 'newbi-events-register', data })
    assert.equal(registered.status, 201, JSON.stringify(registered.body))
    const other = await request('POST', pool, {
      key: 'newbi-events-register-other', data: { platform: 'newbi', agentId: otherAgentId, credential: otherKey },
    })
    assert.equal(other.status, 201, JSON.stringify(other.body))
    const entries = (await request('GET', pool)).body.items
    assert.ok(!JSON.stringify(entries).includes(secret) && !JSON.stringify(entries).includes(otherKey))
    const row = entries.find(({ id }: { id: string }) => id === registered.body.id)
    assert.equal(row.remoteAccountId, agentId)
    assert.equal(row.instanceKey, endpoint)
    assert.deepEqual(row.newbiProfile, { agentId, username: 'fixture-events', avatarUrl })
    await owner.newbiCredential.update({ where: { endpoint_agentId: { endpoint, agentId } },
      data: { username: null, avatarUrl: null } })
    assert.equal((await request('POST', character + '/newbi/accounts/' + registered.body.id + '/check')).body.verified, true)
    const refreshed = (await request('GET', pool)).body.items.find(({ id }: { id: string }) => id === registered.body.id)
    assert.deepEqual(refreshed.newbiProfile, row.newbiProfile)
    assert.equal(entries.find(({ id }: { id: string }) => id === other.body.id).remoteAccountId, otherAgentId)
    const removePath = pool + '/' + other.body.id
    assert.equal((await request('DELETE', removePath, { key: 'remove-other', actor: 'nonmember' })).status, 404)
    assert.equal((await request('DELETE', characterPath(b) + '/account-pool/' + other.body.id, {
      key: 'remove-foreign', actor: 'admin-b',
    })).status, 404)
    const removal = await request('DELETE', removePath, { key: 'remove-other' })
    assert.equal(removal.status, 200, JSON.stringify(removal.body))
    assert.equal((await request('DELETE', removePath, { key: 'remove-other' })).status, 200)
    assert.equal(await owner.newbiCredential.count({ where: { endpoint, agentId: otherAgentId } }), 0)
    assert.equal(await owner.newbiCredential.count({ where: { endpoint, agentId } }), 1)
    await assert.rejects(runtime.newbiCredential.count(), /permission denied/i)
    await assert.rejects(db.newbiCredential.count(), /permission denied/i)
    const bind = await request('POST', pool + '/associations', {
      key: 'newbi-events-bind', data: { identityId, registrationId: registered.body.id },
    })
    assert.equal(bind.status, 201, JSON.stringify(bind.body))
    assert.equal((await request('DELETE', pool + '/' + registered.body.id, { key: 'remove-associated' })).body.error.code,
      'ACCOUNT_ALREADY_BOUND')
    const bound = (await request('GET', character + '/accounts?limit=100')).body.items.find(({ id }: { id: string }) => id === bind.body.id)
    assert.ok(bound)
    assert.deepEqual(bound.newbiProfile, row.newbiProfile)
    const accountId: string = bind.body.id
    const reader = host.plugin.implementation
    assert.equal('comment' in reader, false)
    const poll = () => pollNewbiEvents(db, reader, accountId)
    const account = () => owner.newbiEventCheckpoint.findUniqueOrThrow({ where: { accountId } })
    const dueNow = () => owner.newbiEventCheckpoint.update({ where: { accountId }, data: { nextPollAt: new Date(0) } })
    const control = (operation: 'PAUSE' | 'RESUME') => request('POST', character + '/controls', { key: randomUUID(),
      data: { scope: 'ACCOUNT', scopeId: accountId, operation, reason: 'Event polling fixture' } })
    const inbox = '/newbi/accounts/' + accountId + '/events'

    const callsAfterRegistration = calls
    assert.deepEqual(await poll(), { status: 'STOPPED' })
    assert.equal(calls, callsAfterRegistration)
    connectorEndpoint = endpoint
    assert.equal((await control('RESUME')).status, 200)
    connectorEndpoint = undefined
    await assert.rejects(startNewbiReader({ endpoint, credential: '' }), /MISSING_SERVICE/)
    await assert.rejects(startNewbiReader({ ...readerEnv, endpoint: 'https://fixture.example/agent-api/v1' }),
      /INVALID_CONFIG/)
    verifiedAgent = randomUUID()
    assert.deepEqual(await poll(), { status: 'STOPPED' })
    assert.deepEqual(cursors, [])
    assert.equal((await request('GET', character + inbox)).body.readError, 'AGENT_MISMATCH')
    verifiedAgent = agentId
    const badHost = await startNewbiReader({ ...readerEnv, credential: 'nbi_agent_' + 'x'.repeat(43) })
    try {
      await assert.rejects(pollNewbiEvents(db, badHost.plugin.implementation, accountId), /CREDENTIAL_INVALID/)
    } finally {
      await badHost.stop()
    }
    assert.equal((await account()).cursor, null)
    assert.equal((await request('GET', character + inbox)).body.readError, 'CREDENTIAL_INVALID')
    assert.deepEqual(cursors, [])
    const statusRedis = new Redis(config.redisUrl)
    t.after(() => statusRedis.disconnect())
    const reports: Promise<void>[] = []
    const target = testApp(settings, async (id) => {
      const host = await openSavedNewbiReader(db, connectNewbiSettings(settings.readConfiguration), id)
      if (!host) return
      try { return await pollNewbiEvents(db, host.plugin.implementation, id) }
      finally { await host.stop() }
    }, undefined, undefined, (service, succeeded) => {
      reports.push(reportPluginResult(config.redisUrl, service, succeeded ? undefined : 'OPERATION_FAILED'))
    })
    const readerReport = async () => (await readPluginStatus(statusRedis)).services.find(({ service }) => service === 'connector-reader')?.report
    const previousReport = await readerReport()
    const pollPath = character + inbox + '/poll'
    assert.equal((await request('POST', pollPath, { target, actor: 'nonmember' })).status, 404)
    assert.equal((await request('POST', characterPath(b) + inbox + '/poll', { target, actor: 'admin-b' })).status, 404)
    assert.equal(reports.length, 0)
    assert.deepEqual(await readerReport(), previousReport)
    assert.deepEqual(cursors, [])
    const firstRead = await request('POST', pollPath, { target })
    assert.equal(firstRead.status, 200, JSON.stringify(firstRead.body))
    assert.equal(firstRead.body.status, 'READ')
    assert.equal(reports.length, 1)
    await Promise.all(reports)
    assert.equal((await readerReport())?.status, 'COMPLETED')
    assert.equal((await account()).cursor, opaque)
    assert.deepEqual(cursors, [null])

    for (const expectedCursor of ['next-page', 'tail']) {
      await dueNow()
      const page = await request('POST', pollPath, { target })
      assert.equal(page.status, 200, JSON.stringify(page.body))
      assert.equal(page.body.status, 'READ')
      assert.equal((await account()).cursor, expectedCursor)
    }
    assert.deepEqual(cursors, [null, opaque, 'next-page'])
    const caughtUp = await account()
    assert.equal(caughtUp.cursor, 'tail')
    assert.ok(caughtUp.nextPollAt.getTime() > Date.now() + 20_000)
    const deferred = await request('POST', pollPath, { target })
    assert.deepEqual(deferred.body, { status: 'WAITING', nextAt: caughtUp.nextPollAt.toISOString() })
    await Promise.all(reports)
    const reportKey = 'rica:plugin-status:v1:connector-reader'
    assert.ok(await statusRedis.ttl(reportKey) > 0)
    assert.equal(await statusRedis.pexpire(reportKey, 1), 1)
    await sleep(20)
    assert.equal(await readerReport(), null)
    assert.deepEqual(cursors, [null, opaque, 'next-page'])
    const firstInbox = await request('GET', character + inbox)
    assert.equal(firstInbox.status, 200, JSON.stringify(firstInbox.body))
    assert.deepEqual(firstInbox.body.items.map((item: { seq: string }) => item.seq).sort(), [seq, '9007199254740995'])
    assert.equal(firstInbox.body.cursor, undefined)
    assert.equal(firstInbox.body.readError, null)
    assert.equal(firstInbox.body.agentId, agentId)
    assert.equal(Date.parse(firstInbox.body.lastSucceededAt), caughtUp.lastSucceededAt?.getTime())

    assert.equal(JSON.stringify(firstInbox.body).includes(secret), false)
    await assert.rejects(management.$queryRaw`SELECT cursor FROM public.newbi_event_checkpoints`, /permission denied/i)
    assert.equal((await request('GET', character + inbox, { actor: 'nonmember' })).status, 404)
    assert.equal((await request('GET', characterPath(b) + inbox, { actor: 'admin-b' })).status, 404)
    await assert.rejects(db.newbiEvent.count(), /permission denied/i)
    await assert.rejects(db.$queryRaw`SELECT public.rica_claim_newbi_reply(null,false,null,null,null)`, /permission denied/i)

    await dueNow()
    mode = 'LIMIT'
    const atLimit = Date.now()
    const limited = await request('POST', pollPath, { target })
    assert.equal(limited.status, 200)
    assert.equal(limited.body.status, 'WAITING')
    assert.equal(limited.body.reason, 'RATE_LIMITED')
    await Promise.all(reports)
    const limitedReport = await readerReport()
    assert.equal(limitedReport?.status, 'FAILED')
    assert.equal(limitedReport?.diagnostic, 'OPERATION_FAILED')
    const checkpoint = await account()
    assert.equal(checkpoint.cursor, 'tail')
    const failedInbox = await request('GET', character + inbox)
    assert.equal(failedInbox.body.readError, 'RATE_LIMITED')
    assert.equal(failedInbox.body.lastSucceededAt, firstInbox.body.lastSucceededAt)
    assert.ok(checkpoint.nextPollAt.getTime() >= atLimit + 30_000)
    const requestsAtLimit = calls
    assert.deepEqual(await poll(), { status: 'WAITING', nextAt: checkpoint.nextPollAt.toISOString() })
    assert.equal(calls, requestsAtLimit)

    await dueNow()
    mode = 'EXPIRED'
    const reset = await poll()
    assert.ok(reset.status === 'READ' && reset.historyLost && reset.saved === 0)
    assert.equal((await account()).cursor, 'reset')
    const gap = await request('GET', character + inbox)
    assert.equal(gap.body.readError, null)
    assert.equal(gap.body.historyLostCount, 1)
    assert.ok(gap.body.lastHistoryLostAt)
    assert.equal(gap.body.items.length, 2)

    await dueNow()
    mode = 'RESUME'
    assert.equal((await poll()).status, 'READ')
    assert.equal(cursors.at(-1), 'reset')
    assert.equal((await account()).cursor, 'after-reset')

    await dueNow()
    mode = 'PAUSE'
    const pending = poll()
    await Promise.race([requestEntered, pending.then(() => { throw new Error('No event read reached the fixture') })])
    assert.equal((await poll()).status, 'WAITING')
    assert.equal((await control('PAUSE')).status, 200)
    releasePage()
    assert.deepEqual(await pending, { status: 'STOPPED' })
    assert.equal((await account()).cursor, 'after-reset')
    assert.equal(await owner.newbiEvent.count({ where: { accountId } }), 2)
    assert.equal(writes, 0)

    await owner.newbiEvent.updateMany({ where: { accountId }, data: { occurredAt: new Date(0) } })
    await sweepRuntimeRetention(runtime)
    assert.equal(await owner.newbiEvent.count({ where: { accountId } }), 0)
    assert.equal((await account()).historyLostCount, 1)
    const callsBeforeStop = calls
    await host.stop()
    await assert.rejects(reader.verify(), { name: 'AbortError' })
    assert.equal(calls, callsBeforeStop)
  } finally {
    releasePage()
    await Promise.all([host.stop(), db.$disconnect(), runtime.$disconnect()])
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
