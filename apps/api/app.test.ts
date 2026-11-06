import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.js'

test('liveness is independent of dependency failures', async () => {
  const down = () => Promise.reject(new Error('offline'))
  const app = createApp({ postgres: down, redis: down })
  assert.equal((await app.request('/health/live')).status, 200)
})

test('readiness returns 200 only when PostgreSQL and Redis respond', async () => {
  const up = async () => true
  const ready = await createApp({ postgres: up, redis: up }).request('/health/ready')
  assert.equal(ready.status, 200)
  assert.deepEqual(await ready.json(), { status: 'ready', checks: { postgres: true, redis: true } })

  const redisDown = async () => { throw new Error('secret connection error') }
  const failed = await createApp({ postgres: up, redis: redisDown }).request('/health/ready')
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { status: 'unavailable', checks: { postgres: true, redis: false } })
})
