import 'dotenv/config'
import { z } from '@hono/zod-openapi'
import { createDatabase, type RawQueryClient } from '../../packages/persistence/client.js'
import { pollNewbiEvents, runNewbiEventPoller } from '../../packages/persistence/newbi-events.js'
import { executeNewbiReply } from '../../packages/persistence/newbi-execution.js'
import { newbiExecutorIdentity, newbiExecutorKey } from '../../packages/contracts/newbi-executor-identity.js'
import { newbiReaderIdentity } from '../../packages/contracts/newbi-pilot.js'
import { PlatformReplyError } from '../../packages/contracts/platform-reply-executor.js'
import { observationError, reportPluginResult } from '../plugin-observation.js'
import type { PluginDiagnostic } from '../../packages/contracts/plugin-status.js'
import { PluginHostError } from '../../packages/runtime/plugin-registry.js'
import { createDeploymentPluginStore } from '../../packages/runtime/deployment-plugins.js'
import { modelSettingsDirectory } from '../../packages/runtime/model-settings-store.js'
import { runtimeDatabaseUrl } from '../../packages/runtime/config.js'
import { openSavedNewbiExecutor, openSavedNewbiReader, scopedNewbiDatabase } from './newbi-database.js'

function connectorStore() {
  return createDeploymentPluginStore(modelSettingsDirectory(runtimeDatabaseUrl()))
}

async function openReader(db: RawQueryClient, accountId: string, signal?: AbortSignal) {
  const host = await openSavedNewbiReader(db, connectorStore(), accountId, signal)
  if (!host) throw new PluginHostError({ kind: 'platform-reader', id: newbiReaderIdentity.id,
    version: newbiReaderIdentity.version, code: 'INVALID_CONFIG' })
  const { id, version, contractVersion } = host.plugin
  console.error(JSON.stringify({ service: 'newbi-pilot', event: 'plugin_status', kind: 'platform-reader',
    id, version, contractVersion, code: 'READY' }))
  return host
}

async function readEvents(accountId: string, args: string[]) {
  const [option, seconds, ...extra] = args
  if (args.length && (option !== '--for-seconds' || !seconds || !/^[1-9][0-9]{0,3}$/u.test(seconds)
    || Number(seconds) > 3600 || extra.length)) throw new Error('Invalid event polling window')
  const url = runtimeDatabaseUrl()
  const controller = new AbortController()
  const stop = seconds ? AbortSignal.any([controller.signal, AbortSignal.timeout(Number(seconds) * 1000)]) : controller.signal
  const db = createDatabase(url)
  const readerDb = scopedNewbiDatabase(db, 'reader')
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const host = await openReader(readerDb, accountId, stop)
    try {
      const reader = host.plugin.implementation
      if (seconds) {
        await runNewbiEventPoller(readerDb, reader, accountId, (result) => {
          console.info(JSON.stringify(result))
          if (result.status === 'STOPPED' && !stop.aborted) process.exitCode = 1
        }, stop)
      } else {
        const result = await pollNewbiEvents(readerDb, reader, accountId, stop)
        console.info(JSON.stringify(result))
        if (result.status === 'STOPPED') process.exitCode = 1
      }
    } finally { await host.stop() }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await db.$disconnect()
  }
}

async function main() {
  const [command, value, ...args] = process.argv.slice(2)
  const id = z.uuid().parse(value)
  if (command === 'events') return readEvents(id, args)
  const [option, ...extra] = args
  if (extra.length || (command === 'inspect' && !z.uuid().safeParse(option).success)
    || (command === 'send' && option && option !== '--retry') || (command !== 'inspect' && command !== 'send')) {
    throw new Error('Invalid arguments')
  }
  const db = createDatabase(runtimeDatabaseUrl())
  try {
    if (command === 'inspect') {
      const host = await openReader(scopedNewbiDatabase(db, 'reader'), id)
      try {
        const reader = host.plugin.implementation
        const identity = await reader.verify()
        console.info(JSON.stringify({ identity, ...await reader.readThread(option) }, null, 2))
      } finally { await host.stop() }
      return
    }
    const executorDb = scopedNewbiDatabase(db, 'executor')
    const host = await openSavedNewbiExecutor(executorDb, connectorStore(), id)
    if (!host) throw new PluginHostError({ kind: 'platform-reply-executor', id: newbiExecutorIdentity.id,
      version: newbiExecutorIdentity.version, code: 'INVALID_CONFIG' })
    try {
      const { id: pluginId, version, contractVersion, implementation } = host.plugin
      console.error(JSON.stringify({ service: 'newbi-pilot', event: 'plugin_status', kind: 'platform-reply-executor',
        id: pluginId, version, contractVersion, code: 'READY' }))
      const result = await executeNewbiReply(executorDb, implementation, newbiExecutorKey(host.plugin), id, option === '--retry')
      console.info(JSON.stringify(result))
      if (result.status !== 'SENT') process.exitCode = 1
    } finally { await host.stop() }
  } finally { await db.$disconnect() }
}

const command = process.argv[2]
let diagnostic: PluginDiagnostic | undefined
try {
  await main()
} catch (error) {
  diagnostic = observationError(error, 'OPERATION_FAILED')
  if (error instanceof PluginHostError) {
    console.error(JSON.stringify({ service: 'newbi-pilot', event: 'plugin_status', ...error.diagnostic }))
  } else if (error instanceof PlatformReplyError) {
    console.error(JSON.stringify({ reason: error.reason, retryAfterSeconds: error.retrySeconds || undefined }))
  } else {
    console.error(process.argv[2] === 'events'
      ? 'Newbi event polling stopped. Check the account and poller configuration before retrying.'
      : 'Newbi pilot could not confirm the operation. Inspect the reply status before retrying.')
  }
  process.exitCode = 1
} finally {
  if (command === 'events' || command === 'inspect' || command === 'send') {
    await reportPluginResult(process.env.REDIS_URL, command === 'send' ? 'connector-executor' : 'connector-reader',
      diagnostic ?? (process.exitCode ? 'OPERATION_FAILED' : undefined))
  }
}
