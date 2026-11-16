import { createModelSettingsContracts, hostedModelCatalog } from '@rica/plugin-hosted-models/shared'

export const modelPluginCatalog = [...hostedModelCatalog] as const
export const modelSettingsContracts = createModelSettingsContracts(modelPluginCatalog)
