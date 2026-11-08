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
export type SimulationPlatformVersion = (id: string) => string | undefined
