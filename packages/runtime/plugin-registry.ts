export type Plugin<T> = Readonly<{
  id: string
  version: string
  contractVersion: number
  implementation: T
}>

export function registerPlugins<T>(kind: string, plugins: readonly Plugin<T>[]) {
  const registered = new Map<string, Plugin<T>>()
  for (const plugin of plugins) {
    if (plugin.contractVersion !== 1) throw new Error(`Incompatible ${kind} contract: ${plugin.id}`)
    if (registered.has(plugin.id)) throw new Error(`Duplicate ${kind} registration: ${plugin.id}`)
    registered.set(plugin.id, plugin)
  }

  return (id: string) => {
    const plugin = registered.get(id)
    if (!plugin) throw new Error(`Unknown ${kind} plugin: ${id}`)
    return plugin
  }
}
