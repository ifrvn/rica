import type { PluginMetadata } from '@ricajs/contracts/plugin-status'
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
    return provider ? '默认草稿模型 · ' + provider.name : '未设默认草稿模型'
  },
  configureLabel: () => '配置模型',
  editorProps: (_deployment: Deployment, canStartSimulation: boolean) => ({ canStartSimulation }),
}
