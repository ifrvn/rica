import { newbiBootstrapMigration } from '@ricajs/plugin-newbi/rica/migration'

type BundledPluginMigration = Readonly<{
  beforeHost?(databaseUrl: string): Promise<void>
  prepare(databaseUrl: string): { config: string; env: Record<string, string> }
}>

export const bundledPluginMigrations: readonly BundledPluginMigration[] = [newbiBootstrapMigration]
