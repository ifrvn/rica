import type { ModelProvider } from './model-provider.js'
import type { Plugin, PluginDefinition } from './plugin-registry.js'

const replies = {
  neutral: { noEvidence: '收到，我会考虑这条消息。', prefix: '' },
  formal: { noEvidence: '感谢您的来信，我会认真考虑。', prefix: '供您参考：' },
  casual: { noEvidence: '收到啦，我会看看。', prefix: '这条或许有用：' },
  concise: { noEvidence: '收到。', prefix: '参考：' },
}

export const simulatedModel: ModelProvider = {
  async decide({ text }, signal) {
    signal.throwIfAborted()
    return text.trim() ? 'REPLY' : 'NO_OP'
  },
  async write({ evidence, style }, signal) {
    signal.throwIfAborted()
    const [first] = evidence
    const reply = replies[style]
    return first
      ? { text: reply.prefix + first.content, evidenceIds: [first.id] }
      : { text: reply.noEvidence, evidenceIds: [] }
  },
}

export const simulatedModelPlugin: Plugin<ModelProvider> = {
  id: 'simulated',
  version: '1.1.0',
  contractVersion: 1,
  implementation: simulatedModel,
}

export const simulatedModelDefinition: PluginDefinition<ModelProvider> = {
  id: simulatedModelPlugin.id,
  version: simulatedModelPlugin.version,
  contractVersion: simulatedModelPlugin.contractVersion,
  create: () => ({ implementation: simulatedModel }),
}
