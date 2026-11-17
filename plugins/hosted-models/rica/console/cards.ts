import type { PluginMetadata } from '../../../../packages/contracts/plugin-status.js'
import ModelSettings from './ModelSettings.vue'
import { hostedModelCatalog } from '../../providers/catalog.js'
import { hostedModelsPluginId } from '../identity.js'

type Deployment = { configuredModel: string | null }
type Status = { services: { service: string; catalog: PluginMetadata[] }[] }

export const hostedModelsCard = {
  description: '通过外部模型 API 生成公开模拟草稿', editor: ModelSettings,
  components(status?: Status) {
    const model = status?.services.find(({ service }) => service === 'worker')?.catalog
      .find((component) => component.kind === 'model' && component.id === hostedModelsPluginId)
    return [{ id: hostedModelsPluginId, label: '生成回复草稿', detail: '认知 Worker', version: model?.version }]
  },
  summary({ configuredModel }: Deployment) {
    const provider = hostedModelCatalog.find(({ id }) => id === configuredModel)
    return provider ? '当前提供方 · ' + provider.name : '待配置模型提供方'
  },
  configureLabel: ({ configuredModel }: Deployment) => configuredModel ? '查看 AI API 设置' : '配置 AI API',
  editorProps: () => ({}),
}
