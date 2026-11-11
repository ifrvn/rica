import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { createModelSettingsStore } from '../../packages/runtime/model-settings-store.js'
import { createDeploymentPluginStore } from '../../packages/runtime/deployment-plugins.js'
import { createNewbiReplyExecutor } from '../../packages/runtime/newbi-client.js'
import { startConfiguredModel } from '../runtime-plugins.js'
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
    db: {} as PrismaClient, origin, cookie: 'rica_session', resolveAdapter: () => undefined, modelSettings: store,
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
  return { directory, get, put, pluginChange, plugins, store }
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
