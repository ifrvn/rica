import { Buffer } from 'node:buffer'
import { z } from '@hono/zod-openapi'
import { resourceId, runActivityItem, runActivityKind, type runActivityQuery } from '@ricajs/contracts/management'
import { authorize, ManagementError, type Scope } from '@ricajs/persistence/management'
import type { ManagementPlugin } from '@ricajs/persistence/management-http'
import { Prisma, type PrismaClient } from '@ricajs/persistence/prisma'

const cursorSchema = z.tuple([z.iso.datetime(), resourceId, runActivityKind, z.string()])

function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw new ManagementError(422, 'INVALID_CURSOR', 'Invalid run activity cursor')
  }
}

export async function listRunActivity(db: PrismaClient, scope: Scope, query: z.infer<typeof runActivityQuery>,
  plugins: readonly ManagementPlugin[]) {
  const cursor = decodeCursor(query.cursor)
  const [time, id, kind, platform] = cursor ?? []
  const { characterId } = scope
  const sources = query.kind && query.kind !== 'SIMULATION' ? [] : [
    Prisma.sql`SELECT * FROM public.rica_console_run_activity(${characterId}::uuid, ${time ?? null}::timestamptz,
      ${id ?? null}::uuid, ${query.limit + 2}::integer)`,
  ]
  for (const plugin of plugins) {
    for (const activity of query.kind ? [query.kind] : runActivityKind.options) {
      const source = plugin.runActivity?.[activity]
      if (source) sources.push(source(characterId))
    }
  }
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    if (!sources.length) return { items: [], nextCursor: null }
    const before = cursor ? Prisma.sql`WHERE (created_at, id, kind, platform) <
      (${time}::timestamptz, ${id}::uuid, ${kind}::text, ${platform}::text)` : Prisma.empty
    const rows = runActivityItem.array().parse(await tx.$queryRaw`
      SELECT id, kind, platform, identity, account, account_id AS "accountId", state,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM (${Prisma.join(sources, ' UNION ALL ')}) AS activity
      ${before}
      ORDER BY created_at DESC, id DESC, kind DESC, platform DESC
      LIMIT ${query.limit + 1}
    `)
    const items = rows.slice(0, query.limit)
    const last = items.at(-1)
    const nextCursor = rows.length > query.limit && last
      ? Buffer.from(JSON.stringify([last.createdAt, last.id, last.kind, last.platform])).toString('base64url') : null
    return { items, nextCursor }
  }, { isolationLevel: 'RepeatableRead' })
}
