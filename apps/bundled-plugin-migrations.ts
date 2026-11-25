import { newbiBootstrapMigration } from '@ricajs/plugin-newbi/rica/migration'

type BundledPluginMigration = (databaseUrl: string) => { config: string; env: Record<string, string> }

export const bundledPluginMigrations: readonly BundledPluginMigration[] = [newbiBootstrapMigration]
