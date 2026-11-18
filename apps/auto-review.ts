import type { ReviewPublicReply } from '../packages/contracts/auto-review.js'
import type { ModelProvider } from '../packages/contracts/model-provider.js'

export function createAutoReviewer(useDefaultModel: (review: (model: ModelProvider) => Promise<string | null>) =>
  Promise<string | null>): ReviewPublicReply {
  return async (settings, reply) => {
    if (!settings.enabled || !reply.draft.trim() || !reply.discussion.trim() || reply.discussion.length > 12_000) return null
    try {
      return await useDefaultModel(async (model) => {
        if (!model.hostedModel || !model.hostedProvider || !model.review) return null
        const outcome = await model.review(settings.prompt, reply, AbortSignal.timeout(7_000))
        return outcome === 'APPROVE' ? model.hostedProvider + '/' + model.hostedModel : null
      })
    } catch {
      return null
    }
  }
}
