import type { HealthNode } from '@rica/console-shared/health'
import type { PluginReport } from '../../../../packages/contracts/plugin-status.js'
import type { ModelCheckStatus } from '../management/contracts.js'
import { hostedModelCatalog } from '../../providers/catalog.js'
import { hostedModelsPluginId } from '../identity.js'
import { modelCheckLabels } from './labels.js'

export function modelHealth(status: {
  services: { service: string; report: PluginReport | null }[]
  deployment?: { plugins: Record<string, string>; configuredModel: string | null }
  modelCheck?: ModelCheckStatus
} | undefined, external: (id: string, label: string, description: string, configured: boolean) => HealthNode) {
  const deployment = status?.deployment
  if (deployment?.plugins[hostedModelsPluginId] !== 'ENABLED') return { models: [], dependencies: [] }
  const provider = hostedModelCatalog.find(({ id }) => id === deployment.configuredModel)
  const loaded = status?.services.find(({ service }) => service === 'worker')?.report?.plugins
    .some(({ kind, id }) => kind === 'model' && id === hostedModelsPluginId)
  const models: HealthNode[] = [{
    id: hostedModelsPluginId, label: '外部模型写作', description: '由认知 Worker 在公开模拟草稿任务中使用。',
    state: !provider ? '待配置' : loaded ? '插件已载入' : '已配置 · 等待载入',
    tone: provider && loaded ? 'success' : 'default',
  }]
  const dependencies: HealthNode[] = []
  if (provider) {
    const check = status?.modelCheck
    const node = external('model-api-' + provider.id, provider.name + ' API', '在插件中心可用固定消息测试模型连接。', true)
    if (check?.provider === provider.id) {
      node.state = check.status === 'OK' ? '测试通过' : '测试失败'
      node.tone = check.status === 'OK' ? 'success' : 'error'
      node.at = check.checkedAt
      node.description = modelCheckLabels[check.status]
    }
    dependencies.push(node)
  }
  return { models, dependencies }
}
