import { newbiEndpoint } from '../../packages/contracts/newbi-pilot.js'
import { createNewbiReadClient } from '../../packages/runtime/newbi-client.js'
import { startPluginHost, type PluginDefinition } from '../../packages/runtime/plugin-registry.js'

const credentialService = 'local-agent-credential'

export async function startNewbiReader(env = process.env, signal?: AbortSignal) {
  const credential = env.NEWBI_AGENT_KEY ?? ''
  const definition: PluginDefinition<ReturnType<typeof createNewbiReadClient>> = {
    id: 'newbi-local-reader',
    version: '1.0.0',
    contractVersion: 1,
    requires: [credentialService],
    validateConfig: (value) => newbiEndpoint.safeParse(value).success,
    create(config) {
      const stop = new AbortController()
      const requestSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      return {
        implementation: createNewbiReadClient(newbiEndpoint.parse(config), credential, requestSignal),
        stop: () => stop.abort(),
      }
    },
  }
  const host = await startPluginHost('platform-reader', [definition], [
    { id: definition.id, config: env.RICA_NEWBI_LOCAL_API_URL },
  ], { services: new Set(credential ? [credentialService] : []) })
  return { plugin: host.find(definition.id)!, stop: host.stop }
}
