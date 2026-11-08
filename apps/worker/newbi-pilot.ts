import 'dotenv/config'
import { z } from '@hono/zod-openapi'
import { createDatabase } from '../../packages/persistence/client.js'
import { pollNewbiEvents, runNewbiEventPoller } from '../../packages/persistence/newbi-events.js'
import { executeNewbiReply } from '../../packages/persistence/newbi-execution.js'
import { createNewbiClient, NewbiRequestError } from '../../packages/runtime/newbi-client.js'

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
  const client = createNewbiClient(process.env.RICA_NEWBI_LOCAL_API_URL ?? '', process.env.NEWBI_AGENT_KEY ?? '', stop)
  const db = createDatabase(url)
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    if (seconds) {
      await runNewbiEventPoller(db, client, accountId, (result) => {
        console.info(JSON.stringify(result))
        if (result.status === 'STOPPED' && !stop.aborted) process.exitCode = 1
      }, stop)
    } else {
      const result = await pollNewbiEvents(db, client, accountId, stop)
      console.info(JSON.stringify(result))
      if (result.status === 'STOPPED') process.exitCode = 1
    }
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
  const [retry, ...extra] = args
  if (extra.length || (command === 'inspect' && retry)
    || (command === 'send' && retry && retry !== '--retry') || (command !== 'inspect' && command !== 'send')) {
    throw new Error('Invalid arguments')
  }
  const client = createNewbiClient(process.env.RICA_NEWBI_LOCAL_API_URL ?? '', process.env.NEWBI_AGENT_KEY ?? '')
  if (command === 'inspect') {
    const identity = await client.verify(false)
    console.info(JSON.stringify({ identity, ...await client.readThread(id) }, null, 2))
    return
  }
  const url = process.env.RICA_NEWBI_EXECUTION_DATABASE_URL
  if (!url || !URL.canParse(url) || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
    throw new Error('Invalid executor database URL')
  }
  const db = createDatabase(url)
  try {
    const result = await executeNewbiReply(db, client, id, retry === '--retry')
    console.info(JSON.stringify(result))
    if (result.status !== 'SENT') process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof NewbiRequestError) {
    console.error(JSON.stringify({ reason: error.reason, retryAfterSeconds: error.retrySeconds || undefined }))
  } else {
    console.error(process.argv[2] === 'events'
      ? 'Newbi event polling stopped. Check the account and poller configuration before retrying.'
      : 'Newbi pilot could not confirm the operation. Inspect the reply status before retrying.')
  }
  process.exitCode = 1
}
