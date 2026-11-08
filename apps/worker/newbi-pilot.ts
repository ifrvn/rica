import 'dotenv/config'
import { z } from '@hono/zod-openapi'
import { createDatabase } from '../../packages/persistence/client.js'
import { executeNewbiReply } from '../../packages/persistence/newbi-execution.js'
import { createNewbiClient, NewbiRequestError } from '../../packages/runtime/newbi-client.js'

async function main() {
  const [command, value, retry, ...extra] = process.argv.slice(2)
  const id = z.uuid().parse(value)
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
    console.error('Newbi pilot could not confirm the operation. Inspect the reply status before retrying.')
  }
  process.exitCode = 1
}
