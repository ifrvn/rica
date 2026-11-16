import { hostedModelCatalog } from '@rica/plugin-hosted-models/catalog'
import { createModelSettingsContracts } from '@rica/plugin-hosted-models/contracts'

export const modelPluginCatalog = [...hostedModelCatalog] as const
export const modelSettingsContracts = createModelSettingsContracts(modelPluginCatalog)
