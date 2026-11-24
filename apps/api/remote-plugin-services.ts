import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from '@hono/zod-openapi'
import { pluginAccountId, remotePluginId } from '@ricajs/contracts/plugin-events'

const token = /^[A-Za-z0-9_-]{43}$/
const manifest = z.strictObject({
  version: z.literal(1),
  plugins: z.array(z.strictObject({
    id: remotePluginId,
    tokenEnv: z.string().regex(/^RICA_REMOTE_PLUGIN_[A-Z0-9_]+$/),
    accounts: z.array(pluginAccountId).min(1),
    publishActivity: z.boolean().default(false),
    subscribeTo: z.array(remotePluginId).default([]),
  }).refine(service => service.publishActivity || service.subscribeTo.length > 0)),
})

export type RemotePluginService = Readonly<{
  accounts: ReadonlySet<string>
  publishActivity: boolean
  subscribeTo: readonly string[]
}>
export type RemotePluginServices = Readonly<{
  authenticate(id: string, authorization: string | undefined): RemotePluginService | undefined
}>

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

export async function loadRemotePluginServices(path: string, env = process.env): Promise<RemotePluginServices> {
  const result = manifest.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!result.success) throw new Error('Invalid Rica remote plugin manifest')
  const services = new Map<string, RemotePluginService & { tokenHash: Buffer }>()
  const hashes = new Set<string>()
  for (const { id, tokenEnv, accounts, publishActivity, subscribeTo } of result.data.plugins) {
    const value = env[tokenEnv]
    if (!value || !token.test(value)) throw new Error('Invalid service token setting for remote plugin ' + id)
    const tokenHash = digest(value)
    const hash = tokenHash.toString('hex')
    if (services.has(id) || hashes.has(hash)) throw new Error('Duplicate remote plugin identity or token: ' + id)
    services.set(id, { accounts: new Set(accounts), publishActivity, subscribeTo, tokenHash })
    hashes.add(hash)
  }
  function authenticate(id: string, authorization: string | undefined): RemotePluginService | undefined {
    const service = services.get(id)
    const value = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1]
    if (service && value && timingSafeEqual(service.tokenHash, digest(value))) return service
  }
  return { authenticate }
}
