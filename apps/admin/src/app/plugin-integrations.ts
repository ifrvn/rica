import type { z } from '@hono/zod-openapi'
import type { Component } from 'vue'
import type { newbiAccountRegistrationView, newbiAccountView, newbiCharacterWorkspaceView } from '@rica/plugin-newbi/shared'
import { newbiAccounts, newbiCard, newbiConsole, newbiReview, type ConnectorCardStatus } from '@rica/plugin-newbi/console'
import { hostedModelsCard, modelHealth } from '@rica/plugin-hosted-models/console'
import { hostedModelsPluginId } from '@rica/plugin-hosted-models/shared'
import type { DeploymentPluginId, DeploymentPluginsView } from '../../../deployment-plugin-contracts.js'

export type ConnectorAccount = z.infer<typeof newbiAccountView>
export type ConnectorRegistration = z.infer<typeof newbiAccountRegistrationView>
export type ConsoleWorkspace = z.infer<typeof newbiCharacterWorkspaceView>

export {
  registrationAvailable, newbiAuditLabels as pluginAuditLabels,
  newbiHealth as platformHealth, isNewbiReadNode as hasAccountHealthLink,
} from '@rica/plugin-newbi/console'

type PluginCard = {
  description: string; editor: Component; inlineEditor?: boolean; upgradeStep?: string; invalidSettings?: string
  components(status?: ConnectorCardStatus): { id: string; label: string; detail: string; version?: string }[]
  summary(deployment: DeploymentPluginsView): string
  configureLabel(deployment: DeploymentPluginsView): string
  editorProps(deployment: DeploymentPluginsView): object
  accountLink?(status?: ConnectorCardStatus): boolean
  settingsChange?(value: string): unknown
  upgradeQueue?(status?: ConnectorCardStatus): { label: string; status: string; count: number }[] | undefined
}

export const pluginCards: Record<DeploymentPluginId, PluginCard> = { [newbiConsole.id]: newbiCard, [hostedModelsPluginId]: hostedModelsCard }
export const pluginServiceNames = newbiConsole.serviceNames

type AccountBase = Pick<ConnectorAccount, 'id' | 'platform' | 'instanceKey'> & { version?: number; status?: string }
type AccountExtension = AccountBase & Partial<ConnectorAccount & Omit<ConnectorRegistration, 'platform'>>
type AccountIntegration = {
  platform: string; Form: Component; Label: Component; Details: Component
  pauseMessage: string; resumeMessage: string; resumeError: string
  label(account: Partial<ConnectorAccount>): string | undefined
  labelProps(account: AccountExtension): object | undefined
  use(context: {
    base(): string; run(task: () => Promise<void>): Promise<void>; active(): boolean; refresh(): Promise<void>
    clearError(): void; error(message: string): void
  }): {
    sync(status?: ConnectorCardStatus & { deployment?: DeploymentPluginsView }): void
    choices(workspace?: ConsoleWorkspace): { label: string; value: string; disabled?: boolean }[]
    parse(): { success: true; data: object; error?: undefined } | { success: false; error: { issues: readonly { path: PropertyKey[] }[] } }
    formProps(): object
    ready(): boolean
    reset(): void
    registrationError(cause: unknown): string | undefined
    checkingAccount: { value: string | undefined }
    check(account: AccountBase): void
    accountCheckLabel(account: AccountBase): string
    canCheck(account: AccountExtension): boolean
    canRefreshProfile(account: AccountExtension): boolean
    canPropose(account: ConnectorAccount, identityStatus?: string, characterStatus?: string): boolean
  }
}
export const platformAccounts: readonly AccountIntegration[] = [newbiAccounts]
export type ReviewQueue = {
  status: string; label: string
  items: { id: string; title: string; createdAt: string }[]
}
export const platformReviews: readonly {
  id: string; title: string; component: Component
  installed(workspace: ConsoleWorkspace): boolean
  deployed(deployment: DeploymentPluginsView): boolean
  ownsAudit?(operation: string): boolean
  workbench?(characterId: string, canManage: boolean): Promise<ReviewQueue[]>
}[] = [newbiReview]

export const pluginNames: Record<DeploymentPluginId, string> = { [newbiConsole.id]: newbiConsole.name, [hostedModelsPluginId]: '外部模型' }
export { modelHealth as hostedModelHealth }
export { isSimulationPlatform } from '@rica/contracts/simulation-platform'
