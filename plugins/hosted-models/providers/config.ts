import { z } from 'zod'
import type { HostedModel } from './catalog.js'

const providers = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/',
  deepseek: 'https://api.deepseek.com/chat/completions',
  'openai-compatible': undefined,
} as const

const model = z.string().trim().min(1).max(160).regex(/^[\w./:-]+$/)
const apiKey = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/)
const baseUrl = z.url({ protocol: /^https$/ }).max(2048).refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash
}).transform((value) => new URL(value).href.replace(/\/+$/, ''))

export const modelSettingsFields = {
  model: model.optional(),
  apiKey: apiKey.optional(),
  baseUrl: baseUrl.optional(),
}

const configSchema = z.object({
  ...modelSettingsFields,
  model: modelSettingsFields.model.unwrap(),
  apiKey: modelSettingsFields.apiKey.unwrap(),
})

export type HostedModelConfig = { model: string; key: string; url: string }

export function parseHostedModelConfig({ id, requiresBaseUrl }: HostedModel, config: unknown): HostedModelConfig {
  const { model, apiKey: key, baseUrl } = configSchema.parse(config)
  if (requiresBaseUrl !== (baseUrl !== undefined)) throw new Error('Invalid base URL configuration')
  const url = baseUrl === undefined ? providers[id] : baseUrl + '/chat/completions'
  if (!url) throw new Error('Missing model endpoint')
  return { model, key, url }
}
