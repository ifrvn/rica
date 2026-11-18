import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from '@hono/zod-openapi'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import type { ManagementPlugin } from '../../packages/runtime/management-http.js'
import { createManagementApp } from './management.js'

const origin = 'http://localhost:5173'
const characterId = '10000000-0000-4000-8000-000000000001'
const fixturePlugin = (id: string, field: string): ManagementPlugin => ({
  id,
  registerRoutes(app) {
    app.post('/' + id, (c) => c.json({ actor: c.get('actor').id }))
  },
  status: { fields: { [field]: z.boolean() }, read: async () => ({ [field]: true, services: 'invalid' }) },
})

function fixture(plugins: ManagementPlugin[], reviewModel?: Parameters<typeof createManagementApp>[0]['reviewModel']) {
  return createManagementApp({
    db: { $transaction: (read: (tx: object) => unknown) => read({
      managementMembership: { findUnique: async () => ({ subject: 'admin' }) },
      character: { findUnique: async () => ({ autoReviewEnabled: false, autoReviewPrompt: null, autoReviewVersion: 0 }) },
    }) } as unknown as PrismaClient,
    origin, cookie: 'session', resolveAdapter: () => undefined, plugins, reviewModel,
    authenticate: async (request) => request.headers.has('Cookie')
      ? { id: 'operator', issuer: 'fixture', subject: 'operator' } : null,
  })
}

test('management extensions share authentication and contribute independent status fields', async () => {
  const app = fixture([fixturePlugin('first', 'firstStatus'), fixturePlugin('second', 'secondStatus')])
  const cookie = { Cookie: 'session=fixture' }
  assert.equal((await app.request('/first', { method: 'POST', headers: { Origin: origin } })).status, 401)
  assert.equal((await app.request('/second', { method: 'POST', headers: cookie })).status, 403)
  for (const route of ['/first', '/second']) {
    const response = await app.request(route, { method: 'POST', headers: { ...cookie, Origin: origin } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { actor: 'operator' })
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  const response = await app.request('/characters/' + characterId + '/plugins', { headers: cookie })
  assert.equal(response.status, 200)
  const { firstStatus, secondStatus, services } = await response.json()
  assert.deepEqual([firstStatus, secondStatus], [true, true])
  assert.ok(Array.isArray(services))
  assert.throws(() => fixture([fixturePlugin('first', 'services')]), /Duplicate management field: services/)
})

test('auto-review settings only expose the model label and stay readable when model settings fail', async () => {
  const model = { name: 'Review profile', provider: 'OpenAI', model: 'review-model' }
  const configuration = { ...model, apiKey: 'fixture-secret', baseUrl: 'https://example.test' }
  let readable = true
  const app = fixture([], async () => {
    if (!readable) throw new Error('Unreadable model settings')
    return configuration
  })
  const path = '/characters/' + characterId + '/auto-review'
  const headers = { Cookie: 'session=fixture' }
  assert.equal((await app.request(path)).status, 401)
  const response = await app.request(path, { headers })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).model, model)
  readable = false
  const fallback = await app.request(path, { headers })
  assert.equal(fallback.status, 200)
  assert.equal((await fallback.json()).model, null)
})
