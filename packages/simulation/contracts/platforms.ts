import type { Plugin } from '@ricajs/plugin-host'

export const maxSimulatedTextLength = 4_000

// The stored payload and its digest include this boundary. Ordinary line breaks stay inside a message.
export const simulationMessageSeparator = '\u001e'

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
  isIm: boolean
  normalize(payload: unknown): NormalizedPlatformEvent
}>

export type ResolveSimulationPlatform = (id: string) => Plugin<PlatformAdapter> | undefined
type SimulationAdapterBinding = Readonly<{
  adapterId: string
  adapterVersion: string
  adapterContractVersion: number
}>

type ActiveSimulationAdapter = SimulationAdapterBinding & Readonly<{ isIm: boolean }>

export type ResolveSimulationAdapter = (platformId: string) => ActiveSimulationAdapter | undefined

export function matchesSimulationAdapter(expected: SimulationAdapterBinding, actual: ActiveSimulationAdapter | undefined) {
  return actual !== undefined && expected.adapterId === actual.adapterId
    && expected.adapterVersion === actual.adapterVersion && expected.adapterContractVersion === actual.adapterContractVersion
}
