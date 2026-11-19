import { z } from '@hono/zod-openapi'
import type { RunContinuity, RunTime } from './run-continuity.js'
import type { PublicReplyReview } from './auto-review.js'

export class ModelProviderError extends Error {
  constructor(readonly code: 'HTTP_ERROR' | 'REQUEST_FAILED' | 'INVALID_OUTPUT', readonly status?: number) {
    super(code)
  }
}

export type ModelEvidence = Readonly<{ id: string; revision: number; content: string }>

type ModelInput = Readonly<{
  text: string
  evidence: readonly ModelEvidence[]
}>

export type WritingStyle = 'neutral' | 'formal' | 'casual' | 'concise'
export type ModelAttribution = Readonly<{ characterId: string; identityId: string; platform: string }>

export const participationLevel = z.enum(['talkative', 'balanced', 'reserved'])
export type Participation = z.infer<typeof participationLevel>
type ModelConversation = { speaker: string; history: { speaker: string; message: string }[] }
export const replyDecision = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('REPLY'), reason: z.enum(['DIRECT_REQUEST', 'RELEVANT_TOPIC', 'SOCIAL_OPENING']) }),
  z.strictObject({ action: z.literal('NO_OP'), reason: z.enum(['ALREADY_ADDRESSED', 'BYSTANDER', 'UNCLEAR']) }),
])
export type ReplyDecision = z.infer<typeof replyDecision>
export type CaptureSystemPrompt = (prompt: string) => Promise<void>

export type ModelProvider = Readonly<{
  hostedProvider?: string
  hostedModel?: string
  review?(prompt: string, reply: PublicReplyReview, signal: AbortSignal, attribution?: ModelAttribution,
    capture?: CaptureSystemPrompt): Promise<unknown>
  decide(input: ModelInput & Readonly<{ context: RunContinuity; conversation?: ModelConversation; participation?: Participation;
    identityPrompt?: string; capture?: CaptureSystemPrompt }>, signal: AbortSignal): Promise<unknown>
  write(input: ModelInput & Readonly<{ style: WritingStyle; time: RunTime; corePrompt?: string; identityPrompt?: string;
    attribution?: ModelAttribution; conversation?: ModelConversation; capture?: CaptureSystemPrompt }>, signal: AbortSignal): Promise<unknown>
}>
