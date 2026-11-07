import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthenticationUnavailable, introspectionAuthenticator, loadManagementConfig } from './admin-auth.js'

test('management tokens require active, unexpired claims for the pinned issuer and audience', async () => {
  const issuer = 'https://identity.example.test'
  const endpoint = issuer + '/introspect'
  const exp = Math.floor(Date.now() / 1000) + 60
  let response: unknown = { active: true, iss: issuer, aud: ['rica'], sub: 'admin', exp }
  const authenticate = introspectionAuthenticator({ endpoint, issuer, audience: 'rica', clientId: 'id', clientSecret: 'secret' },
    async (url, init) => {
      assert.equal(url, endpoint)
      assert.equal(init?.redirect, 'error')
      assert.equal(new URLSearchParams(String(init?.body)).get('token'), 'test')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Basic aWQ6c2VjcmV0')
      return response === null ? new Response(null, { status: 502 }) : Response.json(response)
    })
  assert.equal((await authenticate('Bearer test'))?.subject, 'admin')
  assert.equal(await authenticate(undefined), null)
  for (const override of [{ active: false }, { iss: issuer + '/other' }, { aud: 'other' }, { exp: 1 }, { nbf: exp }]) {
    response = { active: true, iss: issuer, aud: 'rica', sub: 'admin', exp, ...override }
    assert.equal(await authenticate('Bearer test'), null)
  }
  response = null
  await assert.rejects(authenticate('Bearer test'), AuthenticationUnavailable)
  assert.equal(loadManagementConfig({}), null)
  assert.throws(() => loadManagementConfig({ RICA_IDP_INTROSPECTION_URL: 'http://localhost' }), /Invalid or incomplete/)
})
