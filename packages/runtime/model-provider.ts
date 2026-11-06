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
