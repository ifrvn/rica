import type { PluginMetadata } from '../../../../packages/contracts/plugin-status.js'
import type { ModelPluginOption } from '@rica/contracts/model-provider'
import ModelSettings from './ModelSettings.vue'

type Deployment = { configuredModel: string | null }
type Status = { services: { service: string; catalog: PluginMetadata[] }[] }

function modelCard(option: ModelPluginOption) {
  const { id, name } = option
  return {
    description: '模型提供方 · 用于公开模拟草稿', editor: ModelSettings,
    components(status?: Status) {
      const model = status?.services.find(({ service }) => service === 'worker')?.catalog
        .find((component) => component.kind === 'model' && component.id === id)
      return [{ id, label: '生成回复草稿', detail: '认知 Worker · ' + name, version: model?.version }]
    },
    summary: (deployment: Deployment) => deployment.configuredModel === id ? '已选为草稿模型' : '已注册到认知 Worker · 待配置',
    configureLabel: (deployment: Deployment) => deployment.configuredModel === id ? '查看 AI API 设置' : '配置 AI API',
    editorProps: () => ({ option }),
  }
}

export function createModelCards<Id extends string>(catalog: readonly (ModelPluginOption & { id: Id })[]) {
  return Object.fromEntries(catalog.map((option) => [option.id, modelCard(option)])) as Record<Id, ReturnType<typeof modelCard>>
}
