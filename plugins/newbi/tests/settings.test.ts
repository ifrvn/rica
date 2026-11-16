import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PrismaClient } from '../../../packages/persistence/generated/client.js'
import { createDeploymentPluginStore } from '../../../apps/deployment-plugins.js'
import { readPluginStatus } from '../../../apps/plugin-observation.js'
import { readPluginRelease } from '../../../apps/plugin-releases.js'
import { createManagementApp } from '../../../apps/api/management.js'
import { localIssuer } from '../../../apps/api/admin-auth.js'
import { connectNewbiSettings } from '../rica/deployment/settings.js'
import { createNewbiReplyExecutor } from '../rica/runtime/agent-adapter.js'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rica-newbi-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('Newbi settings accept only the endpoint and disabling fences existing clients', async (t) => {
  const plugins = createDeploymentPluginStore(await fixture(t))
  const origin = 'http://localhost:5173'
  const app = createManagementApp({
    db: {} as PrismaClient, origin, cookie: 'test', resolveAdapter: () => undefined,
    deploymentPlugins: plugins, activeModel: async () => 'simulated',
    authenticate: async () => ({ id: 'admin', subject: 'admin', issuer: localIssuer, canCreate: true }),
  })
  const pluginChange = (body: unknown, version: number) => app.request('/deployment-plugins', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"' + version + '"', Origin: origin },
    body: JSON.stringify(body),
  })
  const newbi = connectNewbiSettings(plugins.readConfiguration)
  const credential = 'nbi_agent_' + 'x'.repeat(43)
  const endpoint = 'http://127.0.0.1:5000/agent-api/v1'
  const config = { action: 'CONFIGURE_NEWBI', endpoint }
  assert.equal((await pluginChange(config, 0)).status, 409)
  assert.equal((await pluginChange({ action: 'INSTALL', id: 'newbi' }, 0)).status, 200)
  assert.equal((await pluginChange({ action: 'ENABLE', id: 'newbi' }, 1)).status, 200)
  const saved = await pluginChange(config, 2)
  assert.equal(saved.status, 200)
  const view = await saved.json()
  assert.deepEqual(view.newbi, { endpoint })
  assert.equal(JSON.stringify(view).includes(credential), false)
  assert.deepEqual(await newbi.readNewbi(), { endpoint })
  const opened = await newbi.openNewbi(credential)
  assert.ok(opened)
  const oldExecutor = createNewbiReplyExecutor(endpoint, credential, undefined, opened.beforeRequest)
  assert.equal((await pluginChange({ ...config, credential }, 3)).status, 422)
  assert.equal((await pluginChange({ action: 'DISABLE', id: 'newbi' }, 3)).status, 200)
  assert.equal(await newbi.readNewbi(), undefined)
  await assert.rejects(oldExecutor.verify(), /Newbi configuration changed/)
})

test('release previews detect both Newbi components and reject incompatible upgrades', async (t) => {
  const directory = await fixture(t)
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

  await writeFile(path, JSON.stringify({ ...manifest, components: [reader, executor, ...models] }))
  const aligned = await readPluginRelease(path, services)
  assert.equal(aligned.status, 'AVAILABLE')
  if (aligned.status !== 'AVAILABLE') return
  assert.deepEqual(aligned.upgrades, [])
  assert.deepEqual(aligned.aligned.find(({ id }) => id === 'newbi')?.components.map(({ current, target }) => [current, target]),
    [[reader, reader], [executor, executor]])

  await writeFile(path, JSON.stringify({ ...manifest, components: [nextReader, { ...executor, version: '0.9.0' }, ...models] }))
  const downgrade = await readPluginRelease(path, services)
  assert.equal(downgrade.status, 'AVAILABLE')
  if (downgrade.status !== 'AVAILABLE') return
  assert.deepEqual(downgrade.upgrades[0].components.map(({ problem }) => problem), [null, 'DOWNGRADE'])
})
