import type { NewbiConnection } from './newbi-read-plugin.js'
import { newbiExecutorIdentity } from '../../packages/contracts/newbi-executor-identity.js'
import { newbiEndpoint } from '../../packages/contracts/newbi-pilot.js'
import { createNewbiReplyExecutor } from '../../packages/runtime/newbi-client.js'
import { startPluginHost, type PluginDefinition } from '../../packages/runtime/plugin-registry.js'

const credentialService = 'local-agent-credential'

export async function startNewbiExecutor(connection: NewbiConnection, beforeRequest?: () => Promise<void>) {
  const credential = connection.credential
  const definition: PluginDefinition<ReturnType<typeof createNewbiReplyExecutor>> = {
    ...newbiExecutorIdentity,
    requires: [credentialService],
    validateConfig: (value) => newbiEndpoint.safeParse(value).success,
    create(config) {
      const stop = new AbortController()
      return {
        implementation: createNewbiReplyExecutor(newbiEndpoint.parse(config), credential, stop.signal, beforeRequest),
        stop: () => stop.abort(),
      }
    },
  }
  const host = await startPluginHost('platform-reply-executor', [definition], [
    { id: definition.id, config: connection.endpoint },
  ], { services: new Set(credential ? [credentialService] : []) })
  return { plugin: host.find(definition.id)!, stop: host.stop }
}
