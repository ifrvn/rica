import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { createModelSettingsStore } from '../../packages/runtime/model-settings-store.js'
import { startConfiguredModel } from '../runtime-plugins.js'
import { localIssuer } from './admin-auth.js'
import { createManagementApp } from './management.js'

const origin = 'http://localhost:5173'
const path = '/model-settings'
const secret = 'fixture-api-secret'
const openai = { provider: 'openai', model: 'fixture-model', apiKey: secret } as const

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rica-model-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createModelSettingsStore(directory)
  const app = createManagementApp({
    db: {} as PrismaClient, origin, cookie: 'rica_session', resolveAdapter: () => undefined, modelSettings: store,
    authenticate: async (request) => {
      const subject = request.headers.get('X-Test-User')
      return subject && { id: subject, subject, issuer: localIssuer, canCreate: subject === 'creator' } || null
    },
  })
  const get = (user = 'creator') => app.request(path, { headers: { 'X-Test-User': user } })
  const put = (body: unknown, version: number, user = 'creator', requestOrigin = origin) => app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': '"' + version + '"', 'X-Test-User': user, Origin: requestOrigin },
    body: JSON.stringify(body),
  })
  return { directory, get, put }
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
