import type { ModelProvider } from '@ricajs/contracts/model-provider'
import type { Plugin } from '@ricajs/plugin-host'

const replies = {
  neutral: { noEvidence: '收到，我会考虑这条消息。', prefix: '' },
  formal: { noEvidence: '感谢您的来信，我会认真考虑。', prefix: '供您参考：' },
  casual: { noEvidence: '收到啦，我会看看。', prefix: '这条或许有用：' },
  concise: { noEvidence: '收到。', prefix: '参考：' },
}

export const simulatedModel: ModelProvider = {
  async decide({ text, context, conversation, groupChat, participation }, signal) {
    signal.throwIfAborted()
    if (!text.trim()) return { action: 'NO_OP', reason: 'UNCLEAR' }
    if (!conversation && !groupChat) return 'REPLY'
    const message = text.normalize('NFKC')
    const name = context.self.name?.normalize('NFKC')
    const directed = message.includes('@角色') || (name && message.includes('@' + name))
    if (directed) return { action: 'REPLY', reason: 'DIRECT_REQUEST' }
    if (/@[^\s@]/u.test(message)) return { action: 'NO_OP', reason: 'BYSTANDER' }
    if (conversation?.history.some(({ message: previous }) => previous.trim() === text.trim())) {
      return { action: 'NO_OP', reason: 'ALREADY_ADDRESSED' }
    }
    if (participation !== 'reserved' && /[?？]$/u.test(text.trim())) {
      return { action: 'REPLY', reason: 'RELEVANT_TOPIC' }
    }
    if (participation === 'talkative' && message.trim().length >= 4) {
      return { action: 'REPLY', reason: 'SOCIAL_OPENING' }
    }
    return { action: 'NO_OP', reason: 'BYSTANDER' }
  },
  async write({ evidence, style, conversation }, signal) {
    signal.throwIfAborted()
    const [first] = evidence
    const reply = replies[style]
    return first
      ? { text: reply.prefix + first.content, evidenceIds: [first.id] }
      : { text: conversation ? conversation.speaker + '，' + reply.noEvidence : reply.noEvidence, evidenceIds: [] }
  },
}

export const localSimulationModel: Plugin<ModelProvider> = {
  id: 'simulated',
  version: '1.1.0',
  contractVersion: 1,
  implementation: simulatedModel,
}
