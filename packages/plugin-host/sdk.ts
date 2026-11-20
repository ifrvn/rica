export type PluginJson = null | boolean | number | string | PluginJson[] | { [key: string]: PluginJson }

export type PluginReadRequest = Readonly<{
  characterId: string
  actorId: string
  path: string
  query: readonly (readonly [name: string, value: string])[]
}>

export type PluginManagement = Readonly<{
  read(request: PluginReadRequest): Promise<PluginJson>
  stop?(): void | Promise<void>
}>

export type PluginContext = Readonly<{ databaseUrl?: string }>

export type PluginWorkerContext = PluginContext & Readonly<{ signal: AbortSignal }>

export type PluginWorker = Readonly<{
  start(): void | Promise<void>
  stop(): void | Promise<void>
}>

type ManagementFactory = (config: PluginJson, context: PluginContext) => PluginManagement | Promise<PluginManagement>
type WorkerFactory = (config: PluginJson, context: PluginWorkerContext) => PluginWorker

export type RicaPlugin = Readonly<{ id: string; sdkVersion: 1 } & (
  { management: ManagementFactory; worker?: WorkerFactory } |
  { management?: ManagementFactory; worker: WorkerFactory }
)>
