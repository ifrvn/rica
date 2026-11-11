import { newbiEndpoint, newbiReaderIdentity } from '../../packages/contracts/newbi-pilot.js'
import { createNewbiReadClient } from '../../packages/runtime/newbi-client.js'
import { startPluginHost, type PluginDefinition } from '../../packages/runtime/plugin-registry.js'

const credentialService = 'local-agent-credential'

export async function verifyNewbiBinding(endpoint: string, agentId: string, env = process.env, beforeRequest?: () => Promise<void>) {
  // Only the deployment-configured endpoint may receive the deployment credential.
  if (newbiEndpoint.safeParse(env.RICA_NEWBI_LOCAL_API_URL).data !== endpoint) return false
  try {
    const host = await startNewbiReader(env, AbortSignal.timeout(2000), beforeRequest)
    try {
      return (await host.plugin.implementation.verify()).id === agentId
    } finally {
      await host.stop()
    }
  } catch {
    return false
  }
}

export async function startNewbiReader(env = process.env, signal?: AbortSignal, beforeRequest?: () => Promise<void>) {
  const credential = env.NEWBI_AGENT_KEY ?? ''
  const definition: PluginDefinition<ReturnType<typeof createNewbiReadClient>> = {
    ...newbiReaderIdentity,
    requires: [credentialService],
    validateConfig: (value) => newbiEndpoint.safeParse(value).success,
    create(config) {
      const stop = new AbortController()
      const requestSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      return {
        implementation: createNewbiReadClient(newbiEndpoint.parse(config), credential, requestSignal, beforeRequest),
        stop: () => stop.abort(),
      }
    },
  }
  const host = await startPluginHost('platform-reader', [definition], [
    { id: definition.id, config: env.RICA_NEWBI_LOCAL_API_URL },
  ], { services: new Set(credential ? [credentialService] : []) })
  return { plugin: host.find(definition.id)!, stop: host.stop }
}
