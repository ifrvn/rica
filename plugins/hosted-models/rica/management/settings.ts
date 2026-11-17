import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ModelSettingsContracts, ModelSettingsInput, ModelSettingsView } from './contracts.js'
import { writeSettings } from '../../../../packages/runtime/write-settings.js'

type Record = { version: number; configuration: ModelSettingsInput }

export class ModelSettingsError extends Error {
  constructor(readonly code: 'VERSION_CONFLICT' | 'KEY_REQUIRED') { super(code) }
}

function view({ version, configuration }: Record): ModelSettingsView {
  const { provider, model, baseUrl, apiKey } = configuration
  return { version, provider, model: model ?? null, baseUrl: baseUrl ?? null, hasKey: !!apiKey }
}

// The deployment runs one settings writer. Workers read complete records using atomic replacement.
export function createModelSettingsStore(directory: string, contracts: ModelSettingsContracts) {
  const recordSchema = z.strictObject({
    version: z.number().int().positive(),
    configuration: contracts.modelSettingsInput.refine((value) => value.provider === 'simulated' || !!value.apiKey),
  })
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

  return { contracts, read, async status() { return view(await read()) }, save }
}

export function enabledModelSettings(store: Pick<ReturnType<typeof createModelSettingsStore>, 'read'>,
  isEnabled: () => Promise<boolean>) {
  return { async read(): Promise<Record> {
    const current = await store.read()
    const { provider } = current.configuration
    return provider === 'simulated' || await isEnabled() ? current
      : { ...current, configuration: { provider: 'simulated' } }
  } }
}
