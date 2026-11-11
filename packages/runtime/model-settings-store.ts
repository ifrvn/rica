import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { modelSettingsInput, type ModelSettingsInput, type ModelSettingsView } from '../contracts/model-settings.js'
import { writeSettings } from './write-settings.js'

const recordSchema = z.strictObject({
  version: z.number().int().positive(),
  configuration: modelSettingsInput.refine((value) => value.provider === 'simulated' || !!value.apiKey),
})
type Record = z.infer<typeof recordSchema>

export class ModelSettingsError extends Error {
  constructor(readonly code: 'VERSION_CONFLICT' | 'KEY_REQUIRED') { super(code) }
}

export function modelSettingsDirectory(databaseUrl: string, override = process.env.RICA_MODEL_SETTINGS_DIR) {
  if (override) return override
  const db = new URL(databaseUrl)
  const deployment = createHash('sha256').update(db.host + db.pathname).digest('hex').slice(0, 24)
  return join(homedir(), '.rica', 'model-settings', deployment)
}

function view({ version, configuration }: Record): ModelSettingsView {
  const { provider, model, baseUrl, apiKey } = configuration
  return { version, provider, model: model ?? null, baseUrl: baseUrl ?? null, hasKey: !!apiKey }
}

// The deployment runs one settings writer. Workers read complete records using atomic replacement.
export function createModelSettingsStore(directory: string) {
  const path = join(directory, 'settings.json')
  let writes: Promise<unknown> = Promise.resolve()

  async function read(): Promise<Record> {
    try {
      return recordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, configuration: { provider: 'simulated' } }
      throw new Error('Model settings are unreadable')
    }
  }

  function save(input: ModelSettingsInput, version: number) {
    const write = writes.then(async () => {
      const current = await read()
      if (current.version !== version) throw new ModelSettingsError('VERSION_CONFLICT')
      const previous = current.configuration
      const sameEndpoint = previous.provider === input.provider && previous.baseUrl === input.baseUrl
      const apiKey = input.apiKey ?? (sameEndpoint ? previous.apiKey : undefined)
      if (input.provider !== 'simulated' && !apiKey) throw new ModelSettingsError('KEY_REQUIRED')
      const record = recordSchema.parse({ version: version + 1, configuration: { ...input, apiKey } })
      await writeSettings(directory, path, record)
      return view(record)
    })
    writes = write.catch(() => {})
    return write
  }

  return { read, async status() { return view(await read()) }, save }
}
