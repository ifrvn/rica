import { PlatformReadError, type PlatformReadFailure } from './platform-reader.js'

export type PlatformReplyExecutor = Readonly<{
  endpoint: string
  verify(): Promise<{ id: string }>
  readTarget(postId: string): Promise<{ isLocked: boolean }>
  sendReply(postId: string, idempotencyKey: string, content: string): Promise<string>
}>

export class PlatformReplyError extends PlatformReadError<PlatformReadFailure | 'POST_LOCKED'> {}
