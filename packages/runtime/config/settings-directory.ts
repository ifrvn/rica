import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function modelSettingsDirectory(databaseUrl: string, override = process.env.RICA_MODEL_SETTINGS_DIR) {
  if (override) return override
  const db = new URL(databaseUrl)
  const deployment = createHash('sha256').update(db.host + db.pathname).digest('hex').slice(0, 24)
  return join(homedir(), '.rica', 'model-settings', deployment)
}
