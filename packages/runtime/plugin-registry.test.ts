import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveModelProvider, simulatedModelPlugin } from './model-provider.js'
import { registerPlugins } from './plugin-registry.js'

test('registration rejects duplicate IDs, incompatible contracts and unknown model configuration', () => {
  assert.equal(resolveModelProvider('simulated'), simulatedModelPlugin)
  assert.throws(() => resolveModelProvider('missing'), /Unknown model plugin: missing/)
  assert.throws(() => registerPlugins('model', [simulatedModelPlugin, simulatedModelPlugin]),
    /Duplicate model registration: simulated/)
  assert.throws(() => registerPlugins('model', [{ ...simulatedModelPlugin, contractVersion: 2 }]),
    /Incompatible model contract: simulated/)
})
