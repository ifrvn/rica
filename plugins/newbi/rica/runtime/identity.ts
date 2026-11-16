export const newbiReaderIdentity = { id: 'newbi-local-reader', version: '1.0.0', contractVersion: 1 } as const

export const newbiExecutorIdentity = {
  id: 'newbi-local-executor',
  version: '1.0.0',
  contractVersion: 1,
} as const

export function newbiExecutorKey(plugin: Readonly<{ id: string; version: string; contractVersion: number }>) {
  return plugin.id + '@' + plugin.version + '/' + plugin.contractVersion
}
