import { createRequire } from 'node:module'

export function newbiBootstrapMigration(databaseUrl: string) {
  const url = new URL(databaseUrl)
  url.searchParams.set('schema', 'rica_bootstrap_newbi')
  return {
    config: createRequire(import.meta.url).resolve('@ricajs/plugin-newbi/rica/bootstrap'),
    env: { RICA_NEWBI_BOOTSTRAP_URL: url.href },
  }
}
