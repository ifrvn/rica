import type { PluginMetadata } from '../../../packages/contracts/plugin-status.js'
import type { NewbiDeploymentView } from '../management.js'
import { newbiDeployment } from '../catalog.js'
import { newbiConsole } from './labels.js'
import NewbiSettings from './NewbiSettings.vue'

export type ConnectorCardStatus = { services: { service: string; catalog: PluginMetadata[] }[]; newbiRegistrationAvailable?: boolean }

export const registrationAvailable = (deployment: NewbiDeploymentView) => ({
  newbiRegistrationAvailable: deployment.plugins.newbi === 'ENABLED' && !!deployment.newbi.endpoint,
})

export const newbiCard = {
  description: newbiConsole.description, upgradeStep: newbiConsole.upgradeStep,
  inlineEditor: true, editor: NewbiSettings, invalidSettings: '请核对本机 API 地址。',
  components: (status?: ConnectorCardStatus) => status?.services.flatMap(({ service, catalog }) =>
    catalog.filter((component) => newbiDeployment.ownsComponent(service, component)).map(({ kind, id, version }) => ({
      id, detail: id, version, label: kind === 'platform-reader'
        ? newbiConsole.capabilityNames['platform-reader'] : newbiConsole.capabilityNames['platform-reply-executor'],
    }))) ?? [],
  summary: ({ newbi }: NewbiDeploymentView) => newbi.endpoint ? '可接入账号' : '等待配置 Agent API',
  configureLabel: ({ newbi }: NewbiDeploymentView) => newbi.endpoint ? '查看 Agent API 设置' : '配置 Agent API',
  editorProps: ({ newbi }: NewbiDeploymentView) => ({ value: newbi.endpoint ?? '' }),
  accountLink: (status?: ConnectorCardStatus) => !!status?.newbiRegistrationAvailable,
  settingsChange: (endpoint: string) => ({ action: 'CONFIGURE_NEWBI', endpoint }),
}
