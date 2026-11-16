import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { createModelSettingsStore, enabledModelSettings } from './settings.js'
import { createDeploymentPluginStore } from '../../apps/deployment-plugins.js'
import { startConfiguredModel, startModelPlugin } from '../../apps/runtime-plugins.js'
import { modelPluginCatalog, modelSettingsContracts } from '../../apps/model-plugin-catalog.js'
import { createModelSettingsContracts } from './contracts.js'
import type { ModelPluginOption, ModelProvider } from '@rica/contracts/model-provider'
import type { PluginDefinition } from '@rica/plugin-host'
import { simulatedModelDefinition } from '@rica/plugin-simulated-model'
import { localIssuer } from '../../apps/api/admin-auth.js'
import { createHostedModelManagement } from './management.js'
import { denyPermission } from '../../packages/persistence/management.js'
import { createManagementApp } from '../../apps/api/management.js'

const origin = 'http://localhost:5173'
const path = '/model-settings'
const secret = 'fixture-api-secret'
const openai = { provider: 'openai', model: 'fixture-model', apiKey: secret } as const

async function fixture(t: TestContext, managePlugins = false, contracts = modelSettingsContracts, start = startModelPlugin) {
  const directory = await mkdtemp(join(tmpdir(), 'rica-model-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createModelSettingsStore(directory, contracts)
  const plugins = createDeploymentPluginStore(directory)
  const activeModel = async () => (await store.status()).provider
  const app = createManagementApp({
    db: { $transaction: (work: (tx: object) => unknown) => work({
      managementMembership: { findUnique: async () => ({ subject: 'admin' }) },
    }) } as unknown as PrismaClient,
    origin, cookie: 'rica_session', resolveAdapter: () => undefined, activeModel,
    plugins: [createHostedModelManagement({ modelSettings: store, startModelPlugin: start,
      authorize(actor) { if (actor.issuer !== localIssuer || !actor.canCreate) denyPermission() },
      isEnabled: (id) => managePlugins ? plugins.isEnabled(id, activeModel) : Promise.resolve(true),
    })],
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
  const store = createModelSettingsStore(directory, modelSettingsContracts)
  assert.equal((await store.read()).configuration.apiKey, secret)
  assert.equal((await put({ provider: 'simulated' }, 2)).status, 200)
  assert.equal((await store.read()).configuration.apiKey, undefined)
})

test('a running Worker model loader uses saved settings on the next draft', async (t) => {
  const { put, directory } = await fixture(t)
  const configured = await startConfiguredModel(createModelSettingsStore(directory, modelSettingsContracts))
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
  const model = await startConfiguredModel(enabledModelSettings(store, (provider) => plugins.isEnabled(provider, async () => provider)))
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

test('a separately registered model appears in settings and is loaded and checked through its own factory', async (t) => {
  const option = { id: 'fixture-model-provider', name: 'Fixture model', requiresBaseUrl: true } satisfies ModelPluginOption
  const definition: PluginDefinition<ModelProvider> = {
    id: option.id, version: '1.0.0', contractVersion: 1,
    prepare(config) {
      assert.deepEqual(config, { model: 'fixture-model', apiKey: secret, baseUrl: 'https://fixture.example/v1' })
      return () => ({
        implementation: {
          async decide() { return 'REPLY' },
          async write() { return { text: 'Fixture reply', evidenceIds: [] } },
        },
      })
    },
  }
  const contracts = createModelSettingsContracts([...modelPluginCatalog, option])
  const start: typeof startModelPlugin = (configuration, service) =>
    startModelPlugin(configuration, service, [simulatedModelDefinition, definition])
  const { check, get, health, put, store } = await fixture(t, false, contracts, start)
  const configured = await startConfiguredModel(store, undefined, start)
  t.after(configured.stop)

  assert.ok(contracts.modelSettingsInput.shape.provider.options.includes(option.id))
  assert.equal((await configured.read()).id, 'simulated')
  const input = { provider: option.id, model: 'fixture-model', apiKey: secret }
  assert.equal((await put(input, 0)).status, 422)
  assert.equal((await put({ ...input, baseUrl: 'https://fixture.example/v1/' }, 0)).status, 200)
  assert.deepEqual(await (await get()).json(), {
    version: 1, provider: option.id, model: input.model, baseUrl: 'https://fixture.example/v1', hasKey: true,
  })
  assert.equal((await configured.read()).id, option.id)
  const result = await (await check(1)).json()
  assert.equal(result.reply, 'Fixture reply')
  assert.deepEqual(await (await health()).json().then(({ modelCheck }) => modelCheck), {
    provider: option.id, status: 'OK', checkedAt: result.checkedAt,
  })
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
