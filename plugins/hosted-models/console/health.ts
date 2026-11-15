import type { HealthNode } from '@rica/console-shared/health'
import type { PluginReport } from '../../../packages/contracts/plugin-status.js'
import type { ModelCheckStatus } from '../contracts.js'
import { hostedModelIds, hostedModelNames } from '../catalog.js'
import { modelCheckLabels } from './labels.js'

export function hostedModelHealth(status: {
  services: { service: string; report: PluginReport | null }[]
  deployment?: { plugins: Record<keyof typeof hostedModelNames, string>; configuredModel: string | null }
  modelCheck?: ModelCheckStatus
} | undefined, external: (id: string, label: string, description: string, configured: boolean) => HealthNode) {
  const services = status?.services
  const deployment = status?.deployment
  const loadedModel = services?.find(({ service }) => service === 'worker')?.report?.plugins.find(({ kind }) => kind === 'model')?.id
  const enabledModels = hostedModelIds.filter((id) => deployment?.plugins[id] === 'ENABLED')
  const models: HealthNode[] = enabledModels
    .map((id) => {
      const configured = deployment?.configuredModel === id
      return { id, label: hostedModelNames[id] + ' 写作', description: '由认知 Worker 在公开模拟草稿任务中使用。',
        state: !configured ? '待配置' : loadedModel === id ? '已载入' : '已配置 · 等待载入',
        tone: configured && loadedModel === id ? 'success' : 'default' }
    })
  const dependencies: HealthNode[] = []
  for (const id of enabledModels) {
    const configured = deployment?.configuredModel === id
    const check = status?.modelCheck
    const node = external('model-api-' + id, hostedModelNames[id] + ' API',
      configured ? '在插件中心可用固定消息测试模型连接。' : '在插件中心保存模型 ID 和 API 密钥后即可测试。', configured)
    if (configured && check?.provider === id) {
      node.state = check.status === 'OK' ? '测试通过' : '测试失败'
      node.tone = check.status === 'OK' ? 'success' : 'error'
      node.at = check.checkedAt
      node.description = modelCheckLabels[check.status]
    }
    dependencies.push(node)
  }
  return { models, dependencies }
}
