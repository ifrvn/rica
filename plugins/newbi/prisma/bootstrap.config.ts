export default {
  schema: './schema.prisma',
  migrations: { path: './bootstrap' },
  datasource: { url: process.env.RICA_NEWBI_BOOTSTRAP_URL },
}
