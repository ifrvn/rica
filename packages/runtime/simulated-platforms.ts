import { maxSimulatedTextLength } from './model-provider.js'
import { registerPlugins } from './plugin-registry.js'

export type NormalizedPlatformEvent = Readonly<{
  remoteAccountId: string
  remoteConversationKey: string
  remoteContactKey?: string
  sourceKey: string
  messageText: string
  kind: 'POST' | 'REPLY' | 'MENTION'
  occurredAt: Date
}>

type PlatformAdapter = Readonly<{
  normalize(payload: unknown): NormalizedPlatformEvent
}>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid simulated platform payload')
  }
  return value as Record<string, unknown>
}

function requiredText(value: unknown, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new Error('Invalid simulated platform text field')
  }
  return value
}

function eventKind(value: unknown): NormalizedPlatformEvent['kind'] {
  if (value === 'POST' || value === 'REPLY' || value === 'MENTION') return value
  throw new Error('Unsupported simulated event kind')
}

function validEventTime(date: Date) {
  const year = date.getUTCFullYear()
  return year >= 1 && year <= 9999
}

function mockA(payload: unknown): NormalizedPlatformEvent {
  const event = record(payload)
  const timestamp = requiredText(event.occurredAt)
  const occurredAt = new Date(timestamp)
  if (!validEventTime(occurredAt) || occurredAt.toISOString() !== timestamp) {
    throw new Error('Invalid mock-a event timestamp')
  }
  return {
    remoteAccountId: requiredText(event.account),
    remoteConversationKey: requiredText(event.thread),
    remoteContactKey: event.sender === undefined ? undefined : requiredText(event.sender),
    sourceKey: requiredText(event.id),
    messageText: requiredText(event.text, maxSimulatedTextLength),
    kind: eventKind(event.kind),
    occurredAt,
  }
}

function mockB(payload: unknown): NormalizedPlatformEvent {
  const envelope = record(payload)
  const message = record(envelope.message)
  const timestamp = envelope.timeMs
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || Math.abs(timestamp) > 8.64e15) {
    throw new Error('Invalid mock-b event timestamp')
  }
  const occurredAt = new Date(timestamp)
  if (!validEventTime(occurredAt)) throw new Error('Invalid mock-b event timestamp')
  return {
    remoteAccountId: requiredText(envelope.recipient),
    remoteConversationKey: requiredText(message.conversation),
    remoteContactKey: message.author === undefined ? undefined : requiredText(message.author),
    sourceKey: requiredText(envelope.delivery),
    messageText: requiredText(message.body, maxSimulatedTextLength),
    kind: eventKind(requiredText(envelope.action).toUpperCase()),
    occurredAt,
  }
}

export const resolveSimulatedPlatform = registerPlugins<PlatformAdapter>('platform', [
  { id: 'mock-a', version: '1.0.0', contractVersion: 1, implementation: { normalize: mockA } },
  { id: 'mock-b', version: '1.0.0', contractVersion: 1, implementation: { normalize: mockB } },
])
