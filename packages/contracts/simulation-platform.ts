import type { Plugin } from '../runtime/plugin-registry.js'

export type NormalizedPlatformEvent = Readonly<{
  remoteAccountId: string
  remoteConversationKey: string
  remoteContactKey?: string
  sourceKey: string
  messageText: string
  kind: 'POST' | 'REPLY' | 'MENTION'
  occurredAt: Date
}>

export type PlatformAdapter = Readonly<{
  normalize(payload: unknown): NormalizedPlatformEvent
}>

export type ResolveSimulationPlatform = (id: string) => Plugin<PlatformAdapter> | undefined
type SimulationAdapterBinding = Readonly<{
  adapterId: string
  adapterVersion: string
  adapterContractVersion: number
}>

type ActiveSimulationAdapter = Readonly<{
  adapterId: string
  adapterVersion: string
  adapterContractVersion: number
}>

export type ResolveSimulationAdapter = (platformId: string) => ActiveSimulationAdapter | undefined

export function matchesSimulationAdapter(expected: SimulationAdapterBinding, actual: ActiveSimulationAdapter | undefined) {
  return actual !== undefined && expected.adapterId === actual.adapterId
    && expected.adapterVersion === actual.adapterVersion && expected.adapterContractVersion === actual.adapterContractVersion
}
