import { createHash } from 'node:crypto'
import { z } from '@hono/zod-openapi'

const nonControlText = z.string().min(1).max(512).regex(/^[^\p{Cc}]+$/u)
const httpsUrl = z.url().max(256).refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash
})

const settings = z.strictObject({
  databaseUrl: z.url().refine((url) => URL.canParse(url) && ['postgres:', 'postgresql:'].includes(new URL(url).protocol)),
  endpoint: httpsUrl,
  issuer: httpsUrl,
  audience: nonControlText,
  clientId: nonControlText,
  clientSecret: z.string().min(1).max(4096),
  creatorSubjects: z.array(nonControlText).max(100),
})

type IntrospectionSettings = Pick<z.infer<typeof settings>, 'endpoint' | 'issuer' | 'audience' | 'clientId' | 'clientSecret'>
export type Principal = Readonly<{ issuer: string; subject: string; id: string }>
export type Authenticate = (authorization: string | undefined) => Promise<Principal | null>

export class AuthenticationUnavailable extends Error {}

export function loadManagementConfig(env = process.env) {
  const variables = {
    databaseUrl: env.RICA_MANAGEMENT_DATABASE_URL,
    endpoint: env.RICA_IDP_INTROSPECTION_URL,
    issuer: env.RICA_IDP_ISSUER,
    audience: env.RICA_IDP_AUDIENCE,
    clientId: env.RICA_IDP_CLIENT_ID,
    clientSecret: env.RICA_IDP_CLIENT_SECRET,
  }
  if (Object.values(variables).every((value) => value === undefined)
    && env.RICA_ADMIN_CREATOR_SUBJECTS === undefined) return null

  const creatorSubjects = env.RICA_ADMIN_CREATOR_SUBJECTS === undefined ? []
    : env.RICA_ADMIN_CREATOR_SUBJECTS.split(',').map((value) => value.trim())
  const parsed = settings.safeParse({ ...variables, creatorSubjects })
  if (!parsed.success) throw new Error('Invalid or incomplete Rica management configuration')
  return parsed.data
}

const tokenClaims = z.object({
  active: z.literal(true),
  iss: nonControlText.max(256),
  sub: nonControlText,
  aud: z.union([nonControlText, z.array(nonControlText)]),
  exp: z.number().int().positive(),
  nbf: z.number().int().nonnegative().optional(),
})

function formEncode(value: string) {
  return new URLSearchParams([['v', value]]).toString().slice(2)
}

export function introspectionAuthenticator(config: IntrospectionSettings, fetcher = fetch): Authenticate {
  const basic = Buffer.from(formEncode(config.clientId) + ':' + formEncode(config.clientSecret)).toString('base64')

  return async (authorization) => {
    const token = /^Bearer ([a-z0-9._~+/=-]+)$/i.exec(authorization ?? '')?.[1]
    if (!token || token.length > 4096) return null

    let claims: unknown
    try {
      const response = await fetcher(config.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: { Authorization: 'Basic ' + basic, Accept: 'application/json' },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
      })
      if (!response.ok) throw new Error('Introspection failed')
      claims = await response.json()
    } catch {
      throw new AuthenticationUnavailable()
    }

    const parsed = tokenClaims.safeParse(claims)
    if (!parsed.success) return null
    const { iss, sub, aud, exp, nbf } = parsed.data
    const audiences = typeof aud === 'string' ? [aud] : aud
    const now = Math.floor(Date.now() / 1000)
    if (iss !== config.issuer || !audiences.includes(config.audience) || exp <= now || (nbf ?? 0) > now) return null

    return { issuer: iss, subject: sub, id: createHash('sha256').update(JSON.stringify([iss, sub])).digest('hex') }
  }
}
