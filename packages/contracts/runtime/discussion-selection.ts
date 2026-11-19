import { z } from '@hono/zod-openapi'
import type { Participation } from './model-provider.js'
import type { GlossaryReference } from './glossary.js'

const note = z.string().trim().min(1).max(200).regex(/^[^\p{Cc}]+$/u)
const reply = z.strictObject({ status: z.literal('SUGGEST_REPLY'), commentId: z.uuid(), note,
  reason: z.enum(['DIRECT_QUESTION', 'SUBSTANTIVE_CORRECTION', 'FOLLOW_UP', 'RELEVANT_DISCUSSION']) })
const skip = z.strictObject({ status: z.literal('NO_REPLY'), note,
  reason: z.enum(['ALREADY_ANSWERED', 'LOW_VALUE', 'OUT_OF_SCOPE', 'INSUFFICIENT_CONTEXT']) })
export const discussionSelection = z.discriminatedUnion('status', [reply, skip])

export type DiscussionSelectionInput = Readonly<{
  title: string; post: string; participation: Participation; identityPreferences?: string
  glossary?: readonly GlossaryReference[]
  learnGlossary?: boolean
  comments: readonly { id: string; replyToCommentId: string | null; speaker: number; text: string; own: boolean; eligible: boolean;
    signal: 'MENTION' | 'REPLY' | null }[]
}>
