import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { parse as parseCookie } from 'hono/utils/cookie'
import { z } from '@hono/zod-openapi'
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { Redis } from 'ioredis'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import {
  allowAuthAttempt, createAdminSessions, localPrincipal, passwordInput, sessionKey, sessionSeconds, usernameInput,
  verifyPassword, type Authenticate, type ManagementConfig,
} from './admin-auth.js'

const challengeSeconds = 300
const challengeKey = (id: string) => 'rica:admin:challenge:' + id
const challengeData = z.object({ challenge: z.string(), registrationSession: z.string().optional() })
const credentialId = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(1024)
const credentialResponse = z.object({
  id: credentialId, rawId: credentialId, type: z.literal('public-key'),
  clientExtensionResults: z.object({}),
})
const encoded = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u)
const authenticationResponse = z.strictObject({ challengeId: z.uuid(), response: credentialResponse.extend({
  response: z.object({ clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: encoded }),
}) })
const registrationResponse = z.strictObject({ challengeId: z.uuid(), response: credentialResponse.extend({
  response: z.object({ clientDataJSON: encoded, attestationObject: encoded }),
}) })
const passwordLogin = z.strictObject({ username: usernameInput, password: passwordInput })
const registrationPassword = z.strictObject({ password: passwordInput })

export function createAdminAuth(db: PrismaClient, redis: Redis, config: ManagementConfig) {
  const app = new Hono()
  const sessions = createAdminSessions(db, redis)
  const cookieOptions = { httpOnly: true, secure: config.secure, sameSite: 'Strict' as const, path: '/' }
  const relyingParty = { expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true }
  const authenticate: Authenticate = async (request) => {
    const token = parseCookie(request.headers.get('Cookie') ?? '', config.cookie)[config.cookie]
    const user = await sessions.read(token)
    return user && localPrincipal(user)
  }

  async function challenge(options: { challenge: string }, registrationSession?: string) {
    const id = randomUUID()
    await redis.set(challengeKey(id), JSON.stringify({ challenge: options.challenge, registrationSession }), 'EX', challengeSeconds)
    return id
  }

  async function consume(id: string, registrationSession?: string) {
    const data = await redis.getdel(challengeKey(id))
    if (!data) return null
    const value = challengeData.parse(JSON.parse(data))
    return value.registrationSession === registrationSession ? value.challenge : null
  }

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET' && c.req.header('Origin') !== config.origin) {
      return c.json({ error: { code: 'ORIGIN_FORBIDDEN' } }, 403)
    }
    await next()
  })
  app.use('*', bodyLimit({ maxSize: 32_768, onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE' } }, 413) }))
  app.onError((_error, c) => c.json({ error: { code: 'AUTH_UNAVAILABLE' } }, 503))

  app.get('/session', async (c) => {
    const user = await sessions.read(getCookie(c, config.cookie))
    if (!user) return c.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
    return c.json({ username: user.username })
  })

  app.post('/login', async (c) => {
    const input = passwordLogin.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: { code: 'INVALID_CREDENTIALS' } }, 401)
    const user = await db.adminUser.findUnique({ where: { username: input.data.username } })
    if (!await allowAuthAttempt(redis, 'password', user?.id)) return c.json({ error: { code: 'RATE_LIMITED' } }, 429)
    if (!await verifyPassword(input.data.password, user?.passwordHash) || !user) {
      return c.json({ error: { code: 'INVALID_CREDENTIALS' } }, 401)
    }
    const token = await sessions.create(user)
    await sessions.revoke(getCookie(c, config.cookie))
    setCookie(c, config.cookie, token, { ...cookieOptions, maxAge: sessionSeconds })
    return c.json({ username: user.username })
  })

  app.post('/logout', async (c) => {
    await sessions.revoke(getCookie(c, config.cookie))
    setCookie(c, config.cookie, '', { ...cookieOptions, maxAge: 0 })
    return c.json({ success: true })
  })

  app.post('/passkeys/login/options', async (c) => {
    if (!await allowAuthAttempt(redis, 'passkey')) return c.json({ error: { code: 'RATE_LIMITED' } }, 429)
    const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' })
    return c.json({ challengeId: await challenge(options), options })
  })

  app.post('/passkeys/login/verify', async (c) => {
    const input = authenticationResponse.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: { code: 'INVALID_PASSKEY' } }, 401)
    const expectedChallenge = await consume(input.data.challengeId)
    if (!expectedChallenge) return c.json({ error: { code: 'INVALID_PASSKEY' } }, 401)
    const response = input.data.response
    const key = await db.adminPasskey.findUnique({ where: { id: response.id }, include: { user: true } })
    if (!key || response.response.userHandle !== Buffer.from(key.user.id).toString('base64url')) {
      return c.json({ error: { code: 'INVALID_PASSKEY' } }, 401)
    }
    const result = await verifyAuthenticationResponse({
      ...relyingParty, response, expectedChallenge,
      credential: { id: key.id, publicKey: key.publicKey, counter: Number(key.counter) },
    }).catch(() => null)
    if (!result?.verified) return c.json({ error: { code: 'INVALID_PASSKEY' } }, 401)
    const updated = await db.adminPasskey.updateMany({ where: { id: key.id, counter: key.counter },
      data: { counter: BigInt(result.authenticationInfo.newCounter) } })
    if (updated.count !== 1) return c.json({ error: { code: 'INVALID_PASSKEY' } }, 401)
    const token = await sessions.create(key.user)
    await sessions.revoke(getCookie(c, config.cookie))
    setCookie(c, config.cookie, token, { ...cookieOptions, maxAge: sessionSeconds })
    return c.json({ username: key.user.username })
  })

  app.post('/passkeys/register/options', async (c) => {
    const token = getCookie(c, config.cookie)
    const user = await sessions.read(token)
    if (!token || !user) return c.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
    const input = registrationPassword.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: { code: 'INVALID_CREDENTIALS' } }, 422)
    if (!await allowAuthAttempt(redis, 'password', user.id)) return c.json({ error: { code: 'RATE_LIMITED' } }, 429)
    if (!await verifyPassword(input.data.password, user.passwordHash)) return c.json({ error: { code: 'INVALID_CREDENTIALS' } }, 422)
    const passkeys = await db.adminPasskey.findMany({ where: { userId: user.id }, select: { id: true }, take: 16 })
    if (passkeys.length >= 16) return c.json({ error: { code: 'PASSKEY_LIMIT' } }, 409)
    const options = await generateRegistrationOptions({
      rpName: 'Rica', rpID: config.rpID, userName: user.username, userID: new TextEncoder().encode(user.id),
      excludeCredentials: passkeys, attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
    return c.json({ challengeId: await challenge(options, sessionKey(token)), options })
  })

  app.post('/passkeys/register/verify', async (c) => {
    const token = getCookie(c, config.cookie)
    const user = await sessions.read(token)
    if (!token || !user) return c.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
    const input = registrationResponse.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: { code: 'INVALID_PASSKEY' } }, 422)
    const expectedChallenge = await consume(input.data.challengeId, sessionKey(token))
    if (!expectedChallenge) return c.json({ error: { code: 'INVALID_PASSKEY' } }, 422)
    const result = await verifyRegistrationResponse({
      ...relyingParty, response: input.data.response, expectedChallenge,
    }).catch(() => null)
    if (!result?.verified) return c.json({ error: { code: 'INVALID_PASSKEY' } }, 422)
    const credential = result.registrationInfo.credential
    const saved = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'rica-admin-user:' + user.username}, 0))`
      if (!(await tx.adminUser.findFirst({ where: { id: user.id, authVersion: user.authVersion } }))) return false
      if (await tx.adminPasskey.count({ where: { userId: user.id } }) >= 16) return false
      const inserted = await tx.adminPasskey.createMany({ skipDuplicates: true, data: {
        userId: user.id, id: credential.id, publicKey: credential.publicKey, counter: BigInt(credential.counter),
      } })
      return inserted.count === 1
    })
    return saved ? c.json({ success: true }, 201) : c.json({ error: { code: 'PASSKEY_CONFLICT' } }, 409)
  })

  return { app, authenticate }
}
