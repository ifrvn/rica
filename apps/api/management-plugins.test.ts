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

function fixture(plugins: ManagementPlugin[]) {
  return createManagementApp({
    db: { $transaction: (read: (tx: object) => unknown) => read({
      managementMembership: { findMany: async () => [{ role: 'ADMIN' }] },
    }) } as unknown as PrismaClient,
    origin, cookie: 'session', resolveAdapter: () => undefined, plugins,
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
