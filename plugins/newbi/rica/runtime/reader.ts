import { newbiEndpoint } from '../../agent-api/connection.js'
import { createNewbiReadClient } from './agent-adapter.js'
import { newbiReaderIdentity } from './identity.js'
import { startPluginHost, type PluginDefinition } from '@ricajs/plugin-host'

const credentialService = 'local-agent-credential'

export type NewbiConnection = { endpoint: string; credential: string }

export async function identifyNewbiAccount(connection: NewbiConnection, beforeRequest?: () => Promise<void>) {
  const endpoint = newbiEndpoint.safeParse(connection.endpoint).data
  if (!endpoint) return
  try {
    const host = await startNewbiReader(connection, AbortSignal.timeout(2000), beforeRequest)
    try {
      const { id: agentId, username, avatarUrl } = await host.plugin.implementation.verify()
      await beforeRequest?.()
      return { endpoint, agentId, username, avatarUrl }
    } finally {
      await host.stop()
    }
  } catch {
    return undefined
  }
}

export async function startNewbiReader(connection: NewbiConnection, signal?: AbortSignal, beforeRequest?: () => Promise<void>) {
  const credential = connection.credential
  const definition: PluginDefinition<ReturnType<typeof createNewbiReadClient>> = {
    ...newbiReaderIdentity,
    requires: [credentialService],
    prepare(config) {
      const endpoint = newbiEndpoint.parse(config)
      return () => {
        const stop = new AbortController()
        const requestSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
        return {
          implementation: createNewbiReadClient(endpoint, credential, requestSignal, beforeRequest),
          stop: () => stop.abort(),
        }
      }
    },
  }
  const host = await startPluginHost('platform-reader', [definition], [
    { id: definition.id, config: connection.endpoint },
  ], { services: new Set(credential ? [credentialService] : []) })
  return { plugin: host.find(definition.id)!, stop: host.stop }
}
