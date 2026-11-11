import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { createModelSettingsStore } from '../../packages/runtime/model-settings-store.js'
import { createDeploymentPluginStore } from '../../packages/runtime/deployment-plugins.js'
import { createNewbiReplyExecutor } from '../../packages/runtime/newbi-client.js'
import { startConfiguredModel } from '../runtime-plugins.js'
import { readPluginStatus } from '../plugin-observation.js'
import { readPluginRelease } from '../plugin-releases.js'
import { localIssuer } from './admin-auth.js'
import { createManagementApp } from './management.js'

const origin = 'http://localhost:5173'
const path = '/model-settings'
const secret = 'fixture-api-secret'
const openai = { provider: 'openai', model: 'fixture-model', apiKey: secret } as const

async function fixture(t: TestContext, managePlugins = false) {
  const directory = await mkdtemp(join(tmpdir(), 'rica-model-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createModelSettingsStore(directory)
  const plugins = createDeploymentPluginStore(directory, {})
  const app = createManagementApp({
    db: { $transaction: (work: (tx: object) => unknown) => work({
      managementMembership: { findMany: async () => [{ role: 'ADMIN' }] },
    }) } as unknown as PrismaClient,
    origin, cookie: 'rica_session', resolveAdapter: () => undefined, modelSettings: store,
    deploymentPlugins: managePlugins ? plugins : undefined,
    authenticate: async (request) => {
      const subject = request.headers.get('X-Test-User')
      return subject && { id: subject, subject, issuer: localIssuer, canCreate: subject === 'creator' } || null
    },
  })
  const get = (user = 'creator') => app.request(path, { headers: { 'X-Test-User': user } })
  const change = (endpoint: string, body: unknown, version: number, user = 'creator', requestOrigin = origin) => app.request(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': '"' + version + '"', 'X-Test-User': user, Origin: requestOrigin },
    body: JSON.stringify(body),
  })
  const put = (body: unknown, version: number, user = 'creator', requestOrigin = origin) => change(path, body, version, user, requestOrigin)
  const pluginChange = (body: unknown, version: number, user = 'creator') => change('/deployment-plugins', body, version, user)
  const check = (version: number, user = 'creator') => app.request(path + '/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': user, Origin: origin },
    body: JSON.stringify({ version }),
  })
  const health = () => app.request('/characters/10000000-0000-4000-8000-000000000001/plugins', {
    headers: { 'X-Test-User': 'role-admin' },
  })
  return { directory, get, put, pluginChange, plugins, store, check, health }
}

test('only the local deployment operator can save model settings and responses omit the key', async (t) => {
  const { get, put } = await fixture(t)
  assert.equal((await get('')).status, 401)
  assert.equal((await get('role-admin')).status, 403)
  assert.equal((await put(openai, 0, 'role-admin')).status, 403)
  assert.equal((await put(openai, 0, 'creator', 'https://other.example')).status, 403)
  assert.equal((await get()).headers.get('Cache-Control'), 'no-store')
  assert.equal((await put(openai, 0)).status, 200)
  const read = await (await get()).json()
  assert.deepEqual(read, { version: 1, provider: 'openai', model: 'fixture-model', baseUrl: null, hasKey: true })
  assert.equal(JSON.stringify(read).includes(secret), false)
})

test('stale writes cannot overwrite settings and changing endpoints requires a new key', async (t) => {
  const { put, directory } = await fixture(t)
  const current = { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'https://first.example/v1' }
  const responses = await Promise.all([put({ ...current, apiKey: secret }, 0), put({ ...current, apiKey: secret }, 0)])
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 412])
  const saved = await (responses.find(({ status }) => status === 200))!.text()
  assert.equal(saved.includes(secret), false)
  assert.equal((await put({ ...current, baseUrl: 'https://other.example/v1' }, 1)).status, 422)
  assert.equal((await put({ ...current, model: 'other-model' }, 1)).status, 200)
  const store = createModelSettingsStore(directory)
  assert.equal((await store.read()).configuration.apiKey, secret)
  assert.equal((await put({ provider: 'simulated' }, 2)).status, 200)
  assert.equal((await store.read()).configuration.apiKey, undefined)
})

test('a running Worker model loader uses saved settings on the next draft', async (t) => {
  const { put, directory } = await fixture(t)
  const configured = await startConfiguredModel(createModelSettingsStore(directory))
  t.after(configured.stop)
  assert.equal((await configured.read()).id, 'simulated')
  assert.equal((await put(openai, 0)).status, 200)
  const next = await configured.read()
  assert.equal(next.id, 'openai')
  assert.equal(next.implementation.hostedModel, 'fixture-model')
  assert.equal(await configured.read(), next)
  assert.equal((await put({ provider: 'simulated' }, 1)).status, 200)
  assert.equal((await configured.read()).id, 'simulated')
})

test('only the deployment operator can install and enable models; stopping a model returns the worker to local drafting', async (t) => {
  const { pluginChange, plugins, put, store } = await fixture(t, true)
  const model = await startConfiguredModel({ read: () => plugins.readModel(store) })
  t.after(model.stop)
  const change = (action: string, version: number) => pluginChange({ action, id: 'openai' }, version)
  assert.equal((await pluginChange({ action: 'INSTALL', id: 'openai' }, 0, 'role-admin')).status, 403)
  assert.equal((await change('ENABLE', 0)).status, 409)
  const installs = await Promise.all([change('INSTALL', 0), change('INSTALL', 0)])
  assert.deepEqual(installs.map(({ status }) => status).sort(), [200, 412])
  assert.equal((await put(openai, 0)).status, 409)
  assert.equal((await change('ENABLE', 1)).status, 200)
  assert.equal((await put(openai, 0)).status, 200)
  assert.equal((await model.read()).id, 'openai')
  assert.equal((await change('DISABLE', 2)).status, 200)
  assert.equal((await model.read()).id, 'simulated')
  assert.equal((await put(openai, 1)).status, 409)
  assert.equal((await change('ENABLE', 3)).status, 200)
  assert.equal((await model.read()).id, 'openai')
})

test('model checks use the saved configuration and disclose only a redacted reply to the operator', async (t) => {
  const { check, health, pluginChange, put } = await fixture(t, true)
  let status = 200
  const upstream = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions')
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer ' + secret)
    const { model, messages } = JSON.parse(String(options.body))
    assert.equal(model, openai.model)
    const input = JSON.parse(messages.at(-1).content)
    assert.match(input.message, /测试模型连接/)
    assert.deepEqual(input.references, [])
    return status === 200
      ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: '模型已响应 ' + secret } }] })
      : new Response('sensitive provider body ' + secret, { status })
  })
  assert.equal((await pluginChange({ action: 'INSTALL', id: 'openai' }, 0)).status, 200)
  assert.equal((await pluginChange({ action: 'ENABLE', id: 'openai' }, 1)).status, 200)
  assert.equal((await put(openai, 0)).status, 200)
  assert.equal((await check(1, 'role-admin')).status, 403)
  assert.equal((await check(2)).status, 412)
  assert.equal(upstream.mock.callCount(), 0)

  const tested = await check(1)
  assert.equal(tested.status, 200)
  const result = await tested.json()
  assert.equal(result.status, 'OK')
  assert.equal(result.reply, '模型已响应 [已隐藏]')
  assert.deepEqual((await (await health()).json()).modelCheck, {
    provider: 'openai', status: 'OK', checkedAt: result.checkedAt,
  })

  status = 401
  const failure = await (await check(1)).json()
  assert.equal(failure.status, 'AUTH_FAILED')
  assert.equal(failure.reply, null)
  assert.equal(JSON.stringify(failure).includes(secret), false)
  assert.equal((await put({ provider: 'openai', model: 'other-model' }, 1)).status, 200)
  assert.equal((await (await health()).json()).modelCheck, undefined)
  assert.equal((await pluginChange({ action: 'DISABLE', id: 'openai' }, 2)).status, 200)
  assert.equal((await check(2)).status, 409)
  assert.equal(upstream.mock.callCount(), 2)
})

test('Newbi credentials stay write-only and disabled connectors cannot acquire credentials', async (t) => {
  const { pluginChange, plugins } = await fixture(t, true)
  const credential = 'nbi_agent_' + 'x'.repeat(43)
  const endpoint = 'http://127.0.0.1:5000/agent-api/v1'
  const config = { action: 'CONFIGURE_NEWBI', endpoint, credential }
  assert.equal((await pluginChange(config, 0)).status, 409)
  assert.equal((await pluginChange({ action: 'INSTALL', id: 'newbi' }, 0)).status, 200)
  assert.equal((await pluginChange({ action: 'ENABLE', id: 'newbi' }, 1)).status, 200)
  const saved = await pluginChange(config, 2)
  assert.equal(saved.status, 200)
  const view = await saved.json()
  assert.deepEqual(view.newbi, { endpoint, hasCredential: true })
  assert.equal(JSON.stringify(view).includes(credential), false)
  assert.deepEqual(await plugins.readNewbi(), { endpoint, credential })
  const opened = await plugins.openNewbi()
  assert.ok(opened)
  const oldExecutor = createNewbiReplyExecutor(endpoint, credential, undefined, opened.beforeRequest)
  assert.equal((await pluginChange({ action: 'CONFIGURE_NEWBI', endpoint: 'http://127.0.0.1:5001/agent-api/v1' }, 3)).status, 422)
  assert.equal((await pluginChange({ action: 'DISABLE', id: 'newbi' }, 3)).status, 200)
  assert.equal(await plugins.readNewbi(), undefined)
  await assert.rejects(oldExecutor.verify(), /Newbi configuration changed/)
})

test('release previews detect both Newbi components and reject incompatible upgrades', async (t) => {
  const { directory } = await fixture(t)
  const path = join(directory, 'plugin-release.json')
  const { services } = await readPluginStatus()
  const reader = services.find(({ service }) => service === 'connector-reader')!.catalog[0]
  const executor = services.find(({ service }) => service === 'connector-executor')!.catalog[0]
  const models = services.find(({ service }) => service === 'worker')!.catalog.filter(({ kind }) => kind === 'model')
  const manifest = { schemaVersion: 1, ricaVersion: '1.10.0', releaseUrl: 'https://example.com/releases/1.10.0' }
  const nextReader = { ...reader, version: '1.10.0' }

  await writeFile(path, JSON.stringify({ ...manifest, components: [nextReader] }))
  const partial = await readPluginRelease(path, services)
  assert.equal(partial.status, 'AVAILABLE')
  if (partial.status !== 'AVAILABLE') return
  assert.deepEqual(partial.upgrades[0].components.map(({ problem }) => problem), [null, 'MISSING_COMPONENT'])

  await writeFile(path, JSON.stringify({ ...manifest, components: [nextReader, { ...executor, contractVersion: 2 }] }))
  const incompatible = await readPluginRelease(path, services)
  assert.equal(incompatible.status, 'AVAILABLE')
  if (incompatible.status !== 'AVAILABLE') return
  assert.deepEqual(incompatible.upgrades[0].components.map(({ problem }) => problem), [null, 'INCOMPATIBLE_CONTRACT'])

  await writeFile(path, JSON.stringify({ ...manifest, components: [nextReader, executor, ...models] }))
  const available = await readPluginRelease(path, services)
  assert.equal(available.status, 'AVAILABLE')
  if (available.status !== 'AVAILABLE') return
  assert.deepEqual(available.upgrades.map(({ id }) => id), ['newbi'])
  assert.ok(available.upgrades[0].components.every(({ problem }) => problem === null))

  await writeFile(path, JSON.stringify({ ...manifest, components: [nextReader, { ...executor, version: '0.9.0' }, ...models] }))
  const downgrade = await readPluginRelease(path, services)
  assert.equal(downgrade.status, 'AVAILABLE')
  if (downgrade.status !== 'AVAILABLE') return
  assert.deepEqual(downgrade.upgrades[0].components.map(({ problem }) => problem), [null, 'DOWNGRADE'])
})

test('unreadable or ambiguous release manifests expose no file details or release link', async (t) => {
  const { directory } = await fixture(t)
  const path = join(directory, 'plugin-release.json')
  const { services } = await readPluginStatus()
  const reader = services.find(({ service }) => service === 'connector-reader')!.catalog[0]
  const manifest = { schemaVersion: 1, ricaVersion: '1.10.0', releaseUrl: 'https://example.com/releases/1.10.0' }
  assert.deepEqual(await readPluginRelease(undefined, services), { status: 'UNCONFIGURED' })
  assert.deepEqual(await readPluginRelease(path, services), { status: 'UNAVAILABLE' })
  await writeFile(path, JSON.stringify({ ...manifest, components: [reader, reader] }))
  assert.deepEqual(await readPluginRelease(path, services), { status: 'UNAVAILABLE' })
  await writeFile(path, JSON.stringify({ ...manifest, releaseUrl: 'https://user:secret@example.com/1.10.0', components: [reader] }))
  assert.deepEqual(await readPluginRelease(path, services), { status: 'UNAVAILABLE' })
})
