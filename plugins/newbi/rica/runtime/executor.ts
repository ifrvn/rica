import type { NewbiConnection } from './reader.js'
import { newbiExecutorIdentity } from './identity.js'
import { newbiEndpoint } from '../../agent-api/connection.js'
import { createNewbiReplyExecutor } from './agent-adapter.js'
import { startPluginHost, type PluginDefinition } from '@rica/plugin-host'

const credentialService = 'local-agent-credential'

export async function startNewbiExecutor(connection: NewbiConnection, beforeRequest?: () => Promise<void>, signal?: AbortSignal) {
  const credential = connection.credential
  const definition: PluginDefinition<ReturnType<typeof createNewbiReplyExecutor>> = {
    ...newbiExecutorIdentity,
    requires: [credentialService],
    prepare(config) {
      const endpoint = newbiEndpoint.parse(config)
      return () => {
        const stop = new AbortController()
        return {
          implementation: createNewbiReplyExecutor(endpoint, credential,
            signal ? AbortSignal.any([signal, stop.signal]) : stop.signal, beforeRequest),
          stop: () => stop.abort(),
        }
      }
    },
  }
  const host = await startPluginHost('platform-reply-executor', [definition], [
    { id: definition.id, config: connection.endpoint },
  ], { services: new Set(credential ? [credentialService] : []) })
  return { plugin: host.find(definition.id)!, stop: host.stop }
}
