import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('the configured log threshold filters structured service events', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { logger } from '@ricajs/runtime/logging'
    logger.debug({ service: 'worker', event: 'attempt_started' })
    logger.info({ service: 'api', event: 'started' })
    logger.warn({ service: 'worker', event: 'dependency_error' })
    logger.error({ service: 'api', event: 'management_error', requestId: 'fixture-id' })
  `], { env: { ...process.env, RICA_LOG_LEVEL: 'warn' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(records.map(({ level, service, event, requestId }) => ({ level, service, event, requestId })), [
    { level: 40, service: 'worker', event: 'dependency_error', requestId: undefined },
    { level: 50, service: 'api', event: 'management_error', requestId: 'fixture-id' },
  ])
})
