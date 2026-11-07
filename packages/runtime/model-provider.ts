import { registerPlugins, type Plugin } from './plugin-registry.js'

export const maxSimulatedTextLength = 4_000

export type ModelEvidence = Readonly<{ id: string; revision: number; content: string }>

type ModelInput = Readonly<{
  text: string
  evidence: readonly ModelEvidence[]
}>

export type ModelProvider = Readonly<{
  decide(input: ModelInput, signal: AbortSignal): Promise<unknown>
  write(input: ModelInput, signal: AbortSignal): Promise<unknown>
}>

export const simulatedModel: ModelProvider = {
  async decide({ text }, signal) {
    signal.throwIfAborted()
    return text.trim() ? 'REPLY' : 'NO_OP'
  },
  async write({ evidence }, signal) {
    signal.throwIfAborted()
    const [first] = evidence
    return first
      ? { text: first.content, evidenceIds: [first.id] }
      : { text: '收到，我会考虑这条消息。', evidenceIds: [] }
  },
}

export const simulatedModelPlugin: Plugin<ModelProvider> = {
  id: 'simulated',
  version: '1.0.0',
  contractVersion: 1,
  implementation: simulatedModel,
}

export const resolveModelProvider = registerPlugins('model', [simulatedModelPlugin])
