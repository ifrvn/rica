import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from '@hono/zod-openapi'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import type { ManagementPlugin } from '@ricajs/persistence/management-http'
import { createManagementApp } from './management.js'
import { createDeploymentPluginStore } from '../deployment-plugins.js'
import { startSimulationPlatforms } from '../runtime-plugins.js'
import { localIssuer } from './admin-auth.js'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPackageManagement } from '../package-plugins.js'
import { packageManagementRoute } from './package-management.js'

const origin = 'http://localhost:5173'
const characterId = '10000000-0000-4000-8000-000000000001'

test('an installed package exposes scoped reads only at its pinned version', async (t) => {
  const deployment = await mkdtemp(join(tmpdir(), 'rica-package-plugin-'))
  t.after(() => rm(deployment, { recursive: true, force: true }))
  const pluginDirectory = join(deployment, 'node_modules', '@acme', 'fixture')
  await mkdir(pluginDirectory, { recursive: true })
  const manifestPath = join(deployment, 'plugins.json')
  const stopped = join(deployment, 'stopped')
  const entry = { id: 'acme', package: '@acme/fixture', version: '1.0.0', config: { name: 'Fixture', stopped } }
  const writeManifest = (version: string) => writeFile(manifestPath, JSON.stringify({ version: 1, plugins: [{ ...entry, version }] }))
  await Promise.all([
    writeManifest('2.0.0'),
    writeFile(join(pluginDirectory, 'package.json'), JSON.stringify({ name: entry.package, version: entry.version, type: 'module',
      exports: { './package.json': './package.json', './rica': './plugin.js' } })),
    writeFile(join(pluginDirectory, 'plugin.js'), `
      import { writeFile } from 'node:fs/promises'
      export const ricaPlugin = { id: 'acme', sdkVersion: 1, async management(config) {
        return { async read(request) { return { name: config.name, ...request } },
          stop() { return writeFile(config.stopped, '') } }
      } }
    `),
  ])
  await assert.rejects(loadPackageManagement(manifestPath), /version does not match/)
  await writeManifest(entry.version)
  const host = await loadPackageManagement(manifestPath)
  try {
    const db = { $transaction: (work: (tx: object) => unknown) => work({
      managementMembership: { findUnique: async ({ where }: { where: { characterId_issuer_subject: { characterId: string } } }) =>
        where.characterId_issuer_subject.characterId === characterId ? { subject: 'operator' } : null },
    }) } as unknown as PrismaClient
    const app = fixture(host.plugins.map((plugin) => packageManagementRoute(db, plugin)))
    const headers = { Cookie: 'session=fixture' }
    const path = `/characters/${characterId}/plugins/acme/records?tag=a&tag=b`
    assert.equal((await app.request(path)).status, 401)
    assert.equal((await app.request(path.replace(characterId, '10000000-0000-4000-8000-000000000002'), { headers })).status, 404)
    const result = await app.request(path, { headers })
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { characterId, actorId: 'operator', path: '/records',
      query: [['tag', 'a'], ['tag', 'b']], name: 'Fixture' })
  } finally {
    await host.stop()
  }
  assert.ok((await stat(stopped)).isFile())
})
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

test('only deployment admins can override simulated platform startup selection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rica-sim-platforms-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createDeploymentPluginStore(directory)
  const app = createManagementApp({
    db: {} as PrismaClient, origin, cookie: 'session', resolveAdapter: () => undefined, deploymentPlugins: store,
    authenticate: async (request) => ({ id: 'fixture', issuer: localIssuer, subject: 'fixture',
      canCreate: request.headers.get('Cookie') === 'session=deployment-admin' }),
  })
  const change = (actor: string, version: number, platforms: string[] | null) => app.request('/deployment-plugins', {
    method: 'PUT',
    headers: { Cookie: 'session=' + actor, Origin: origin, 'If-Match': '"' + version + '"', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'CONFIGURE_SIMULATED_PLATFORMS', platforms }),
  })
  assert.equal((await change('role-admin', 0, [])).status, 403)
  assert.equal((await change('deployment-admin', 0, ['mock-a', 'mock-a'])).status, 422)
  assert.equal((await change('deployment-admin', 0, [])).status, 200)
  assert.equal((await change('deployment-admin', 0, ['mock-a'])).status, 412)
  const host = await startSimulationPlatforms({ RICA_SIMULATED_PLATFORMS: 'mock-b' }, undefined,
    await createDeploymentPluginStore(directory).readSimulationPlatforms())
  assert.equal(host.source, 'DEPLOYMENT_SETTINGS')
  assert.deepEqual(host.plugins, [])
  await host.stop()
  assert.equal((await change('deployment-admin', 1, null)).status, 200)
  const inherited = await startSimulationPlatforms({ RICA_SIMULATED_PLATFORMS: 'mock-b' }, undefined, await store.readSimulationPlatforms())
  assert.equal(inherited.source, 'ENVIRONMENT')
  assert.deepEqual(inherited.plugins.map(({ id }) => id), ['mock-b'])
  await inherited.stop()
})
