import { z } from 'zod'
import { hostedModelCatalog } from '../../providers/catalog.js'
import { modelSettingsFields } from '../../providers/config.js'

type ProviderOption = Readonly<{ id: string; requiresBaseUrl: boolean }>

export function createModelSettingsContracts(catalog: readonly ProviderOption[]) {
  const options = new Map(catalog.map((option) => [option.id, option]))
  const provider = z.enum([...options.keys()])
  const modelSettingsInput = z.strictObject({ provider, ...modelSettingsFields }).refine((value) => {
    return value.model !== undefined && options.get(value.provider)?.requiresBaseUrl === (value.baseUrl !== undefined)
  })
  const profileFields = {
    id: z.uuid().transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u),
  }
  const modelProfileInput = modelSettingsInput.safeExtend({ ...profileFields, id: profileFields.id.optional() })
  const modelProfileChoice = z.object({
    ...profileFields,
    provider,
    model: z.string(),
  })
  const modelProfileView = modelProfileChoice.extend({
    baseUrl: z.string().nullable(),
    hasKey: z.boolean(),
  })
  const modelSettingsView = z.object({
    version: z.number().int().nonnegative(),
    defaultProfileId: profileFields.id.nullable(),
    profiles: z.array(modelProfileView),
  })
  const modelActivationInput = z.strictObject({ id: profileFields.id.nullable() })
  const modelCheckInput = z.strictObject({ id: profileFields.id, version: z.number().int().nonnegative() })
  const modelCheckStatus = z.object({
    id: profileFields.id,
    provider,
    checkedAt: z.iso.datetime(),
    status: z.enum(['OK', 'AUTH_FAILED', 'RATE_LIMITED', 'MODEL_UNAVAILABLE', 'CONNECTION_FAILED', 'INVALID_OUTPUT', 'PROVIDER_ERROR']),
  })
  const modelCheckResult = modelCheckStatus.extend({ reply: z.string().max(500).nullable() })
  return { modelSettingsInput, modelProfileInput, modelProfileChoice, modelSettingsView, modelActivationInput, modelCheckInput,
    modelCheckStatus, modelCheckResult }
}

export const modelSettingsContracts = createModelSettingsContracts(hostedModelCatalog)

export type ModelSettingsContracts = ReturnType<typeof createModelSettingsContracts>
export type HostedModelSettingsInput = z.infer<ModelSettingsContracts['modelSettingsInput']>
export type ModelSettingsInput = HostedModelSettingsInput | { provider: 'simulated'; model?: never; apiKey?: never; baseUrl?: never }
export type ModelProfileInput = z.infer<ModelSettingsContracts['modelProfileInput']>
export type ModelProfileChoice = z.infer<ModelSettingsContracts['modelProfileChoice']>
export type ModelSettingsView = z.infer<ModelSettingsContracts['modelSettingsView']>
export type ModelCheckStatus = z.infer<ModelSettingsContracts['modelCheckStatus']>
export type ModelCheckResult = z.infer<ModelSettingsContracts['modelCheckResult']>
