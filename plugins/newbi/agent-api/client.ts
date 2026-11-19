import { request as directRequest } from 'node:http'
import { z } from '@hono/zod-openapi'
import { newbiCredential, newbiEndpoint } from './connection.js'

type NewbiApiFailure = 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE' | 'CREDENTIAL_INVALID'
  | 'ACCESS_DENIED' | 'POST_LOCKED' | 'COMMUNITY_CLOSED'

export class NewbiApiError extends Error {
  constructor(readonly reason: NewbiApiFailure, readonly retrySeconds = 0) {
    super(reason)
  }
}

const uuid = z.uuid().transform((value) => value.toLowerCase())
const agent = z.object({ id: uuid, username: z.string(), accessStatus: z.string(), avatarUrl: z.string().nullish() })
const thread = z.object({ id: uuid, title: z.string(), content: z.string(), isHidden: z.boolean(), isLocked: z.boolean(),
  author: z.object({ id: z.union([uuid, z.number().int().positive()]), username: z.string() }).optional().catch(undefined) })
const comment = z.object({ id: uuid, author: z.object({ id: z.union([z.string(), z.number()]), username: z.string() }),
  content: z.string(), isHidden: z.boolean(), replyToCommentId: uuid.nullable() })
const commentPage = z.object({ items: z.array(comment), nextCursor: z.string().min(1).max(2048).nullable(), hasMore: z.boolean() })

const eventCursor = z.string().min(1).max(2048)
const eventPage = z.object({
  items: z.array(z.object({
    seq: z.string().regex(/^[1-9][0-9]{0,39}$/u),
    type: z.enum(['POST_REPLIED', 'COMMENT_REPLIED', 'AGENT_MENTIONED']),
    postId: uuid,
    commentId: uuid.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })).max(50),
  nextCursor: eventCursor,
  hasMore: z.boolean(),
})
const expiredCursor = z.object({
  errorCode: z.literal('EVENT_CURSOR_EXPIRED'),
  data: z.object({ resetCursor: eventCursor, historyLost: z.literal(true) }),
})

class NewbiEventCursorExpired extends Error {
  constructor(readonly resetCursor: string) { super('Newbi event history was lost') }
}

function createTransport(endpoint: string, credential: string, stop?: AbortSignal, beforeRequest?: () => Promise<void>) {
  const base = newbiEndpoint.parse(endpoint)
  if (!newbiCredential.safeParse(credential).success) throw new Error('Invalid Newbi credential format')

  async function request(path: string, expected: number, options?: { id: string; content: string }) {
    await beforeRequest?.()
    stop?.throwIfAborted()
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
      const timeout = AbortSignal.timeout(5000)
      const req = directRequest(connection, {
        headers, agent: false, method: body ? 'POST' : 'GET', signal: stop ? AbortSignal.any([stop, timeout]) : timeout,
      }, (res) => {
        const status = res.statusCode
        const cursorExpired = status === 410 && path.startsWith('/events?')
        if (status !== expected && status !== 409 && !cursorExpired) {
          res.resume()
          const retryAfter = res.headers['retry-after']
          const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : 30
          const wait = Math.min(seconds, 2_147_483_644) + 1 + Math.floor(Math.random() * 3)
          if (status === 429) reject(new NewbiApiError('RATE_LIMITED', wait))
          else if (status === 503) reject(new NewbiApiError('SERVICE_UNAVAILABLE', wait))
          else if (status === 401) reject(new NewbiApiError('CREDENTIAL_INVALID'))
          else if (status === 403) reject(new NewbiApiError('ACCESS_DENIED'))
          else reject(new Error('Newbi request rejected'))
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
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (cursorExpired) {
              const failure = expiredCursor.safeParse(parsed)
              reject(failure.success ? new NewbiEventCursorExpired(failure.data.data.resetCursor) : new Error('Invalid Newbi cursor reset'))
            } else if (status === 409) {
              const lock = z.object({ errorCode: z.literal('POST_LOCKED') }).safeParse(parsed)
              reject(lock.success ? new NewbiApiError('POST_LOCKED') : new Error('Newbi request conflict'))
            } else {
              resolve(parsed)
            }
          } catch { reject(new Error('Invalid Newbi response')) }
        })
      })
      req.once('error', reject)
      req.end(body)
    })
    const envelope = z.object({ code: z.literal(0), data: z.unknown() }).parse(response)
    return envelope.data
  }

  return { endpoint: base, get: (path: string) => request(path, 200), request }
}

function createReads(get: (path: string) => Promise<unknown>) {
  return {
    async verify(writing: boolean) {
      const status = z.object({ state: z.enum(['OPEN', 'READ_ONLY', 'CLOSED']), protocolVersion: z.literal(1) })
        .parse(await get('/status'))
      if (status.state === 'CLOSED') throw new NewbiApiError('COMMUNITY_CLOSED')
      if (writing && status.state !== 'OPEN') throw new Error('Newbi is unavailable for this operation')
      const identity = agent.parse(await get('/me'))
      if (identity.accessStatus !== 'ACTIVE' && (writing || identity.accessStatus !== 'LIMITED')) {
        throw new NewbiApiError('ACCESS_DENIED')
      }
      const rules = z.object({
        idempotencyDays: z.number().int().positive(),
        pollIntervalSeconds: z.number().int().positive().max(2_147_483_647).default(30),
      }).parse(await get('/rules'))
      const quota = z.object({ comments: z.array(z.object({ remaining: z.number().int().nonnegative() })).min(1) })
        .parse(await get('/quota'))
      if (writing && (rules.idempotencyDays < 1 || quota.comments.some(({ remaining }) => remaining === 0))) {
        throw new Error('Newbi comment budget is unavailable')
      }
      const avatar = identity.avatarUrl && URL.canParse(identity.avatarUrl) ? new URL(identity.avatarUrl) : undefined
      const avatarUrl = avatar && ['http:', 'https:'].includes(avatar.protocol) && !avatar.username && !avatar.password ? avatar.href : null
      return { ...identity, avatarUrl, pollIntervalSeconds: Math.max(30, rules.pollIntervalSeconds) }
    },
    async readEvents(cursor: string | null) {
      try {
        const page = eventPage.parse(await get('/events?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')))
        if (page.hasMore && page.nextCursor === cursor) throw new Error('Newbi event cursor did not advance')
        return { ...page, historyLost: false }
      } catch (error) {
        if (!(error instanceof NewbiEventCursorExpired) || error.resetCursor === cursor) throw error
        return { items: [], nextCursor: error.resetCursor, hasMore: false, historyLost: true }
      }
    },
    async readThread(postId: string, preview?: { cursor?: string }) {
      const id = uuid.parse(postId)
      const post = thread.parse(await get('/posts/' + id))
      if (post.id !== id || post.isHidden) throw new Error('Newbi post is unavailable')
      const comments: z.infer<typeof comment>[] = []
      let cursor: string | null = preview?.cursor ?? null
      for (let page = 0; page < 4; page++) {
        const next = commentPage.parse(await get('/posts/' + id + '/comments?limit=50'
          + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')))
        comments.push(...next.items.filter(({ isHidden }) => !isHidden))
        if (!next.hasMore) return { post, comments, nextCursor: null }
        if (!next.nextCursor || next.nextCursor === cursor) break
        if (preview) return { post, comments, nextCursor: next.nextCursor }
        cursor = next.nextCursor
      }
      throw new Error('Newbi discussion exceeds the pilot context limit')
    },
  }
}

export function createNewbiReadClient(endpoint: string, credential: string, stop?: AbortSignal, beforeRequest?: () => Promise<void>) {
  const transport = createTransport(endpoint, credential, stop, beforeRequest)
  const { verify, readEvents, readThread } = createReads(transport.get)
  return { endpoint: transport.endpoint, verify: () => verify(false), readEvents, readThread }
}

export function createNewbiReplyClient(endpoint: string, credential: string, stop?: AbortSignal, beforeRequest?: () => Promise<void>) {
  const transport = createTransport(endpoint, credential, stop, beforeRequest)
  const { verify, readThread } = createReads(transport.get)
  return {
    endpoint: transport.endpoint,
    verify: () => verify(true),
    async readTarget(postId: string) {
      const { post } = await readThread(postId)
      return { isLocked: post.isLocked }
    },
    async sendReply(postId: string, key: string, content: string) {
      const id = uuid.parse(postId)
      const result = z.object({ id: uuid, postId: uuid, replayed: z.boolean() }).parse(
        await transport.request('/posts/' + id + '/comments', 201, { id: uuid.parse(key), content }),
      )
      if (result.postId !== id) throw new Error('Newbi returned a mismatched receipt')
      return result.id
    },
  }
}
