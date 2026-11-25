import 'dotenv/config'
import pino from 'pino'

const level = process.env.RICA_LOG_LEVEL ?? 'info'
if (level !== 'silent' && !Object.hasOwn(pino.levels.values, level)) {
  throw new Error('Invalid RICA_LOG_LEVEL. Expected trace, debug, info, warn, error, fatal, or silent.')
}

export const logger = pino({ level })
