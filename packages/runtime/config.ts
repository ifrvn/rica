import 'dotenv/config'

function required(name: 'DATABASE_URL' | 'REDIS_URL', protocols: string[]) {
  const value = process.env[name]
  if (!value || !URL.canParse(value) || !protocols.includes(new URL(value).protocol)) {
    throw new Error(`Invalid or missing ${name}`)
  }
  return value
}

export function loadConfig() {
  const port = Number(process.env.PORT ?? '3000')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  return {
    port,
    databaseUrl: required('DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: required('REDIS_URL', ['redis:', 'rediss:']),
  }
}
