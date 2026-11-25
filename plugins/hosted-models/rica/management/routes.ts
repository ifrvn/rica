import { logger } from '@ricajs/runtime/logging'
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { resourceId, versionHeader } from '@ricajs/contracts/management'
import type { ModelCheckStatus, ModelSettingsView } from './contracts.js'
import { checkModel } from './check.js'
import { ModelSettingsError, type createModelSettingsStore } from './settings.js'
import { hostedModelsPluginId } from '../identity.js'
import { ManagementError } from '@ricajs/persistence/management'
import { usageQuery, usageView, type UsageQuery } from './usage-contracts.js'
import { body, error, errors, failure, security, success, version, type ManagementEnvironment, type ManagementPlugin, type ManagementPrincipal } from '@ricajs/persistence/management-http'

export function createHostedModelManagement({ modelSettings, authorize, isEnabled, startModelPlugin, readUsage }: {
  modelSettings: ReturnType<typeof createModelSettingsStore>
  authorize(actor: ManagementPrincipal): void
  isEnabled(): Promise<boolean>
  startModelPlugin: Parameters<typeof checkModel>[1]
  readUsage?: (query: UsageQuery) => Promise<z.infer<typeof usageView>>
}): ManagementPlugin {
  const { modelActivationInput, modelCheckInput, modelCheckResult, modelCheckStatus, modelProfileChoice, modelProfileInput, modelSettingsView } =
    modelSettings.contracts
  let checkingModel = false
  const modelChecks = new Map<string, { version: number; result: ModelCheckStatus }>()

  async function update(change: () => Promise<ModelSettingsView>) {
    try {
      return await change()
    } catch (cause) {
      if (!(cause instanceof ModelSettingsError)) throw cause
      if (cause.code === 'VERSION_CONFLICT') throw new ManagementError(412, cause.code, 'Model settings have changed')
      if (cause.code === 'MODEL_NOT_CONFIGURED') throw new ManagementError(409, cause.code, 'Save the provider settings first')
      if (cause.code === 'PROVIDER_CHANGED') throw new ManagementError(422, cause.code, 'Create a profile to use a different provider')
      throw new ManagementError(422, cause.code, 'An API key is required for this provider and endpoint')
    }
  }

  function registerRoutes(app: OpenAPIHono<ManagementEnvironment>) {
    app.openapi(createRoute({
      method: 'get', path: '/model-usage', security,
      request: { query: usageQuery }, responses: { ...errors, 200: success(usageView), 503: failure },
    }), async (c) => {
      authorize(c.get('actor'))
      if (!readUsage) return c.json(error(c.get('requestId'), 'MODEL_USAGE_UNAVAILABLE', 'Usage statistics are unavailable'), 503)
      return c.json(await readUsage(c.req.valid('query')), 200)
    })

    app.openapi(createRoute({
      method: 'get', path: '/model-settings', security,
      responses: { ...errors, 200: success(modelSettingsView) },
    }), async (c) => {
      authorize(c.get('actor'))
      return c.json(await modelSettings.status(), 200)
    })

    app.openapi(createRoute({
      method: 'put', path: '/model-settings', security,
      request: { headers: versionHeader, body: body(modelProfileInput) },
      responses: { ...errors, 200: success(modelSettingsView) },
    }), async (c) => {
      const actor = c.get('actor')
      authorize(actor)
      const input = c.req.valid('json')
      if (!await isEnabled()) {
        throw new ManagementError(409, 'PLUGIN_STATE_CONFLICT', 'Enable the model plugin first')
      }
      const expected = version(c.req.valid('header'))
      const saved = await update(() => modelSettings.save(input, expected))
      logger.info({ service: 'api', event: 'model_settings_updated', actorId: actor.id,
        requestId: c.get('requestId'), version: saved.version, provider: input.provider })
      return c.json(saved, 200)
    })

    app.openapi(createRoute({
      method: 'put', path: '/model-settings/active', security,
      request: { headers: versionHeader, body: body(modelActivationInput) },
      responses: { ...errors, 200: success(modelSettingsView) },
    }), async (c) => {
      const actor = c.get('actor')
      authorize(actor)
      const { id } = c.req.valid('json')
      if (id !== null && !await isEnabled()) {
        throw new ManagementError(409, 'PLUGIN_STATE_CONFLICT', 'Enable the model plugin first')
      }
      const expected = version(c.req.valid('header'))
      const saved = await update(() => modelSettings.activate(id, expected))
      logger.info({ service: 'api', event: 'default_model_profile_changed', actorId: actor.id,
        requestId: c.get('requestId'), version: saved.version, profileId: id })
      return c.json(saved, 200)
    })

    app.openapi(createRoute({
      method: 'delete', path: '/model-settings/{id}', security,
      request: { params: z.object({ id: resourceId }), headers: versionHeader },
      responses: { ...errors, 200: success(modelSettingsView) },
    }), async (c) => {
      const actor = c.get('actor')
      authorize(actor)
      const { id } = c.req.valid('param')
      const expected = version(c.req.valid('header'))
      const saved = await update(() => modelSettings.remove(id, expected))
      modelChecks.delete(id)
      logger.info({ service: 'api', event: 'model_profile_removed', actorId: actor.id,
        requestId: c.get('requestId'), version: saved.version, profileId: id })
      return c.json(saved, 200)
    })

    app.openapi(createRoute({
      method: 'post', path: '/model-settings/check', security,
      request: { body: body(modelCheckInput) },
      responses: { ...errors, 200: success(modelCheckResult) },
    }), async (c) => {
      authorize(c.get('actor'))
      const { id, version: expected } = c.req.valid('json')
      if (checkingModel) throw new ManagementError(409, 'MODEL_CHECK_BUSY', 'A model check is in progress')
      checkingModel = true
      try {
        const settings = await modelSettings.readSettings()
        if (settings.version !== expected) throw new ManagementError(412, 'VERSION_CONFLICT', 'Model settings have changed')
        if (!await isEnabled()) {
          throw new ManagementError(409, 'PLUGIN_STATE_CONFLICT', 'Enable and configure the model plugin first')
        }
        const saved = settings.profiles[id]
        if (!saved) throw new ManagementError(409, 'MODEL_NOT_CONFIGURED', 'Save the provider settings first')
        const result = await checkModel(saved.configuration, startModelPlugin)
        const { reply: _reply, ...status } = result
        if ((await modelSettings.readSettings()).profiles[id]?.version === saved.version) {
          modelChecks.set(id, { version: saved.version, result: { ...status, id } })
        }
        return c.json({ ...result, id }, 200)
      } finally {
        checkingModel = false
      }
    })
  }

  async function readStatus() {
    const current = await modelSettings.readSettings()
    const modelProfiles = Object.entries(current.profiles).map(([id, { name, configuration }]) =>
      ({ id, name, provider: configuration.provider, model: configuration.model }))
    const checks = await isEnabled() ? modelProfiles.flatMap(({ id }) => {
      const recent = modelChecks.get(id)
      return recent && recent.version === current.profiles[id]?.version ? [recent.result] : []
    }) : []
    return { modelProfiles, modelChecks: checks, defaultModelProfileId: current.defaultProfileId }
  }

  return { id: hostedModelsPluginId, registerRoutes, status: { fields: {
    modelProfiles: modelProfileChoice.array(),
    modelChecks: modelCheckStatus.array(),
    defaultModelProfileId: modelActivationInput.shape.id,
  }, read: readStatus } }
}
