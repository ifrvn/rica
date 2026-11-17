import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PrismaClient } from '../../../packages/persistence/generated/client.js'
import { createModelSettingsStore, enabledModelSettings } from '../rica/management/settings.js'
import { createDeploymentPluginStore } from '../../../apps/deployment-plugins.js'
import { startConfiguredModel, startModelPlugin } from '../../../apps/runtime-plugins.js'
import { hostedModelsPluginId, modelSettingsContracts } from '../rica/shared.js'
import { localIssuer } from '../../../apps/api/admin-auth.js'
import { createHostedModelManagement } from '../rica/management/routes.js'
import { denyPermission } from '../../../packages/persistence/management.js'
import { createManagementApp } from '../../../apps/api/management.js'

const origin = 'http://localhost:5173'
const path = '/model-settings'
const secret = 'fixture-api-secret'
const openai = { name: 'OpenAI work', provider: 'openai', model: 'fixture-model', apiKey: secret } as const

async function fixture(t: TestContext, managePlugins = false) {
  const directory = await mkdtemp(join(tmpdir(), 'rica-model-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createModelSettingsStore(directory, modelSettingsContracts)
  const plugins = createDeploymentPluginStore(directory)
  const activeModel = async () => (await store.read()).configuration.provider
  const app = createManagementApp({
    db: { $transaction: (work: (tx: object) => unknown) => work({
      managementMembership: { findUnique: async () => ({ subject: 'admin' }) },
    }) } as unknown as PrismaClient,
    origin, cookie: 'rica_session', resolveAdapter: () => undefined, activeModel,
    plugins: [createHostedModelManagement({ modelSettings: store, startModelPlugin,
      authorize(actor) { if (actor.issuer !== localIssuer || !actor.canCreate) denyPermission() },
      isEnabled: () => managePlugins ? plugins.isEnabled(hostedModelsPluginId) : Promise.resolve(true),
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
  const activate = (id: string | null, version: number, user = 'creator') => change(path + '/active', { id }, version, user)
  const check = (id: string, version: number, user = 'creator') => app.request(path + '/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': user, Origin: origin },
    body: JSON.stringify({ id, version }),
  })
  const health = () => app.request('/characters/10000000-0000-4000-8000-000000000001/plugins', {
    headers: { 'X-Test-User': 'role-admin' },
  })
  return { directory, get, put, pluginChange, plugins, store, activate, check, health }
}

test('only the deployment operator can manage model profiles and responses omit all keys', async (t) => {
  const { get, put, activate, health } = await fixture(t)
  assert.equal((await get('')).status, 401)
  assert.equal((await get('role-admin')).status, 403)
  assert.equal((await put(openai, 0, 'role-admin')).status, 403)
  assert.equal((await put(openai, 0, 'creator', 'https://other.example')).status, 403)
  assert.equal((await get()).headers.get('Cache-Control'), 'no-store')
  const response = await put(openai, 0)
  assert.equal(response.status, 200)
  const { profiles: [saved], version, defaultProfileId } = await response.json()
  assert.equal(version, 1)
  assert.equal(defaultProfileId, null)
  assert.deepEqual(saved, { id: saved.id, name: openai.name, provider: 'openai', model: openai.model, baseUrl: null, hasKey: true })
  assert.equal(JSON.stringify(await (await get()).json()).includes(secret), false)
  assert.equal((await activate(saved.id, 1, 'role-admin')).status, 403)
  const { modelProfiles } = await (await health()).json()
  assert.deepEqual(modelProfiles, [{ id: saved.id, name: openai.name, provider: 'openai', model: openai.model }])
})

test('same-provider profiles save independently, require their own keys and reject stale writes', async (t) => {
  const { put, store } = await fixture(t)
  const current = { name: 'First', provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'https://first.example/v1' }
  const responses = await Promise.all([put({ ...current, apiKey: secret }, 0), put({ ...current, apiKey: secret }, 0)])
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 412])
  const { profiles: [first] } = await responses.find(({ status }) => status === 200)!.json()
  const next = { ...current, name: 'Second', model: 'other-model', baseUrl: 'https://second.example/v1' }
  assert.equal((await put(next, 1)).status, 422)
  const { profiles: [, second] } = await (await put({ ...next, apiKey: 'second-key' }, 1)).json()
  assert.notEqual(second.id, first.id)
  assert.equal((await put({ ...current, id: first.id, baseUrl: 'https://other.example/v1' }, 2)).status, 422)
  assert.equal((await put({ ...current, id: first.id, model: 'edited-model' }, 2)).status, 200)
  assert.equal((await store.read(first.id)).configuration.apiKey, secret)
  assert.equal((await store.read(first.id)).configuration.model, 'edited-model')
  assert.equal((await store.read(second.id)).configuration.apiKey, 'second-key')
  assert.equal((await store.read(second.id)).configuration.model, 'other-model')
  assert.equal((await store.read()).configuration.provider, 'simulated')
})

test('the worker resolves named profiles independently of the deployment default and reloads edited profiles', async (t) => {
  const { put, activate, store } = await fixture(t)
  const configured = await startConfiguredModel(store)
  t.after(configured.stop)
  assert.equal((await configured.read()).id, 'simulated')
  const { profiles: [first] } = await (await put(openai, 0)).json()
  const gemini = { name: 'Gemini work', provider: 'gemini', model: 'fixture-gemini', apiKey: 'gemini-key' }
  const { profiles: [, second] } = await (await put(gemini, 1)).json()
  assert.equal((await activate(first.id, 2)).status, 200)
  assert.equal((await configured.read()).implementation.hostedModel, openai.model)
  const alternate = await configured.read(second.id)
  assert.equal(alternate.implementation.hostedProvider, 'gemini')
  assert.equal(await configured.read(second.id), alternate)
  assert.equal((await put({ ...gemini, id: second.id, model: 'edited-gemini', apiKey: undefined }, 3)).status, 200)
  assert.equal((await configured.read(second.id)).implementation.hostedModel, 'edited-gemini')
  assert.equal((await configured.read()).implementation.hostedProvider, 'openai')
  assert.equal((await configured.read('simulated')).id, 'simulated')
  assert.equal((await activate(null, 4)).status, 200)
  assert.equal((await configured.read()).id, 'simulated')
  assert.equal((await configured.read(first.id)).implementation.hostedProvider, 'openai')
})

test('hosted providers share one operator-controlled lifecycle and disabling it blocks named profiles', async (t) => {
  const { activate, check, health, pluginChange, plugins, put, store } = await fixture(t, true)
  const model = await startConfiguredModel(enabledModelSettings(store, () => plugins.isEnabled(hostedModelsPluginId)))
  t.after(model.stop)
  const change = (action: string, version: number) => pluginChange({ action, id: hostedModelsPluginId }, version)
  assert.equal((await pluginChange({ action: 'INSTALL', id: hostedModelsPluginId }, 0, 'role-admin')).status, 403)
  assert.equal((await pluginChange({ action: 'INSTALL', id: 'openai' }, 0)).status, 422)
  assert.equal((await change('ENABLE', 0)).status, 409)
  const installs = await Promise.all([change('INSTALL', 0), change('INSTALL', 0)])
  assert.deepEqual(installs.map(({ status }) => status).sort(), [200, 412])
  assert.equal((await put(openai, 0)).status, 409)
  assert.equal((await change('ENABLE', 1)).status, 200)
  const { profiles: [first] } = await (await put(openai, 0)).json()
  assert.equal((await model.read(first.id)).id, hostedModelsPluginId)
  const { deployment, services } = await (await health()).json()
  assert.deepEqual(Object.keys(deployment.plugins).sort(), [hostedModelsPluginId, 'newbi'])
  assert.deepEqual(services.find(({ service }: { service: string }) => service === 'worker').catalog
    .filter(({ kind }: { kind: string }) => kind === 'model').map(({ id }: { id: string }) => id),
    ['simulated', hostedModelsPluginId])
  assert.equal((await change('DISABLE', 2)).status, 200)
  assert.equal((await model.read(first.id)).id, 'simulated')
  assert.equal((await put(openai, 1)).status, 409)
  assert.equal((await activate(first.id, 1)).status, 409)
  assert.equal((await check(first.id, 1)).status, 409)
  assert.equal((await change('ENABLE', 3)).status, 200)
  assert.equal((await model.read(first.id)).implementation.hostedProvider, 'openai')
})

test('tests run against the selected saved profile and publish only redacted results', async (t) => {
  const { check, health, put } = await fixture(t)
  const { profiles: [first] } = await (await put(openai, 0)).json()
  const secondInput = { name: 'DeepSeek work', provider: 'deepseek', model: 'deepseek-flash', apiKey: 'second-profile-key' }
  const { profiles: [, second] } = await (await put(secondInput, 1)).json()
  let status = 200
  const upstream = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions')
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer ' + secondInput.apiKey)
    const { model, messages } = JSON.parse(String(options.body))
    assert.equal(model, secondInput.model)
    const input = JSON.parse(messages.at(-1).content)
    assert.match(input.message, /测试模型连接/)
    assert.deepEqual(input.references, [])
    return status === 200
      ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: '模型已响应 ' + secondInput.apiKey } }] })
      : new Response('sensitive provider body ' + secondInput.apiKey, { status })
  })
  assert.equal((await check(second.id, 2, 'role-admin')).status, 403)
  assert.equal((await check(second.id, 1)).status, 412)
  assert.equal(upstream.mock.callCount(), 0)

  const result = await (await check(second.id, 2)).json()
  assert.equal(result.status, 'OK')
  assert.equal(result.reply, '模型已响应 [已隐藏]')
  assert.deepEqual((await (await health()).json()).modelChecks, [{
    id: second.id, provider: 'deepseek', status: 'OK', checkedAt: result.checkedAt,
  }])

  status = 401
  const failure = await (await check(second.id, 2)).json()
  assert.equal(failure.status, 'AUTH_FAILED')
  assert.equal(failure.reply, null)
  assert.equal(JSON.stringify(failure).includes(secondInput.apiKey), false)
  assert.equal((await put({ ...openai, id: first.id, model: 'edited-first' }, 2)).status, 200)
  assert.equal((await (await health()).json()).modelChecks.length, 1)
  assert.equal((await put({ ...secondInput, id: second.id, model: 'edited-second' }, 3)).status, 200)
  assert.deepEqual((await (await health()).json()).modelChecks, [])
  assert.equal(upstream.mock.callCount(), 2)
})

test('the single saved model survives conversion to named profiles without exposing its key', async (t) => {
  const { directory, get, put, store } = await fixture(t)
  const { name: _name, ...configuration } = openai
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ version: 4, configuration }))
  const { defaultProfileId, profiles: [first] } = await (await get()).json()
  assert.equal(defaultProfileId, first.id)
  assert.equal(first.hasKey, true)
  assert.equal(JSON.stringify(first).includes(secret), false)
  assert.equal((await put({ name: 'New', provider: 'gemini', model: 'fixture-gemini', apiKey: 'gemini-key' }, 4)).status, 200)
  assert.equal((await store.read()).configuration.apiKey, secret)
  assert.equal((await store.status()).profiles.length, 2)
})
