import { z } from 'zod'
import type { ModelAttribution } from '@ricajs/contracts/model-provider'
import type { HostedModel } from './catalog.js'

export type UsagePurpose = 'DRAFT' | 'REVIEW' | 'CHECK'
export type UsageOutcome = 'OK' | 'HTTP_ERROR' | 'RATE_LIMITED' | 'TIMED_OUT' | 'CONNECTION_FAILED' | 'INVALID_OUTPUT'
export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number }
export type HostedUsageRecord = {
  day: string; provider: HostedModel['id']; model: string; purpose: UsagePurpose; outcome: UsageOutcome
  attribution?: ModelAttribution; sentBytes: number; receivedBytes: number; elapsedMs: number; tokens?: TokenUsage
}
export type RecordHostedUsage = (record: HostedUsageRecord) => Promise<void>

const count = z.number().int().nonnegative().max(1_000_000_000)
const chatUsage = z.object({ usage: z.object({
  prompt_tokens: count, completion_tokens: count, total_tokens: count.optional(),
}) })
const claudeUsage = z.object({ usage: z.object({
  input_tokens: count, output_tokens: count, cache_creation_input_tokens: count.nullish(), cache_read_input_tokens: count.nullish(),
}) })
const geminiUsage = z.object({ usageMetadata: z.object({
  promptTokenCount: count, candidatesTokenCount: count.optional(), totalTokenCount: count,
  thoughtsTokenCount: count.optional(), toolUsePromptTokenCount: count.optional(),
}) })

export function readTokenUsage(provider: HostedModel['id'], response: unknown): TokenUsage | undefined {
  if (provider === 'anthropic') {
    const parsed = claudeUsage.safeParse(response)
    if (!parsed.success) return
    const usage = parsed.data.usage
    const inputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    return { inputTokens, outputTokens: usage.output_tokens, totalTokens: inputTokens + usage.output_tokens }
  }
  if (provider === 'gemini') {
    const parsed = geminiUsage.safeParse(response)
    if (!parsed.success) return
    const usage = parsed.data.usageMetadata
    return {
      inputTokens: usage.promptTokenCount + (usage.toolUsePromptTokenCount ?? 0),
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      totalTokens: usage.totalTokenCount,
    }
  }
  const parsed = chatUsage.safeParse(response)
  if (!parsed.success) return
  const usage = parsed.data.usage
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens }
}
