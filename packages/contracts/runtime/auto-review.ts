import { z } from '@hono/zod-openapi'
import type { CaptureModelCall, ModelAttribution } from './model-provider.js'

export const defaultAutoReviewPrompt = `# 渠道差异化放行标准（严格按传入的 scene 执行）
1. **当渠道为 \`IM_CHAT\`（QQ群 / 微信群等实时群聊）**：
   - **允许高度拟人化与玩梗**：只要不涉及人身攻击、低俗色情或引战，允许口语化短句、网络热梗、自黑及轻松调侃（如“笑死”、“别骂了在改了”、“确实离谱”），此类低风险活跃气氛的回复直接放行。
   - **防范群聊刷屏与抢话**：若前文群友正在聊与产品无关的私人话题，或拟回复内容与前文逻辑完全脱节、无法判断在回复谁，交由人工复审。
   - **虚构承诺红线**：允许插科打诨，但严禁 AI 擅自编造未核实的产品进度、具体补偿方案或内部机密（如“下周三必出新皮肤”、“找我领红包”），一旦出现具体承诺即拦截。

2. **当渠道为 \`PUBLIC_COMMUNITY\`（网站社区 / 论坛 / 公开帖子评论区）**：
   - **公域形象与严谨度**：公开帖子的回复代表官方/运营账号的公开态度。允许友善、热情的互动和适度玩梗，但严禁出现容易被截图断章取义的粗俗词汇、阴阳怪气或过度口语化的敷衍回复。
   - **事实与承诺零容忍**：凡是涉及活动规则、版本时间、功能修改、账号售后等确定性陈述，只要在上下文依据中找不到明确支撑，一律判定为“AI 幻觉编造事实”，交由人工复审。
   - **防误导链接**：严禁 AI 自行生成任何外部网址、联系方式或未经核实的指引路径。

# 全局 AI 失控拦截红线（任何渠道均交由人工复审）
1. **附和负面节奏**：当群聊或帖子前文包含恶意引战、攻击竞品、辱骂官方或敏感违禁话题时，若 AI 拟发送的回复在附和、认同、调侃该负面情绪或变相扩大其影响，必须拦截。
2. **隐私与数据泄露**：回复中包含任何真实手机号、微信号、邮箱、内部测试码或未脱敏的用户信息。
3. **人设穿帮（OOC）**：回复中出现“作为AI”、“语言模型”、“根据我的数据库”等暴露机器身份的词汇，或出现大段生硬的客服套话、分点说教列表。
4. **语义不明或指代错误**：因上下文信息不足，导致无法确认回复对象，或回复内容存在明显逻辑矛盾。`

export const autoReviewInput = z.strictObject({
  enabled: z.boolean(),
  imManualReviewEnabled: z.boolean(),
  templateId: z.uuid().nullable(),
})
const reviewPrompt = z.string().trim().min(1).max(4_000).refine((value) => !value.includes('\0'))
const identityReviewSettings = autoReviewInput.extend({ version: z.number().int().nonnegative() })
const autoReviewModel = z.object({ name: z.string().optional(), provider: z.string(), model: z.string() })
export const autoReviewView = identityReviewSettings.extend({ model: autoReviewModel.nullable() })
export const autoReviewTemplateInput = z.strictObject({
  name: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u),
  prompt: reviewPrompt,
})
export const autoReviewTemplateView = autoReviewTemplateInput.extend({ id: z.uuid(), version: z.number().int().positive() })
export type AutoReviewTemplateView = z.infer<typeof autoReviewTemplateView>
export const autoReviewerId = 'system:auto-review'

export type AutoReviewSettings = z.infer<typeof identityReviewSettings> & { prompt: string }
export type AutoReviewView = z.infer<typeof autoReviewView>
export type PublicReplyReview = Readonly<{
  scene: 'IM_CHAT' | 'PUBLIC_COMMUNITY'
  platform: string
  draft: string
  discussion: string
}>
const reviewReason = z.string().trim().min(1).max(240).regex(/^[^\p{Cc}]+$/u)
export const autoReviewHandoff = z.object({
  status: z.enum(['REVIEW', 'SKIPPED', 'UNAVAILABLE', 'UNKNOWN']),
  category: z.enum(['POLICY', 'CONTEXT', 'MODEL', 'RISK']).optional(),
  reason: reviewReason,
  model: z.string().optional(),
})
export type AutoReviewHandoff = z.infer<typeof autoReviewHandoff>
export const modelReviewRiskCategory = z.enum([
  'AI编造承诺', '附和负面节奏', '指代不明或脱节', '人设穿帮OOC', '公域措辞不当', '隐私或违规链接',
])
export const modelReviewDecision = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('APPROVE'), risk_category: z.literal('无'), reason: z.literal('') }),
  z.strictObject({ decision: z.literal('REVIEW'), risk_category: modelReviewRiskCategory, reason: reviewReason }),
])
export type AutoReviewOutcome = AutoReviewHandoff | { status: 'APPROVE'; model: string; reason?: string }
export type ReviewPublicReply = (settings: AutoReviewSettings, reply: PublicReplyReview, attribution: ModelAttribution,
  capture?: (systemPrompt: string, model: string) => ReturnType<CaptureModelCall>) => Promise<AutoReviewOutcome>

export const autoReviewHandoffLabels = {
  REVIEW: 'AI 建议人工复审', SKIPPED: '未进行 AI 审核', UNAVAILABLE: 'AI 审核未完成',
  UNKNOWN: '自动审批结果未记录',
} satisfies Record<AutoReviewHandoff['status'], string>

const handoffCategoryLabels = {
  POLICY: '策略要求人工核对', CONTEXT: '审核上下文不足', MODEL: '审核模型未能完成', RISK: 'AI 建议人工复审',
} satisfies Record<NonNullable<AutoReviewHandoff['category']>, string>

export function autoReviewHandoffLabel(handoff: AutoReviewHandoff) {
  return handoff.category ? handoffCategoryLabels[handoff.category] : autoReviewHandoffLabels[handoff.status]
}

export const missingAutoReviewHandoff = {
  status: 'UNKNOWN', reason: '此提案暂无可用的自动审批结果，请人工核对。',
} as const satisfies AutoReviewHandoff
