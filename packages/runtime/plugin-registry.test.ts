import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveModelProvider, simulatedModelPlugin } from './model-provider.js'
import { PluginHostError, registerPlugins, startPluginHost, type PluginDefinition } from './plugin-registry.js'

test('registration rejects duplicate IDs, incompatible contracts and unknown model configuration', () => {
  assert.equal(resolveModelProvider('simulated'), simulatedModelPlugin)
  assert.throws(() => resolveModelProvider('missing'), /Unknown model plugin: missing/)
  assert.throws(() => registerPlugins('model', [simulatedModelPlugin, simulatedModelPlugin]), /DUPLICATE_PLUGIN/)
  assert.throws(() => registerPlugins('model', [{ ...simulatedModelPlugin, contractVersion: 2 }]), /INCOMPATIBLE_CONTRACT/)
})

function definition(id: string, overrides: Partial<PluginDefinition<string>> = {}): PluginDefinition<string> {
  return { id, version: '1.0.0', contractVersion: 1, create: () => ({ implementation: id }), ...overrides }
}

test('host validates required configuration before startup and reports unavailable optional capabilities', async () => {
  const diagnostics: string[] = []
  const starts: string[] = []
  const ready = definition('ready', { create: () => ({ implementation: 'ready', start: () => { starts.push('ready') } }) })
  const dependent = definition('dependent', { requires: ['limited-reader'], validateConfig: (value) => value === true })
  const options = { report: ({ id, code }: { id: string; code: string }) => { diagnostics.push(id + ':' + code) } }
  await assert.rejects(startPluginHost('platform', [ready, dependent], [{ id: 'ready' }, { id: 'dependent', config: 'secret' }], options),
    (error) => error instanceof PluginHostError && error.diagnostic.code === 'INVALID_CONFIG' && !error.message.includes('secret'))
  assert.deepEqual(starts, [])
  const host = await startPluginHost('platform', [ready, dependent], [
    { id: 'ready' }, { id: 'dependent', config: true, optional: true },
  ], options)
  assert.equal(host.find('dependent'), undefined)
  assert.equal(host.find('ready')?.implementation, 'ready')
  assert.deepEqual(diagnostics, ['dependent:MISSING_SERVICE', 'ready:READY'])
  await host.stop()
})

test('failed startup releases resources in reverse and stop immediately disables lookup', async () => {
  const calls: string[] = []
  const withResource = (id: string, fail = false) => definition(id, { create: () => ({
    implementation: id,
    start() {
      calls.push('start:' + id)
      if (fail) throw new Error('private startup details')
    },
    stop() { calls.push('stop:' + id) },
  }) })
  const first = withResource('first')
  const second = withResource('second')
  const broken = withResource('broken', true)
  await assert.rejects(startPluginHost('platform', [first, second, broken], [
    { id: 'first' }, { id: 'second' }, { id: 'broken' },
  ]), (error) => error instanceof PluginHostError && error.message === 'START_FAILED: platform/broken')
  assert.deepEqual(calls, ['start:first', 'start:second', 'start:broken', 'stop:broken', 'stop:second', 'stop:first'])
  calls.length = 0
  const host = await startPluginHost('platform', [first], [{ id: 'first' }])
  const stopped = host.stop()
  assert.equal(host.find('first'), undefined)
  assert.equal(host.stop(), stopped)
  await stopped
  assert.deepEqual(calls, ['start:first', 'stop:first'])
})
