import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const newbiPackage = '@ricajs/plugin-newbi'

export const bundledPluginMigrations = [{
  id: 'newbi',
  package: newbiPackage,
  version: (require(newbiPackage + '/package.json') as { version: string }).version,
  journal: 'rica_bootstrap_newbi',
}] as const
