export type PlatformEventPage = Readonly<{
  items: readonly Readonly<{
    seq: string
    type: 'POST_REPLIED' | 'COMMENT_REPLIED' | 'AGENT_MENTIONED'
    postId: string
    commentId: string | null
    createdAt: string
  }>[]
  nextCursor: string
  hasMore: boolean
  historyLost: boolean
}>

export type PlatformEventReader = Readonly<{
  endpoint: string
  verify(): Promise<{ id: string; pollIntervalSeconds: number }>
  readEvents(cursor: string | null): Promise<PlatformEventPage>
}>

export type PlatformReadFailure = 'CREDENTIAL_INVALID' | 'ACCESS_DENIED' | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE' | 'COMMUNITY_CLOSED'

export class PlatformReadError<Reason extends string = PlatformReadFailure> extends Error {
  constructor(readonly reason: Reason, readonly retrySeconds = 0) {
    super(reason)
  }
}
