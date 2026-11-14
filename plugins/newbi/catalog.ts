import { newbiReaderIdentity } from '@rica/contracts/newbi-pilot'
import { newbiExecutorIdentity } from '@rica/contracts/newbi-executor-identity'
import type { PluginMetadata } from '../../packages/contracts/plugin-status.js'

export const newbiCatalog = {
  'connector-reader': [{ ...newbiReaderIdentity, kind: 'platform-reader' }],
  'connector-executor': [{ ...newbiExecutorIdentity, kind: 'platform-reply-executor' }],
} satisfies Record<string, PluginMetadata[]>
