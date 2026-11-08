type PluginIdentity = Readonly<{ id: string; version: string; contractVersion: number }>

export type Plugin<T> = PluginIdentity & Readonly<{ implementation: T }>

export type PluginDefinition<T> = PluginIdentity & Readonly<{
  requires?: readonly string[]
  validateConfig?: (value: unknown) => boolean
  create(config: unknown): Readonly<{
    implementation: T
    start?: () => void | Promise<void>
    stop?: () => void | Promise<void>
  }>
}>

type Selection = Readonly<{ id: string; config?: unknown; optional?: boolean }>
type Diagnostic = Readonly<{ kind: string; id: string; version?: string; code: string }>

export class PluginHostError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code + ': ' + diagnostic.kind + '/' + diagnostic.id)
  }
}

function indexPlugins<T extends PluginIdentity>(kind: string, plugins: readonly T[]) {
  const registered = new Map<string, T>()
  for (const plugin of plugins) {
    const { id, version, contractVersion } = plugin
    const code = contractVersion !== 1 ? 'INCOMPATIBLE_CONTRACT'
      : registered.has(id) ? 'DUPLICATE_PLUGIN' : !id || !version ? 'INVALID_MANIFEST' : null
    if (code) throw new PluginHostError({ kind, id, version, code })
    registered.set(id, plugin)
  }
  return registered
}

export function registerPlugins<T>(kind: string, plugins: readonly Plugin<T>[]) {
  const registered = indexPlugins(kind, plugins)
  return (id: string) => {
    const plugin = registered.get(id)
    if (!plugin) throw new Error('Unknown ' + kind + ' plugin: ' + id)
    return plugin
  }
}

export async function startPluginHost<T>(
  kind: string, definitions: readonly PluginDefinition<T>[], selections: readonly Selection[],
  options: { services?: ReadonlySet<string>; report?: (diagnostic: Diagnostic) => void } = {},
) {
  const registered = indexPlugins(kind, definitions)
  const selected = new Set<string>()
  const prepared: { definition: PluginDefinition<T>; config: unknown; optional: boolean }[] = []
  for (const { id, config, optional = false } of selections) {
    const definition = registered.get(id)
    if (selected.has(id)) throw new PluginHostError({ kind, id: definition?.id ?? '(unregistered)', code: 'DUPLICATE_SELECTION' })
    selected.add(id)
    let valid = false
    try { valid = definition?.validateConfig ? definition.validateConfig(config) : config === undefined }
    catch { /* Configuration values are excluded from diagnostics. */ }
    const code = !definition ? 'UNKNOWN_PLUGIN'
      : !valid ? 'INVALID_CONFIG'
      : definition.requires?.some((service) => !options.services?.has(service)) ? 'MISSING_SERVICE' : null
    if (!definition || code) {
      const diagnostic = { kind, id: definition?.id ?? '(unregistered)', version: definition?.version, code: code ?? 'UNKNOWN_PLUGIN' }
      if (!optional) throw new PluginHostError(diagnostic)
      options.report?.(diagnostic)
    } else {
      prepared.push({ definition, config, optional })
    }
  }

  const active = new Map<string, Plugin<T>>()
  const resources: { id: string; version: string; stop?: () => void | Promise<void> }[] = []
  let stopping: Promise<void> | undefined

  function stop() {
    active.clear()
    return stopping ??= (async () => {
      for (const resource of resources.reverse()) {
        try { await resource.stop?.() }
        catch { options.report?.({ kind, id: resource.id, version: resource.version, code: 'STOP_FAILED' }) }
      }
    })()
  }

  for (const { definition, config, optional } of prepared) {
    const { id, version, contractVersion } = definition
    try {
      const instance = definition.create(config)
      try { await instance.start?.() }
      catch (error) {
        try { await instance.stop?.() }
        catch { options.report?.({ kind, id, version, code: 'STOP_FAILED' }) }
        throw error
      }
      resources.push({ id, version, stop: () => instance.stop?.() })
      active.set(id, { id, version, contractVersion, implementation: instance.implementation })
      options.report?.({ kind, id, version, code: 'READY' })
    } catch {
      const diagnostic = { kind, id, version, code: 'START_FAILED' }
      if (!optional) {
        await stop()
        throw new PluginHostError(diagnostic)
      }
      options.report?.(diagnostic)
    }
  }

  return { find: (id: string) => active.get(id), stop }
}
