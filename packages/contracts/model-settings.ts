import { z } from '@hono/zod-openapi'

export const modelProviders = ['simulated', 'openai', 'anthropic', 'gemini', 'openai-compatible'] as const
const provider = z.enum(modelProviders)
const model = z.string().trim().min(1).max(160).regex(/^[\w./:-]+$/)
const apiKey = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/)
const baseUrl = z.url({ protocol: /^https$/ }).max(2048).refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash
}).transform((value) => new URL(value).href.replace(/\/+$/, ''))

export const modelSettingsInput = z.strictObject({
  provider,
  model: model.optional(),
  apiKey: apiKey.optional(),
  baseUrl: baseUrl.optional(),
}).refine((value) => value.provider === 'simulated'
  ? value.model === undefined && value.apiKey === undefined && value.baseUrl === undefined
  : value.model !== undefined && (value.provider === 'openai-compatible') === (value.baseUrl !== undefined))

export const modelSettingsView = z.object({
  version: z.number().int().nonnegative(),
  provider,
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  hasKey: z.boolean(),
})

export type ModelSettingsInput = z.infer<typeof modelSettingsInput>
export type ModelSettingsView = z.infer<typeof modelSettingsView>
