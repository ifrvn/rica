import type { ModelProvider } from '@ricajs/contracts/model-provider'
import type { AssessDiscussion } from '@ricajs/contracts/discussion-selection'

export function createDiscussionAssessor(useModel: (assess: (model: ModelProvider) => Promise<unknown>,
  profile?: string) => Promise<unknown>): AssessDiscussion {
  return (input, profile, attribution, capture) => useModel(async (model) => {
    if (!model.selectDiscussion || !model.hostedProvider || !model.hostedModel) return
    const name = `${model.hostedProvider}/${model.hostedModel}`
    return model.selectDiscussion(input, AbortSignal.timeout(8000), attribution, (prompt) => capture(prompt, name))
  }, profile).then((result) => result ?? undefined)
}
