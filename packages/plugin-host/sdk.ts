import type { AssessDiscussion } from '@ricajs/contracts/discussion-selection'
import type { PluginStage } from '@ricajs/contracts/deployment-plugins'

export type PluginJson = null | boolean | number | string | PluginJson[] | { [key: string]: PluginJson }

export type PluginReadRequest = Readonly<{
  characterId: string
  actorId: string
  path: string
  query: readonly (readonly [name: string, value: string])[]
}>

export type PluginManagement = Readonly<{
  read(request: PluginReadRequest, services: PluginReadServices): Promise<PluginJson>
  stop?(): void | Promise<void>
}>

export type PluginAccount = Readonly<{
  id: string
  identityId: string
  instanceKey: string
  remoteAccountId: string
  status: string
  bindingVersion: number
}>

export type PluginReadServices = Readonly<{
  readAccounts(ids: readonly string[]): Promise<PluginAccount[]>
}>

export type PluginContext = Readonly<{ databaseUrl?: string }>

export type PluginWorkerServices = Readonly<{
  readDeployment?(): Promise<{ stage?: PluginStage; config: unknown }>
  discussion?: Readonly<{
    isEnabled(): Promise<boolean>
    assess(input: Parameters<AssessDiscussion>[0], profile: Parameters<AssessDiscussion>[1],
      identity: Pick<Parameters<AssessDiscussion>[2], 'characterId' | 'identityId'>,
      capture: Parameters<AssessDiscussion>[3]): Promise<unknown>
  }>
}>

export type PluginWorkerContext = PluginContext & Readonly<{ signal: AbortSignal; services?: PluginWorkerServices }>

export type PluginWorker = Readonly<{
  start(): void | Promise<void>
  stop(): void | Promise<void>
}>

type ManagementFactory = (config: PluginJson, context: PluginContext) => PluginManagement | Promise<PluginManagement>
type WorkerFactory = (config: PluginJson, context: PluginWorkerContext) => PluginWorker
export type PluginActivity = Readonly<{ view: string }>
export type PluginRetention = Readonly<{ sweep: string }>
export type PluginCommand = Readonly<{ id: string; function: string; scope: 'character' | 'account' }>
export type PluginAccountPreparation = Readonly<{
  characterId: string
  instanceKey: string
  remoteAccountId: string
  data: PluginJson
}>

export type PluginAccounts = Readonly<{
  register: string
  profiles?: string
  remove?: string
  verifyResume?: string
  prepareRegistration?(request: PluginAccountPreparation): Promise<{ accepted: true; data: PluginJson } | { accepted: false }>
}>

type Capabilities = {
  management: ManagementFactory
  worker: WorkerFactory
  activity: PluginActivity
  accounts: PluginAccounts
  retention: PluginRetention
  commands: readonly PluginCommand[]
}
type DeclaredCapability = { [K in keyof Capabilities]: Pick<Capabilities, K> }[keyof Capabilities]

export type RicaPlugin = Readonly<{ id: string; sdkVersion: 1; workerServices?: { discussion: true } } &
  Partial<Capabilities> & DeclaredCapability>
