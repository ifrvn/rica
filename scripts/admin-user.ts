import 'dotenv/config'
import { actorId, hashPassword, localIssuer, passwordInput, usernameInput } from '../apps/api/admin-auth.js'
import { createDatabase } from '../packages/persistence/client.js'

async function main() {
  const [command, name, ...flags] = process.argv.slice(2)
  const username = usernameInput.parse(name)
  const creator = flags[0] === '--creator'
  if ((command === 'add' && (flags.length === 0 || (creator && flags.length === 1)))
    || (command === 'reset' && flags.length === 0)) {
    const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
    if (!url) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL')
    let input = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      input += chunk
      if (input.length > 256) throw new Error('Password input too long')
    }
    const parsed = passwordInput.safeParse(input.replace(/\r?\n$/u, ''))
    if (!parsed.success) throw new Error('Supply a 12–128 character password on stdin')
    const passwordHash = await hashPassword(parsed.data)
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
        await tx.adminUser.create({ data: { username, passwordHash, actorId: actorId(localIssuer, username), canCreate: creator } })
      })
      console.info(JSON.stringify({ username, action: command }))
    } finally {
      await db.$disconnect()
    }
  } else {
    throw new Error('Usage: admin:user add <username> [--creator] or admin:user reset <username>')
  }
}

await main().catch((error: unknown) => {
  // Database errors can include query inputs. Keep credential material out of CLI output.
  const code = error instanceof Error && error.name === 'Error' ? error.message : 'Account command failed'
  console.error(code)
  process.exitCode = 1
})
