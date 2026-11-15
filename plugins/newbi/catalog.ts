import { newbiReaderIdentity } from './contracts.js'
import { newbiExecutorIdentity } from './executor-identity.js'
import type { PluginMetadata } from '../../packages/contracts/plugin-status.js'

export const newbiCatalog = {
  'connector-reader': [{ ...newbiReaderIdentity, kind: 'platform-reader' }],
  'connector-executor': [{ ...newbiExecutorIdentity, kind: 'platform-reply-executor' }],
} satisfies Record<string, PluginMetadata[]>

export const newbiDeployment = {
  id: 'newbi',
  ownsComponent: (service: string, component: PluginMetadata) => Object.entries(newbiCatalog).some(([owner, entries]) => service === owner &&
    entries.some(({ id, kind }) => component.id === id && component.kind === kind)),
} as const
