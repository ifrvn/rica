import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { actorId, hashPassword, localIssuer, passwordInput, usernameInput } from '../apps/api/admin-auth.js'
import { createDatabase } from '@ricajs/persistence/client'

async function readAccount(name?: string) {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.')
  let hideInput = false
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (hideInput) callback()
      else process.stderr.write(chunk, encoding, callback)
    },
  })
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 })
  const cancel = new AbortController()
  terminal.once('SIGINT', () => cancel.abort())
  terminal.once('close', () => cancel.abort())
  const { signal } = cancel
  try {
    const username = usernameInput.safeParse(name ?? await terminal.question('Username: ', { signal }))
    if (!username.success) throw new Error('Invalid username')
    hideInput = true
    process.stderr.write('Password (hidden): ')
    const password = passwordInput.safeParse(await terminal.question('', { signal }))
    if (!password.success) throw new Error('Supply a 12–128 character password')
    return { username: username.data, password: password.data }
  } catch (error) {
    if (signal.aborted) throw new Error('Account command cancelled')
    throw error
  } finally {
    terminal.close()
    if (hideInput) process.stderr.write('\n')
  }
}

async function main() {
  const [command, name, ...flags] = process.argv.slice(2)
  if ((command === 'add' || command === 'reset') && flags.length === 0) {
    const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
    if (!url) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL')
    const { username, password } = await readAccount(name)
    const passwordHash = await hashPassword(password)
    const db = createDatabase(url)
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'rica-admin-user:' + username}, 0))`
        if (command === 'reset') {
          const user = await tx.adminUser.findUnique({ where: { username } })
          if (!user) throw new Error('Local user does not exist')
          await tx.adminPasskey.deleteMany({ where: { userId: user.id } })
          await tx.adminUser.update({ where: { id: user.id }, data: { passwordHash, authVersion: { increment: 1 } } })
          return
        }
        await tx.adminUser.create({ data: { username, passwordHash, actorId: actorId(localIssuer, username), canCreate: true } })
      })
      console.info(JSON.stringify({ username, action: command }))
    } finally {
      await db.$disconnect()
    }
  } else {
    throw new Error('Usage: rica admin-user <add|reset> [username]')
  }
}

await main().catch((error: unknown) => {
  // Database errors can include query inputs. Keep credential material out of CLI output.
  const code = error instanceof Error && error.name === 'Error' ? error.message : 'Account command failed'
  console.error(code)
  process.exitCode = 1
})
