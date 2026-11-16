import type { z } from '@hono/zod-openapi'
import type { newbiAccountRegistrationView, newbiAccountView, newbiCharacterWorkspaceView } from '@rica/plugin-newbi/contracts'
import { newbiAccounts } from '@rica/plugin-newbi/console/account-integration'

export type ConnectorAccount = z.infer<typeof newbiAccountView>
export type ConnectorRegistration = z.infer<typeof newbiAccountRegistrationView>
export type ConsoleWorkspace = z.infer<typeof newbiCharacterWorkspaceView>

export { registrationAvailable } from '@rica/plugin-newbi/console/card'
export { newbiAuditLabels as pluginAuditLabels } from '@rica/plugin-newbi/console/labels'
export { newbiHealth as platformHealth, isNewbiReadNode as hasAccountHealthLink } from '@rica/plugin-newbi/console/health'

import type { Component } from 'vue'
import { newbiCard, type ConnectorCardStatus } from '@rica/plugin-newbi/console/card'
import { newbiConsole } from '@rica/plugin-newbi/console/labels'
import { newbiReview } from '@rica/plugin-newbi/console/review'
import { createModelCards } from '@rica/plugin-hosted-models/console/cards'
import { modelHealth } from '@rica/plugin-hosted-models/console/health'
import { modelPluginCatalog } from '../../../model-plugin-catalog.js'
import type { DeploymentPluginId, DeploymentPluginsView } from '../../../deployment-plugin-contracts.js'

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

export const pluginCards: Record<DeploymentPluginId, PluginCard> = { [newbiConsole.id]: newbiCard, ...createModelCards(modelPluginCatalog) }
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

const modelNames = Object.fromEntries(modelPluginCatalog.map(({ id, name }) => [id, name])) as
  Record<(typeof modelPluginCatalog)[number]['id'], string>
export const pluginNames: Record<DeploymentPluginId, string> = { [newbiConsole.id]: newbiConsole.name, ...modelNames }
export function hostedModelHealth(status: Parameters<typeof modelHealth>[1], external: Parameters<typeof modelHealth>[2]) {
  return modelHealth(modelPluginCatalog, status, external)
}
export { isSimulationPlatform } from '@rica/contracts/simulation-platform'
