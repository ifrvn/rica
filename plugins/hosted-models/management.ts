import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { versionHeader } from '@rica/contracts/management'
import { modelCheckInput, type ModelCheckStatus } from './contracts.js'
import { checkModel } from './check.js'
import { ModelSettingsError, type createModelSettingsStore } from './settings.js'
import { ManagementError } from '../../packages/persistence/management.js'
import { body, errors, security, success, version, type ManagementEnvironment, type ManagementPlugin, type ManagementPrincipal } from '../../packages/runtime/management-http.js'

export function createHostedModelManagement({ modelSettings, authorize, isEnabled, startModelPlugin }: {
  modelSettings: ReturnType<typeof createModelSettingsStore>
  authorize(actor: ManagementPrincipal): void
  isEnabled(provider: string): Promise<boolean>
  startModelPlugin: Parameters<typeof checkModel>[1]
}): ManagementPlugin {
  const { modelCheckResult, modelCheckStatus, modelSettingsInput, modelSettingsView } = modelSettings.contracts
  let checkingModel = false
  let latestModelCheck: { version: number; result: ModelCheckStatus } | undefined

  function registerRoutes(app: OpenAPIHono<ManagementEnvironment>) {
    app.openapi(createRoute({
      method: 'get', path: '/model-settings', security,
      responses: { ...errors, 200: success(modelSettingsView) },
    }), async (c) => {
      authorize(c.get('actor'))
      const store = modelSettings
      return c.json(await store.status(), 200)
    })

    app.openapi(createRoute({
      method: 'put', path: '/model-settings', security,
      request: { headers: versionHeader, body: body(modelSettingsInput) },
      responses: { ...errors, 200: success(modelSettingsView) },
    }), async (c) => {
      const actor = c.get('actor')
      authorize(actor)
      const store = modelSettings
      const input = c.req.valid('json')
      if (input.provider !== 'simulated' && !await isEnabled(input.provider)) {
        throw new ManagementError(409, 'PLUGIN_STATE_CONFLICT', 'Enable the model plugin first')
      }
      try {
        const saved = await store.save(input, version(c.req.valid('header')))
        console.info(JSON.stringify({ service: 'api', event: 'model_settings_updated', actorId: actor.id,
          requestId: c.get('requestId'), version: saved.version, provider: saved.provider }))
        return c.json(saved, 200)
      } catch (cause) {
        if (cause instanceof ModelSettingsError) {
          if (cause.code === 'VERSION_CONFLICT') throw new ManagementError(412, cause.code, 'Model settings have changed')
          throw new ManagementError(422, cause.code, 'An API key is required for this provider and endpoint')
        }
        throw cause
      }
    })

    app.openapi(createRoute({
      method: 'post', path: '/model-settings/check', security,
      request: { body: body(modelCheckInput) },
      responses: { ...errors, 200: success(modelCheckResult) },
    }), async (c) => {
      authorize(c.get('actor'))
      const store = modelSettings
      const expected = c.req.valid('json').version
      if (checkingModel) throw new ManagementError(409, 'MODEL_CHECK_BUSY', 'A model check is in progress')
      checkingModel = true
      try {
        const saved = await store.read()
        if (saved.version !== expected) throw new ManagementError(412, 'VERSION_CONFLICT', 'Model settings have changed')
        const { configuration } = saved
        const { provider } = configuration
        if (provider === 'simulated'
          || !await isEnabled(provider)) {
          throw new ManagementError(409, 'PLUGIN_STATE_CONFLICT', 'Enable and configure the model plugin first')
        }
        const result = await checkModel(configuration, startModelPlugin)
        const { reply: _reply, ...status } = result
        latestModelCheck = { version: expected, result: status }
        return c.json(result, 200)
      } finally {
        checkingModel = false
      }
    })
  }

  async function readStatus() {
    const current = await modelSettings.status()
    const recent = latestModelCheck
    const modelCheck = recent && recent.version === current.version && recent.result.provider === current.provider
      && await isEnabled(current.provider) ? recent.result : undefined
    return { modelCheck }
  }

  return { id: 'hosted-models', registerRoutes, status: { fields: { modelCheck: modelCheckStatus.optional() }, read: readStatus } }
}
