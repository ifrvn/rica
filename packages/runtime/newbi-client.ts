import { request as directRequest } from 'node:http'
import { z } from '@hono/zod-openapi'
import { newbiEndpoint } from '../contracts/newbi-pilot.js'

const uuid = z.uuid().transform((value) => value.toLowerCase())
const agent = z.object({ id: uuid, username: z.string(), accessStatus: z.string() })
const thread = z.object({ id: uuid, title: z.string(), content: z.string(), isHidden: z.boolean(), isLocked: z.boolean() })
const comment = z.object({ id: uuid, author: z.object({ id: z.union([z.string(), z.number()]), username: z.string() }),
  content: z.string(), isHidden: z.boolean(), replyToCommentId: uuid.nullable() })
const commentPage = z.object({ items: z.array(comment), nextCursor: z.string().nullable(), hasMore: z.boolean() })

export function createNewbiClient(endpoint: string, credential: string) {
  const base = newbiEndpoint.parse(endpoint)
  if (!/^nbi_agent_[A-Za-z0-9_-]{43}$/u.test(credential)) throw new Error('Invalid Newbi credential format')

  async function request(path: string, expected: number, options?: { id: string; content: string }) {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (path !== '/status') headers.Authorization = 'Bearer ' + credential
    if (options) {
      headers['Idempotency-Key'] = options.id
      headers['Content-Type'] = 'application/json'
    }
    const body = options ? JSON.stringify({ content: options.content }) : undefined
    if (body) headers['Content-Length'] = String(Buffer.byteLength(body))
    const connection = new URL(base + path)
    if (connection.hostname === 'localhost') {
      headers.Host = connection.host
      connection.hostname = '127.0.0.1'
    }
    const response = await new Promise<unknown>((resolve, reject) => {
      const req = directRequest(connection, {
        headers, agent: false, method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      }, (res) => {
        if (res.statusCode !== expected) {
          res.resume()
          reject(new Error('Newbi request rejected'))
          return
        }
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2 * 1024 * 1024) res.destroy(new Error('Newbi response too large'))
          else chunks.push(chunk)
        })
        res.once('error', reject)
        res.once('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
          catch { reject(new Error('Invalid Newbi response')) }
        })
      })
      req.once('error', reject)
      req.end(body)
    })
    const envelope = z.object({ code: z.literal(0), data: z.unknown() }).parse(response)
    return envelope.data
  }

  return {
    endpoint: base,
    async verify(writing: boolean) {
      const status = z.object({ state: z.enum(['OPEN', 'READ_ONLY', 'CLOSED']), protocolVersion: z.literal(1) })
        .parse(await request('/status', 200))
      if (status.state === 'CLOSED' || (writing && status.state !== 'OPEN')) throw new Error('Newbi is unavailable for this operation')
      const identity = agent.parse(await request('/me', 200))
      if (identity.accessStatus !== 'ACTIVE') throw new Error('Newbi agent is unavailable')
      const rules = z.object({ idempotencyDays: z.number().int().positive() }).parse(await request('/rules', 200))
      const quota = z.object({ comments: z.array(z.object({ remaining: z.number().int().nonnegative() })).min(1) })
        .parse(await request('/quota', 200))
      if (writing && (rules.idempotencyDays < 1 || quota.comments.some(({ remaining }) => remaining === 0))) {
        throw new Error('Newbi comment budget is unavailable')
      }
      return identity
    },
    async readThread(postId: string) {
      const id = uuid.parse(postId)
      const post = thread.parse(await request('/posts/' + id, 200))
      if (post.id !== id || post.isHidden) throw new Error('Newbi post is unavailable')
      const comments: z.infer<typeof comment>[] = []
      let cursor: string | null = null
      for (let page = 0; page < 4; page++) {
        const next = commentPage.parse(await request('/posts/' + id + '/comments?limit=50'
          + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), 200))
        comments.push(...next.items.filter(({ isHidden }) => !isHidden))
        if (!next.hasMore) return { post, comments }
        if (!next.nextCursor || next.nextCursor === cursor) break
        cursor = next.nextCursor
      }
      throw new Error('Newbi discussion exceeds the pilot context limit')
    },
    async comment(postId: string, key: string, content: string) {
      const id = uuid.parse(postId)
      const result = z.object({ id: uuid, postId: uuid, replayed: z.boolean() }).parse(
        await request('/posts/' + id + '/comments', 201, { id: uuid.parse(key), content }),
      )
      if (result.postId !== id) throw new Error('Newbi returned a mismatched receipt')
      return result.id
    },
  }
}

export type NewbiClient = ReturnType<typeof createNewbiClient>
