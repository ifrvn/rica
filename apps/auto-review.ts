import { modelReviewDecision, type AutoReviewHandoff, type AutoReviewOutcome, type ReviewPublicReply } from '@ricajs/contracts/auto-review'
import type { ModelProvider } from '@ricajs/contracts/model-provider'

const noModel = { status: 'SKIPPED', category: 'MODEL', reason: '部署未配置可用的外部审核模型。' } as const satisfies AutoReviewHandoff

export function createAutoReviewer(useDefaultModel: (review: (model: ModelProvider) => Promise<AutoReviewOutcome>) =>
  Promise<AutoReviewOutcome | null>): ReviewPublicReply {
  return async (settings, reply, attribution, capture) => {
    if (!settings.enabled) return { status: 'SKIPPED', category: 'POLICY', reason: '该角色未启用自动审批。' }
    if (!reply.draft.trim() || !reply.discussion.trim()) return { status: 'SKIPPED', category: 'CONTEXT', reason: '缺少可供审核的回复或讨论上下文。' }
    if (reply.discussion.length > 12_000) return { status: 'SKIPPED', category: 'CONTEXT', reason: '讨论上下文超过自动审核长度上限。' }
    let modelName: string | undefined
    try {
      return (await useDefaultModel(async (model) => {
        if (!model.hostedModel || !model.hostedProvider || !model.review) return noModel
        const name = model.hostedProvider + '/' + model.hostedModel
        modelName = name
        const signal = AbortSignal.timeout(7_000)
        try {
          const capturePrompt = capture ? (prompt: string) => capture(prompt, name) : undefined
          const outcome = await model.review(settings.prompt, reply, signal, attribution, capturePrompt)
          const result = modelReviewDecision.safeParse(outcome)
          if (result.success) return result.data.status === 'REVIEW' ? { ...result.data, category: 'RISK', model: name }
            : { status: 'APPROVE', reason: result.data.reason, model: name }
          return { status: 'UNAVAILABLE', category: 'MODEL', model: modelName, reason: '模型未返回有效的审核结果和复审理由。' }
        } catch {
          return { status: 'UNAVAILABLE', category: 'MODEL', model: modelName,
            reason: signal.aborted ? '模型审核超时。' : '模型调用失败，未能完成审核。' }
        }
      })) ?? noModel
    } catch {
      return { status: 'UNAVAILABLE', category: 'MODEL', model: modelName, reason: '无法使用部署默认模型完成审核。' }
    }
  }
}
