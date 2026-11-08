import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { Redis } from 'ioredis'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'

export const localIssuer = 'rica:local'
export const usernameInput = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u)
export const passwordInput = z.string().min(12).max(128)
export const sessionSeconds = 8 * 60 * 60
export const sessionToken = /^[A-Za-z0-9_-]{43}$/u
const dummyHash = '0'.repeat(32) + ':' + '0'.repeat(64)

export type Principal = Readonly<{ issuer: string; subject: string; id: string; canCreate?: boolean }>
export type Authenticate = (request: Request) => Promise<Principal | null>

export function loadManagementConfig(env = process.env) {
  if (!env.RICA_MANAGEMENT_DATABASE_URL && !env.RICA_ADMIN_ORIGIN) return null
  const db = env.RICA_MANAGEMENT_DATABASE_URL
  const value = env.RICA_ADMIN_ORIGIN ?? 'http://localhost:5173'
  if (!db || !URL.canParse(db) || !['postgres:', 'postgresql:'].includes(new URL(db).protocol) || !URL.canParse(value)) {
    throw new Error('Invalid Rica management configuration')
  }
  const url = new URL(value)
  if (value !== url.origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new Error('Rica admin origin must be HTTPS or HTTP on localhost')
  }
  const secure = url.protocol === 'https:'
  return { databaseUrl: db, origin: url.origin, rpID: url.hostname, secure, cookie: secure ? '__Host-rica_session' : 'rica_session' }
}

export type ManagementConfig = NonNullable<ReturnType<typeof loadManagementConfig>>

export function actorId(issuer: string, subject: string) {
  return createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex')
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key))
  })
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  return salt.toString('hex') + ':' + (await derive(passwordInput.parse(password), salt)).toString('hex')
}

export async function verifyPassword(password: string, hash?: string) {
  const [salt, key] = (hash ?? dummyHash).split(':')
  const derived = await derive(password, Buffer.from(salt, 'hex'))
  return timingSafeEqual(derived, Buffer.from(key, 'hex')) && hash !== undefined
}

export function sessionKey(token: string) {
  return 'rica:admin:session:' + createHash('sha256').update(token).digest('hex')
}

const sessionValue = z.object({ userId: z.uuid(), version: z.number().int() })

export function createAdminSessions(db: PrismaClient, redis: Redis) {
  return {
    async create(user: { id: string; authVersion: number }) {
      const token = randomBytes(32).toString('base64url')
      await redis.set(sessionKey(token), JSON.stringify({ userId: user.id, version: user.authVersion }), 'EX', sessionSeconds)
      return token
    },
    async read(token?: string) {
      if (!token || !sessionToken.test(token)) return null
      const value = await redis.get(sessionKey(token))
      if (!value) return null
      const session = sessionValue.parse(JSON.parse(value))
      return db.adminUser.findFirst({ where: { id: session.userId, authVersion: session.version } })
    },
    async revoke(token?: string) {
      if (token && sessionToken.test(token)) await redis.del(sessionKey(token))
    },
  }
}

export function localPrincipal(user: { username: string; actorId: string; canCreate: boolean }): Principal {
  return { issuer: localIssuer, subject: user.username, id: user.actorId, canCreate: user.canCreate }
}

export async function allowAuthAttempt(redis: Redis, category: 'password' | 'passkey', userId?: string) {
  const key = 'rica:admin:attempt:' + category
  const script = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n"
  const global = Number(await redis.eval(script, 1, key))
  if (global > (category === 'password' ? 24 : 120)) return false
  return !userId || Number(await redis.eval(script, 1, key + ':' + userId)) <= 8
}
