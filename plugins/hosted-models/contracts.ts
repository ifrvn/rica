import { z } from 'zod'
import type { ModelPluginOption } from '@rica/contracts/model-provider'

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

export function createModelSettingsContracts(catalog: readonly ModelPluginOption[]) {
  const options = new Map(catalog.map((option) => [option.id, option]))
  const provider = z.enum(['simulated', ...options.keys()])
  const modelSettingsInput = z.strictObject({ provider, ...modelSettingsFields }).refine((value) => {
    if (value.provider === 'simulated') return value.model === undefined && value.apiKey === undefined && value.baseUrl === undefined
    return value.model !== undefined && options.get(value.provider)?.requiresBaseUrl === (value.baseUrl !== undefined)
  })
  const modelSettingsView = z.object({
    version: z.number().int().nonnegative(),
    provider,
    model: z.string().nullable(),
    baseUrl: z.string().nullable(),
    hasKey: z.boolean(),
  })
  const modelCheckStatus = z.object({
    provider: provider.exclude(['simulated']),
    checkedAt: z.iso.datetime(),
    status: z.enum(['OK', 'AUTH_FAILED', 'RATE_LIMITED', 'MODEL_UNAVAILABLE', 'CONNECTION_FAILED', 'INVALID_OUTPUT', 'PROVIDER_ERROR']),
  })
  const modelCheckResult = modelCheckStatus.extend({ reply: z.string().max(500).nullable() })
  return { modelSettingsInput, modelSettingsView, modelCheckStatus, modelCheckResult }
}

export const modelCheckInput = z.object({ version: z.number().int().positive() })

export type ModelSettingsContracts = ReturnType<typeof createModelSettingsContracts>
export type ModelSettingsInput = z.infer<ModelSettingsContracts['modelSettingsInput']>
export type ModelSettingsView = z.infer<ModelSettingsContracts['modelSettingsView']>
export type ModelCheckStatus = z.infer<ModelSettingsContracts['modelCheckStatus']>
export type ModelCheckResult = z.infer<ModelSettingsContracts['modelCheckResult']>
