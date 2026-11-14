import type { NewbiConnection } from './reader.js'
import { newbiExecutorIdentity } from '@rica/contracts/newbi-executor-identity'
import { newbiEndpoint } from '@rica/contracts/newbi-pilot'
import { createNewbiReplyExecutor } from './client.js'
import { startPluginHost, type PluginDefinition } from '@rica/plugin-host'

const credentialService = 'local-agent-credential'

export async function startNewbiExecutor(connection: NewbiConnection, beforeRequest?: () => Promise<void>, signal?: AbortSignal) {
  const credential = connection.credential
  const definition: PluginDefinition<ReturnType<typeof createNewbiReplyExecutor>> = {
    ...newbiExecutorIdentity,
    requires: [credentialService],
    validateConfig: (value) => newbiEndpoint.safeParse(value).success,
    create(config) {
      const stop = new AbortController()
      return {
        implementation: createNewbiReplyExecutor(newbiEndpoint.parse(config), credential,
          signal ? AbortSignal.any([signal, stop.signal]) : stop.signal, beforeRequest),
        stop: () => stop.abort(),
      }
    },
  }
  const host = await startPluginHost('platform-reply-executor', [definition], [
    { id: definition.id, config: connection.endpoint },
  ], { services: new Set(credential ? [credentialService] : []) })
  return { plugin: host.find(definition.id)!, stop: host.stop }
}
