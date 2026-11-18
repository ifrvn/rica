import type { PlatformEventReader } from '@ricajs/contracts/platform-reader'
import { PlatformReplyError, type PlatformReplyExecutor } from '@ricajs/contracts/platform-reply-executor'
import { createNewbiReadClient as createAgentReader, createNewbiReplyClient, NewbiApiError } from '../../agent-api/client.js'

async function withPlatformErrors<T>(result: Promise<T>): Promise<T> {
  try {
    return await result
  } catch (error) {
    if (error instanceof NewbiApiError) throw new PlatformReplyError(error.reason, error.retrySeconds)
    throw error
  }
}

export function createNewbiReadClient(endpoint: string, credential: string, stop?: AbortSignal, beforeRequest?: () => Promise<void>) {
  const client = createAgentReader(endpoint, credential, stop, beforeRequest)
  const reader = {
    endpoint: client.endpoint,
    verify: () => withPlatformErrors(client.verify()),
    readEvents: (cursor: string | null) => withPlatformErrors(client.readEvents(cursor)),
    readThread: (postId: string) => withPlatformErrors(client.readThread(postId)),
  }
  return reader satisfies PlatformEventReader
}

export function createNewbiReplyExecutor(endpoint: string, credential: string, stop?: AbortSignal,
  beforeRequest?: () => Promise<void>): PlatformReplyExecutor {
  const client = createNewbiReplyClient(endpoint, credential, stop, beforeRequest)
  return {
    endpoint: client.endpoint,
    verify: () => withPlatformErrors(client.verify()),
    readTarget: (postId) => withPlatformErrors(client.readTarget(postId)),
    sendReply: (postId, key, content) => withPlatformErrors(client.sendReply(postId, key, content)),
  }
}
