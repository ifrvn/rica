export default {
  schema: './migration.prisma',
  migrations: { path: './migrations' },
  datasource: { url: process.env.RICA_PLUGIN_DATABASE_URL },
}
