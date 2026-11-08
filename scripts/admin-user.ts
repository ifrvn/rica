import 'dotenv/config'
import { actorId, hashPassword, localIssuer, passwordInput, usernameInput } from '../apps/api/admin-auth.js'
import { createDatabase } from '../packages/persistence/client.js'

async function main() {
  const [command, name, ...flags] = process.argv.slice(2)
  const username = usernameInput.parse(name)
  const creator = flags[0] === '--creator'
  const source = flags.slice(creator ? 1 : 0)
  const migrate = source.length === 3 && source[0] === '--from' && source[1] !== localIssuer
    && source[1].length > 0 && source[1].length <= 256 && source[2].length > 0 && source[2].length <= 512
  if ((command === 'add' && (source.length === 0 || migrate)) || (command === 'reset' && flags.length === 0)) {
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
        const principalId = migrate ? actorId(source[1], source[2]) : actorId(localIssuer, username)
        await tx.adminUser.create({ data: { username, passwordHash, actorId: principalId, canCreate: creator } })
        if (migrate) {
          await tx.$queryRaw`
            SELECT id FROM public.characters WHERE id IN (
              SELECT character_id FROM public.management_memberships WHERE issuer = ${source[1]} AND subject = ${source[2]}
            ) ORDER BY id FOR UPDATE
          `
          const added = await tx.$executeRaw`
            INSERT INTO public.management_memberships(character_id,issuer,subject,role)
            SELECT character_id,${localIssuer},${username},role
            FROM public.management_memberships WHERE issuer = ${source[1]} AND subject = ${source[2]}
            ON CONFLICT DO NOTHING
          `
          const removed = await tx.managementMembership.deleteMany({ where: { issuer: source[1], subject: source[2] } })
          if (!removed.count && !added) throw new Error('Prior account has no character memberships')
        }
      })
      console.info(JSON.stringify({ username, action: command }))
    } finally {
      await db.$disconnect()
    }
  } else {
    throw new Error('Usage: admin:user add <username> [--creator] [--from <issuer> <subject>] or admin:user reset <username>')
  }
}

await main().catch((error: unknown) => {
  // Database errors can include query inputs. Keep credential material out of CLI output.
  const code = error instanceof Error && error.name === 'Error' ? error.message : 'Account command failed'
  console.error(code)
  process.exitCode = 1
})
