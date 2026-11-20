import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { loadPackageManagement, startPackageWorkers } from '../package-plugins.js'

async function workerDeployment(t: TestContext, modes: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'rica-worker-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const manifest = join(directory, 'plugins.json')
  const log = join(directory, 'worker.log')
  const plugins = await Promise.all(Object.entries(modes).map(async ([id, mode]) => {
    const name = `fixture-${id}`
    const folder = join(directory, 'node_modules', name)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module',
      exports: { './package.json': './package.json', './rica': './worker.js' } }))
    await writeFile(join(folder, 'worker.js'), `
      import { appendFile } from 'node:fs/promises'
      export const ricaPlugin = { id: '${id}', sdkVersion: 1, worker(config, { signal }) {
        return {
          async start() {
            await appendFile(config.log, '${id}:start\\n')
            if (config.mode === 'fail') throw new Error('plugin error')
            if (config.mode === 'wait' && !signal.aborted) {
              await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
            }
          },
          async stop() { await appendFile(config.log, '${id}:stop:' + signal.aborted + '\\n') },
        }
      } }
    `)
    return { id, package: name, version: '1.0.0', config: { log, mode } }
  }))
  await writeFile(manifest, JSON.stringify({ version: 1, plugins }))
  return { manifest, async events() { return (await readFile(log, 'utf8')).trim().split('\n') } }
}

test('worker-only packages stay out of the management host and drain once in reverse order', async (t) => {
  const fixture = await workerDeployment(t, { first: 'ready', second: 'ready' })
  const management = await loadPackageManagement(fixture.manifest)
  assert.deepEqual(management.plugins, [])
  await management.stop()
  const host = await startPackageWorkers(fixture.manifest, new AbortController().signal)
  await Promise.all([host.stop(), host.stop()])
  assert.deepEqual(await fixture.events(), ['first:start', 'second:start', 'second:stop:true', 'first:stop:true'])
})

test('failed or cancelled Worker startup drains the partially started packages', async (t) => {
  const failed = await workerDeployment(t, { first: 'ready', second: 'fail', third: 'ready' })
  await assert.rejects(startPackageWorkers(failed.manifest, new AbortController().signal), /START_FAILED: package-worker\/second/)
  assert.deepEqual(await failed.events(), ['first:start', 'second:start', 'second:stop:true', 'first:stop:true'])

  const cancelled = await workerDeployment(t, { first: 'ready', second: 'wait', third: 'ready' })
  const controller = new AbortController()
  const startup = startPackageWorkers(cancelled.manifest, controller.signal, ({ id, code }) => {
    if (id === 'first' && code === 'READY') setImmediate(() => controller.abort())
  })
  await assert.rejects(startup, /START_FAILED: package-worker\/second/)
  assert.deepEqual(await cancelled.events(), ['first:start', 'second:start', 'second:stop:true', 'first:stop:true'])
})
