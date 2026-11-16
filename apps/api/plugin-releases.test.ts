import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readPluginRelease } from '../plugin-releases.js'

test('unreadable or ambiguous release manifests expose no file details or release link', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rica-plugin-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'plugin-release.json')
  const component = { id: 'fixture', kind: 'model', version: '1.0.0', contractVersion: 1 } as const
  const services = [{ service: 'worker' as const, catalog: [component] }]
  const manifest = { schemaVersion: 1, ricaVersion: '1.10.0', releaseUrl: 'https://example.com/releases/1.10.0' }
  assert.deepEqual(await readPluginRelease(undefined, services), { status: 'UNCONFIGURED' })
  assert.deepEqual(await readPluginRelease(path, services), { status: 'UNAVAILABLE' })
  await writeFile(path, JSON.stringify({ ...manifest, components: [component, component] }))
  assert.deepEqual(await readPluginRelease(path, services), { status: 'UNAVAILABLE' })
  await writeFile(path, JSON.stringify({ ...manifest, releaseUrl: 'https://user:secret@example.com/1.10.0', components: [component] }))
  assert.deepEqual(await readPluginRelease(path, services), { status: 'UNAVAILABLE' })
})
