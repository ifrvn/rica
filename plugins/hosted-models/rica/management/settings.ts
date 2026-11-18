import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ModelProfileInput, ModelSettingsContracts, ModelSettingsInput, ModelSettingsView } from './contracts.js'
import { writeSettings } from '../../../../packages/runtime/write-settings.js'

type ActiveSettings = { version: number; name?: string; configuration: ModelSettingsInput }
const simulated = { provider: 'simulated' } as const

export class ModelSettingsError extends Error {
  constructor(readonly code: 'VERSION_CONFLICT' | 'KEY_REQUIRED' | 'MODEL_NOT_CONFIGURED' | 'PROVIDER_CHANGED') { super(code) }
}

// The deployment runs one settings writer. Workers read complete records using atomic replacement.
export function createModelSettingsStore(directory: string, contracts: ModelSettingsContracts) {
  const version = z.number().int().nonnegative()
  const configuration = contracts.modelSettingsInput.safeExtend({
    model: contracts.modelSettingsInput.shape.model.unwrap(),
    apiKey: contracts.modelSettingsInput.shape.apiKey.unwrap(),
  })
  const profile = z.strictObject({ version: version.positive(), name: contracts.modelProfileInput.shape.name, configuration })
  const recordSchema = z.strictObject({
    version,
    defaultProfileId: z.uuid().nullable(),
    profiles: z.record(z.uuid(), profile),
  }).refine((record) => (record.defaultProfileId === null || !!record.profiles[record.defaultProfileId])
    && Object.values(record.profiles).every((saved) => saved.version <= record.version))
  const legacyProfileId = '00000000-0000-4000-8000-000000000001'
  const legacySchema = z.strictObject({ version: version.positive(), configuration: z.union([
    configuration, z.strictObject({ provider: z.literal('simulated') }),
  ]) }).transform(({ version, configuration: saved }) => ({
    version,
    defaultProfileId: 'apiKey' in saved ? legacyProfileId : null,
    profiles: 'apiKey' in saved ? { [legacyProfileId]: { version, name: saved.model.slice(0, 80), configuration: saved } } : {},
  }))
  const readableSchema = recordSchema.or(legacySchema.pipe(recordSchema))
  type Record = z.infer<typeof recordSchema>
  const path = join(directory, 'settings.json')
  let writes: Promise<unknown> = Promise.resolve()

  async function readSettings(): Promise<Record> {
    try {
      return readableSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, defaultProfileId: null, profiles: {} }
      throw new Error('Model settings are unreadable')
    }
  }

  function view({ version, defaultProfileId, profiles }: Record): ModelSettingsView {
    return { version, defaultProfileId, profiles: Object.entries(profiles).map(([id, { name, configuration }]) => ({
      id, name, provider: configuration.provider, model: configuration.model, baseUrl: configuration.baseUrl ?? null, hasKey: true,
    })) }
  }

  function update(expected: number, change: (current: Record) => void) {
    const write = writes.then(async () => {
      const current = await readSettings()
      if (current.version !== expected) throw new ModelSettingsError('VERSION_CONFLICT')
      current.version += 1
      change(current)
      const record = recordSchema.parse(current)
      await writeSettings(directory, path, record)
      return view(record)
    })
    writes = write.catch(() => {})
    return write
  }

  function save({ id, name, ...input }: ModelProfileInput, expected: number) {
    return update(expected, (current) => {
      const previous = id ? current.profiles[id]?.configuration : undefined
      if (id && !previous) throw new ModelSettingsError('MODEL_NOT_CONFIGURED')
      if (previous && previous.provider !== input.provider) throw new ModelSettingsError('PROVIDER_CHANGED')
      const apiKey = input.apiKey ?? (previous?.baseUrl === input.baseUrl ? previous?.apiKey : undefined)
      if (!apiKey) throw new ModelSettingsError('KEY_REQUIRED')
      current.profiles[id ?? randomUUID()] = {
        version: current.version, name, configuration: configuration.parse({ ...input, apiKey }),
      }
    })
  }

  function activate(id: string | null, expected: number) {
    return update(expected, (current) => {
      if (id !== null && !current.profiles[id]) throw new ModelSettingsError('MODEL_NOT_CONFIGURED')
      current.defaultProfileId = id
    })
  }

  function remove(id: string, expected: number) {
    return update(expected, (current) => {
      if (!Object.hasOwn(current.profiles, id)) throw new ModelSettingsError('MODEL_NOT_CONFIGURED')
      delete current.profiles[id]
      if (current.defaultProfileId === id) current.defaultProfileId = null
    })
  }

  async function read(selection?: string): Promise<ActiveSettings> {
    const { defaultProfileId, profiles } = await readSettings()
    const id = selection ?? defaultProfileId
    return id && Object.hasOwn(profiles, id) ? profiles[id]! : { version: 0, configuration: simulated }
  }

  return { contracts, read, readSettings, async status() { return view(await readSettings()) }, save, activate, remove }
}

export function enabledModelSettings(store: Pick<ReturnType<typeof createModelSettingsStore>, 'read'>,
  isEnabled: () => Promise<boolean>) {
  return { async read(selection?: string): Promise<ActiveSettings> {
    const current = await store.read(selection)
    const { provider } = current.configuration
    return provider === 'simulated' || await isEnabled() ? current
      : { ...current, configuration: { provider: 'simulated' } }
  } }
}
