import 'dotenv/config'
import { z } from '@hono/zod-openapi'
import { createDatabase } from '../../packages/persistence/client.js'
import { pollNewbiEvents, runNewbiEventPoller } from '../../packages/persistence/newbi-events.js'
import { executeNewbiReply } from '../../packages/persistence/newbi-execution.js'
import { PlatformReplyError } from '../../packages/contracts/platform-reply-executor.js'
import { PluginHostError } from '../../packages/runtime/plugin-registry.js'
import { startNewbiReader } from './newbi-read-plugin.js'
import { startNewbiExecutor } from './newbi-execution-plugin.js'

async function openReader(signal?: AbortSignal) {
  const host = await startNewbiReader(process.env, signal)
  const { id, version, contractVersion } = host.plugin
  console.error(JSON.stringify({ service: 'newbi-pilot', event: 'plugin_status', kind: 'platform-reader',
    id, version, contractVersion, code: 'READY' }))
  return host
}

async function readEvents(accountId: string, args: string[]) {
  const [option, seconds, ...extra] = args
  if (args.length && (option !== '--for-seconds' || !seconds || !/^[1-9][0-9]{0,3}$/u.test(seconds)
    || Number(seconds) > 3600 || extra.length)) throw new Error('Invalid event polling window')
  const url = process.env.RICA_NEWBI_POLL_DATABASE_URL
  if (!url || !URL.canParse(url) || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
    throw new Error('Invalid poller database URL')
  }
  const controller = new AbortController()
  const stop = seconds ? AbortSignal.any([controller.signal, AbortSignal.timeout(Number(seconds) * 1000)]) : controller.signal
  const host = await openReader(stop)
  const reader = host.plugin.implementation
  const db = createDatabase(url)
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    if (seconds) {
      await runNewbiEventPoller(db, reader, accountId, (result) => {
        console.info(JSON.stringify(result))
        if (result.status === 'STOPPED' && !stop.aborted) process.exitCode = 1
      }, stop)
    } else {
      const result = await pollNewbiEvents(db, reader, accountId, stop)
      console.info(JSON.stringify(result))
      if (result.status === 'STOPPED') process.exitCode = 1
    }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await Promise.all([host.stop(), db.$disconnect()])
  }
}

async function main() {
  const [command, value, ...args] = process.argv.slice(2)
  const id = z.uuid().parse(value)
  if (command === 'events') return readEvents(id, args)
  const [retry, ...extra] = args
  if (extra.length || (command === 'inspect' && retry)
    || (command === 'send' && retry && retry !== '--retry') || (command !== 'inspect' && command !== 'send')) {
    throw new Error('Invalid arguments')
  }
  if (command === 'inspect') {
    const host = await openReader()
    try {
      const reader = host.plugin.implementation
      const identity = await reader.verify()
      console.info(JSON.stringify({ identity, ...await reader.readThread(id) }, null, 2))
    } finally {
      await host.stop()
    }
    return
  }
  const url = process.env.RICA_NEWBI_EXECUTION_DATABASE_URL
  if (!url || !URL.canParse(url) || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
    throw new Error('Invalid executor database URL')
  }
  const host = await startNewbiExecutor()
  const { id: pluginId, version, contractVersion, implementation } = host.plugin
  console.error(JSON.stringify({ service: 'newbi-pilot', event: 'plugin_status', kind: 'platform-reply-executor',
    id: pluginId, version, contractVersion, code: 'READY' }))
  const db = createDatabase(url)
  try {
    const result = await executeNewbiReply(db, implementation, id, retry === '--retry')
    console.info(JSON.stringify(result))
    if (result.status !== 'SENT') process.exitCode = 1
  } finally {
    await Promise.all([host.stop(), db.$disconnect()])
  }
}

try {
  await main()
} catch (error) {
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
}
