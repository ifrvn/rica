import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashPassword, loadManagementConfig, verifyPassword } from './admin-auth.js'

test('local credentials use a random salt and only verify the original password', async () => {
  const password = 'a fixture password'
  const hash = await hashPassword(password)
  assert.notEqual(hash, await hashPassword(password))
  assert.equal(await verifyPassword(password, hash), true)
  assert.equal(await verifyPassword('a different password', hash), false)
  assert.equal(await verifyPassword(password), false)
})

test('management pins a secure origin, RP ID and cookie', () => {
  assert.equal(loadManagementConfig({}), null)
  assert.equal(loadManagementConfig({ RICA_ADMIN_ORIGIN: 'http://localhost:5173' })?.origin, 'http://localhost:5173')
  assert.throws(() => loadManagementConfig({ RICA_ADMIN_ORIGIN: 'http://rica.example' }), /HTTPS/)
  assert.throws(() => loadManagementConfig({ RICA_ADMIN_ORIGIN: 'https://rica.example/admin' }), /HTTPS/)
  const https = loadManagementConfig({ RICA_ADMIN_ORIGIN: 'https://rica.example' })
  assert.equal(https?.rpID, 'rica.example')
  assert.equal(https?.cookie, '__Host-rica_session')
})
