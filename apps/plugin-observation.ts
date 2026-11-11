import { Redis } from 'ioredis'
import { newbiReaderIdentity } from '../packages/contracts/newbi-pilot.js'
import { newbiExecutorIdentity } from '../packages/contracts/newbi-executor-identity.js'
import { pluginDiagnostic, pluginReport, pluginServices, type PluginDiagnostic, type PluginMetadata,
  type PluginReport, type PluginService } from '../packages/contracts/plugin-status.js'
import { PluginHostError } from '../packages/runtime/plugin-registry.js'
import { cognitionCatalog, simulationPlatformCatalog } from './runtime-plugins.js'

const catalog: Record<PluginService, PluginMetadata[]> = {
  api: simulationPlatformCatalog,
  worker: cognitionCatalog,
  'simulation-executor': simulationPlatformCatalog,
  'connector-reader': [{ ...newbiReaderIdentity, kind: 'platform-reader' }],
  'connector-executor': [{ ...newbiExecutorIdentity, kind: 'platform-reply-executor' }],
}
const heartbeatSeconds = 20
const recentCommandSeconds = 3600
type Status = Omit<PluginReport, 'observedAt'>

function key(service: PluginService) {
  return 'rica:plugin-status:v1:' + service
}

function connect(url: string) {
  const redis = new Redis(url, {
    lazyConnect: true, enableOfflineQueue: false, commandTimeout: 1000, connectTimeout: 1000, maxRetriesPerRequest: 0,
  })
  redis.on('error', () => {})
  return redis
}

async function publish(redis: Redis, service: PluginService, status: Status, ttl: number) {
  const report = pluginReport.parse({ ...status, observedAt: new Date().toISOString() })
  await redis.set(key(service), JSON.stringify(report), 'EX', ttl)
}

export function observationError(error: unknown, fallback: PluginDiagnostic): PluginDiagnostic {
  const code = error instanceof PluginHostError && pluginDiagnostic.safeParse(error.diagnostic.code)
  return code && code.success ? code.data : fallback
}

export function startPluginHeartbeat(url: string, service: PluginService, plugins: PluginMetadata[]) {
  const redis = connect(url)
  let status: Status = { status: 'READY', plugins }
  async function beat() {
    try {
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect()
      await publish(redis, service, status, heartbeatSeconds)
    } catch { /* Observations are best effort. Redis expiry removes stale reports. */ }
  }
  void beat()
  const timer = setInterval(() => { void beat() }, 5000)
  timer.unref()
  return {
    failed(diagnostic: PluginDiagnostic) { status = { status: 'FAILED', plugins: status.plugins, diagnostic } },
    ready(nextPlugins = plugins) { status = { status: 'READY', plugins: nextPlugins } },
    stop() { clearInterval(timer); redis.disconnect() },
  }
}

export async function reportPluginResult(
  url: string | undefined, service: PluginService, diagnostic?: PluginDiagnostic,
) {
  if (!url || !URL.canParse(url) || !['redis:', 'rediss:'].includes(new URL(url).protocol)) return
  const redis = connect(url)
  try {
    await redis.connect()
    const status: Status = diagnostic ? { status: 'FAILED', plugins: [], diagnostic }
      : { status: 'COMPLETED', plugins: catalog[service] }
    await publish(redis, service, status, service.startsWith('connector-') ? recentCommandSeconds : heartbeatSeconds)
  } catch { /* Diagnostic failures never change the command result. */ }
  finally { redis.disconnect() }
}

export async function readPluginStatus(redis?: Pick<Redis, 'mget'>, newbiRegistrationAvailable = false) {
  const snapshots = await redis?.mget(...pluginServices.map(key)).catch(() => undefined)
  return { newbiRegistrationAvailable, services: pluginServices.map((service, index) => {
    const expected = catalog[service]
    let report: PluginReport | null = null
    try {
      const raw = snapshots?.[index]
      const parsed = raw && pluginReport.safeParse(JSON.parse(raw))
      if (parsed && parsed.success && parsed.data.plugins.every((item) =>
        expected.some(({ id, kind }) => id === item.id && kind === item.kind))) report = parsed.data
    } catch { /* Missing or invalid cache data is unknown. */ }
    return { service, catalog: expected, report }
  }) }
}
