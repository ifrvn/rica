import { newbiReaderIdentity } from './contracts.js'
import { newbiExecutorIdentity } from './executor-identity.js'
import type { PluginMetadata } from '../../packages/contracts/plugin-status.js'

export const newbiCatalog = {
  'connector-reader': [{ ...newbiReaderIdentity, kind: 'platform-reader' }],
  'connector-executor': [{ ...newbiExecutorIdentity, kind: 'platform-reply-executor' }],
} satisfies Record<string, PluginMetadata[]>
