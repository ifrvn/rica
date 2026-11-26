<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, shallowRef } from 'vue'
import { UiAlert, UiButton, UiDialog, UiEmpty, UiField, UiCombobox, UiSpinner, UiBadge } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import { maxAiDisclosureLength, type characterView, type identityView } from '@ricajs/contracts/management'
import type { PluginStatus } from '../plugins/plugin-status.js'
import CharacterEditorDialog from './CharacterEditorDialog.vue'
import IdentityEditorDialog from './IdentityEditorDialog.vue'
import { isSimulationPlatform, platformAccounts, type ConnectorAccount, type ConnectorRegistration, type ConsoleWorkspace } from '../../app/plugin-integrations.js'
import { request, RequestError } from '@ricajs/console-shared/request'
import { hostedModelCatalog } from '@ricajs/plugin-hosted-models/shared'

type Workspace = ConsoleWorkspace
type Character = z.infer<typeof characterView>
type Identity = z.infer<typeof identityView>
type Account = ConnectorAccount
type Registration = ConnectorRegistration
type Page<T> = { items: T[]; nextCursor: string | null }
type Editor = 'character' | 'core' | 'identity' | 'identity-edit' | 'account' | 'associate' | 'control' | 'linked-account' | 'remove-account'
type AccountControl = { id: string; name: string; status: string; platform: string; revoke?: boolean }

const props = defineProps<{
  characterId: string; canCreate: boolean; accountsOnly?: boolean; accountDetail?: string;
  characters: Character[]; moreCharacters: boolean;
}>()
const emit = defineEmits<{
  created: [character: Workspace]; updated: [character: Character]; expired: [];
  account: [id?: string]; proposals: [platform: string, accountId: string, proposalId?: string]; selectCharacter: [id: string]; loadCharacters: [];
}>()
const workspace = ref<Workspace>()
const draftModelStatus = ref<PluginStatus>()
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const accountPool = ref<Registration[]>([])
const removingAccount = ref<Registration>()
const connectors = platformAccounts.map((plugin) => ({ plugin, state: plugin.use({
  base: () => base.value, run, active: () => active, refresh: load,
  error: (message) => { error.value = message }, clearError: () => { error.value = ''; pending = undefined },
}) }))
const connectorFor = (platform?: string) => connectors.find(({ plugin }) => plugin.platform === platform)
const registrationConnector = computed(() => connectorFor(form.platform))
const platformChoices = computed(() => [
  ...(workspace.value?.simulationPlatforms ?? []).map(value => ({ label: value, value })),
  ...connectors.flatMap(({ state }) => state.choices(workspace.value)),
])
const editor = ref<Editor>()
const editingIdentity = ref<Identity>()
const editingCore = ref<Workspace>()
const target = ref<AccountControl>()
const linkedAccount = ref<Account>()
const busy = ref(false)
const error = ref('')
const notice = ref('')
const form = reactive({ slug: '', name: '', timezone: '', disclosure: '', style: 'neutral',
  registrationId: null as string | null, platform: '', instance: '', remoteId: '', reason: '', writingPrompt: '',
  draftModelProfile: '', participation: '', groupChat: false })
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const admin = computed(() => !!workspace.value)
const connector = computed(() => accounts.value.find(({ id, platform }) => id === props.accountDetail && connectorFor(platform)))
const connectorDetails = computed(() => connectorFor(connector.value?.platform))
const connectorIdentity = computed(() => identities.value.find(({ id }) => id === connector.value?.identityId))
const canProposeConnectorReply = computed(() => !!admin.value && !!connector.value
  && connectorDetails.value?.state.canPropose(connector.value, connectorIdentity.value?.status, workspace.value?.status))
const isCharacter = computed(() => editor.value === 'character' || editor.value === 'core')
const isIdentity = computed(() => editor.value === 'identity' || editor.value === 'identity-edit')
const draftModels = computed(() => (draftModelStatus.value?.modelProfiles ?? []).map(({ id, name, provider, model }) => ({
  id, label: [name, hostedModelCatalog.find((option) => option.id === provider)?.name ?? provider, model].join(' · '),
})))
const defaultDraftModel = computed(() => draftModels.value.find(({ id }) => id === draftModelStatus.value?.defaultModelProfileId))
const title = computed(() => ({
  character: '新建角色', core: '角色设置', identity: '添加身份', 'identity-edit': '编辑身份',
  account: '添加账号', associate: '关联平台账号',
  'linked-account': '已关联的平台账号', 'remove-account': '移除账号',
  control: target.value?.revoke ? '撤销账号' : target.value?.status === 'ACTIVE' ? '暂停账号' : '恢复账号',
})[editor.value ?? 'character'])
const workspaceHeading = ref<HTMLElement>()
const accountControlSummary = ref<HTMLElement>()
const accountsByIdentity = computed(() => {
  const groups = new Map<string, Account[]>()
  for (const account of accounts.value) {
    if (account.status === 'REVOKED') continue
    const group = groups.get(account.identityId) ?? []
    group.push(account)
    groups.set(account.identityId, group)
  }
  return groups
})

const identityName = (identity: Identity) => identity.profile?.displayName || identity.slug
const boundAccountLabel = (account: Account) => connectorFor(account.platform)?.plugin.label(account) ?? account.platform + ' · ' + account.instanceKey

function accountControl(account: Account, revoke = false) {
  const fromLinkedAccount = editor.value === 'linked-account'
  open('control', undefined, { id: account.id, name: boundAccountLabel(account),
    status: account.status, platform: account.platform, revoke })
  if (fromLinkedAccount) void nextTick(() => accountControlSummary.value?.focus())
}
const schemas = shallowRef<{
  management: typeof import('@ricajs/contracts/management')
}>()

async function loadSchemas() {
  if (schemas.value) return
  const management = await import('@ricajs/contracts/management')
  if (active) schemas.value = { management }
}
const attempted = ref(false)
const touched = ref(new Set<string>())
const parsed = computed(() => {
  if (!schemas.value) return
  const { accountBindingInput, characterInput, controlInput, coreInput, identityInput, identityUpdate, simulationAccountRegistration } = schemas.value.management
  const reason = form.reason.trim() || undefined
  const coreProfile = { ...editingCore.value?.profile, name: form.name.trim() || undefined, aiDisclosure: form.disclosure.trim() }
  const roleProfile = { ...editingIdentity.value?.profile, displayName: form.name.trim() || undefined,
    timezone: form.timezone || undefined, writingStyle: form.style, writingPrompt: form.writingPrompt.trim() || undefined,
    draftModelProfile: form.draftModelProfile || undefined, participation: form.participation || undefined,
    groupChat: form.groupChat || undefined }
  switch (editor.value) {
    case 'character': return characterInput.safeParse({ slug: form.slug.trim(), timezone: form.timezone, coreProfile })
    case 'core': return coreInput.safeParse({ coreProfile, reason })
    case 'identity': return identityInput.safeParse({ slug: form.slug.trim(), roleProfile })
    case 'identity-edit': return identityUpdate.safeParse({ roleProfile, reason })
    case 'account': return registrationConnector.value
      ? registrationConnector.value.state.parse()
      : simulationAccountRegistration.safeParse({
      platform: form.platform, instanceKey: form.instance.trim(), remoteAccountId: form.remoteId.trim(),
    })
    case 'associate': return accountBindingInput.safeParse({
      registrationId: form.registrationId, identityId: editingIdentity.value?.id,
    })
    case 'control': {
      const item = target.value
      if (item) return controlInput.safeParse({ scope: 'ACCOUNT', scopeId: item.id, reason,
        operation: item.revoke ? 'REVOKE_ACCOUNT' : item.status === 'ACTIVE' ? 'PAUSE' : 'RESUME' })
    }
  }
})
const validationMessages: Record<string, string> = {
  slug: '使用小写字母或数字开头，最多 63 个字符，可含连字符。',
  name: '请输入不超过 120 个字符的名称。',
  timezone: '请选择可用的时区。',
  disclosure: `请输入有效的角色核心设定，最多 ${maxAiDisclosureLength} 个字符。`,
  style: '请选择写作风格。',
  writingPrompt: '提示词最多 4000 个字符，可分行填写。',
  registrationId: '请选择要关联的平台账号。',
  platform: '请选择模拟平台。',
  instance: '请检查实例名称。',
  remote: '请检查账号标识。',
  reason: '变更原因最多 240 个字符。',
}
const fieldByPath: Record<string, string> = {
  displayName: 'name', aiDisclosure: 'disclosure', writingStyle: 'style',
  instanceKey: 'instance', remoteAccountId: 'remote',
}
const invalidFields = computed(() => new Set(parsed.value?.error?.issues.map(({ path }) => {
  const field = String(path.at(-1))
  return fieldByPath[field] ?? field
})))

function fieldError(field: string) {
  return invalidFields.value.has(field) && (attempted.value || touched.value.has(field)) ? validationMessages[field] : undefined
}

function fieldInput(field: string, hintId?: string) {
  const id = 'workspace-' + field
  const invalid = !!fieldError(field)
  const describedBy = [hintId, invalid ? id + '-error' : undefined].filter(Boolean).join(' ')
  return { id, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy || undefined }
}

function resetAccountEditor() {
  connectors.forEach(({ state }) => state.reset())
  error.value = ''
  pending = undefined
}

function closeEditor() {
  removingAccount.value = undefined
  connectors.forEach(({ state }) => state.reset())
  pending = undefined
  editor.value = undefined
}

function focusWorkspaceHeading() {
  if (active && !editor.value && document.activeElement === document.body) workspaceHeading.value?.focus()
}

let pending: { signature: string; key: string } | undefined
let active = true
onBeforeUnmount(() => { active = false })

function accountLabel(account: Pick<Registration, 'instanceKey'> & { platform: string; remoteAccountId?: string }) {
  const label = connectorFor(account.platform)?.plugin.label(account as Partial<Account>)
  if (label) return label
  return [account.platform, account.instanceKey, account.remoteAccountId].filter(Boolean).join(' · ')
}

function status(value: string) {
  const labels: Record<string, string> = {
    ACTIVE: '运行中', PAUSED: '已暂停', PENDING: '待启用', REVOKED: '已撤销', REAUTH_REQUIRED: '需要重新授权',
  }
  return labels[value] ?? value
}

function stateAction(value: string) {
  return value === 'ACTIVE' ? '暂停' : value === 'PAUSED' ? '恢复' : '启用'
}

async function all<T>(path: string) {
  const items: T[] = []
  let cursor: string | null = null
  do {
    const page: Page<T> = await request(path + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor && active)
  return items
}

async function load() {
  if (!props.characterId) return
  const current = await request<Workspace>(base.value)
  const [nextIdentities, nextAccounts, pool, pluginStatus] = await Promise.all([
    all<Identity>(base.value + '/identities'), all<Account>(base.value + '/accounts'),
    all<Registration>(base.value + '/account-pool'),
    request<PluginStatus>(base.value + '/plugins').catch((cause) => {
      if (cause instanceof RequestError && cause.status === 401) throw cause
      return undefined
    }),
  ])
  if (!active) return
  workspace.value = current
  identities.value = nextIdentities
  accounts.value = nextAccounts
  accountPool.value = pool
  draftModelStatus.value = pluginStatus
  connectors.forEach(({ state }) => state.sync(pluginStatus))
  emit('updated', current)
}

async function run(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await task()
  } catch (cause) {
    if (!active) return
    const code = cause instanceof RequestError ? cause.status : 0
    if (code === 401) {
      emit('expired')
      return
    }
    if (cause instanceof RequestError && cause.code === 'IDENTITY_ALREADY_BOUND') {
      error.value = '该身份已有平台账号。撤销原账号后可重新关联。'
      return
    }
    if (cause instanceof RequestError && cause.code === 'ACCOUNT_ALREADY_BOUND' && editor.value === 'remove-account') {
      error.value = '该账号已关联身份。请取消操作并刷新账号池。'
      return
    }
    if (editor.value === 'account' && registrationConnector.value) {
      const message = registrationConnector.value.state.registrationError(cause)
      if (message) { error.value = message; return }
    }
    const targetConnector = connectorFor(target.value?.platform)
    if (code === 409 && targetConnector && target.value?.status === 'PAUSED' && !target.value.revoke) {
      error.value = targetConnector.plugin.resumeError
      return
    }
    error.value = ({
      403: '当前账号无权执行此操作。', 404: '当前角色或资源不可访问。', 409: '操作冲突，请核对当前状态。',
      412: '配置已被更新。请保留本次输入，取消编辑后刷新页面再核对。', 422: '服务器无法接受当前输入，请核对后重试。',
    } as Record<number, string>)[code] ?? '操作未完成，请重试。'
  } finally {
    busy.value = false
  }
}

function open(kind: Editor, identity?: Identity, resource?: AccountControl) {
  attempted.value = false
  touched.value.clear()
  editor.value = kind
  editingIdentity.value = identity
  editingCore.value = kind === 'core' ? workspace.value : undefined
  target.value = resource
  const core = editingCore.value?.profile
  pending = undefined
  connectors.forEach(({ state }) => state.reset())
  error.value = ''
  notice.value = ''
  Object.assign(form, { slug: '', name: core?.name ?? identity?.profile?.displayName ?? '',
    timezone: kind === 'character' ? Intl.DateTimeFormat().resolvedOptions().timeZone : identity?.profile?.timezone ?? '',
    disclosure: core?.aiDisclosure ?? '', style: identity?.profile?.writingStyle ?? 'neutral',
    writingPrompt: identity?.profile?.writingPrompt ?? '',
    draftModelProfile: identity?.profile?.draftModelProfile ?? '',
    participation: identity?.profile?.participation ?? '', groupChat: identity?.profile?.groupChat ?? false,
    registrationId: null, platform: '',
    instance: 'local', remoteId: '', reason: '' })
  void loadSchemas().catch(() => {})
}

function openLinkedAccount(account: Account) {
  linkedAccount.value = account
  open('linked-account')
}

function confirmRemoveAccount(account: Registration) {
  removingAccount.value = account
  open('remove-account')
}

function removeAccount() {
  const account = removingAccount.value
  if (!account || !admin.value || busy.value) return
  const path = base.value + '/account-pool/' + account.id
  if (pending?.signature !== path) pending = { signature: path, key: crypto.randomUUID() }
  const key = pending.key
  void run(async () => {
    await request(path, { method: 'DELETE', headers: { 'Idempotency-Key': key } })
    if (!active) return
    accountPool.value = accountPool.value.filter(({ id }) => id !== account.id)
    closeEditor()
    notice.value = '已从账号池移除。'
  })
}

function command(path: string, data: object, version?: number) {
  const body = JSON.stringify(data)
  const signature = JSON.stringify([path, body])
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (version === undefined) {
    if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
    headers['Idempotency-Key'] = pending.key
  } else {
    headers['If-Match'] = '"' + version + '"'
  }
  return request<{ id: string }>(path, { method: version === undefined ? 'POST' : 'PUT', headers, body })
}

function changeState(scope: 'CHARACTER' | 'IDENTITY', item: Character | Identity, name: string) {
  const action = stateAction(item.status)
  const pause = item.status === 'ACTIVE'
  const status = pause ? 'PAUSED' : 'ACTIVE'
  const characterId = scope === 'CHARACTER' ? item.id : props.characterId
  void run(async () => {
    await command('/v1/characters/' + encodeURIComponent(characterId) + '/controls', {
      scope, scopeId: item.id, operation: pause ? 'PAUSE' : 'RESUME',
    })
    if (!active) return
    pending = undefined
    if (scope === 'CHARACTER') {
      if (workspace.value?.id === item.id) workspace.value = { ...workspace.value, status }
      const character = props.characters.find(({ id }) => id === item.id)
      if (character) emit('updated', { ...character, status })
    } else {
      identities.value = identities.value.map((identity) => identity.id === item.id ? { ...identity, status } : identity)
    }
    notice.value = `已${action}${scope === 'CHARACTER' ? '角色' : '身份'}「${name}」。`
  })
}

async function save() {
  await run(async () => {
    await loadSchemas()
    if (!active) return
    attempted.value = true
    const input = parsed.value
    if (!input?.success) {
      await nextTick()
      const first = document.querySelector<HTMLElement>('.workspace-editor [aria-invalid="true"]')
      if (first) first.focus()
      else error.value = '请核对当前配置后重试。'
      return
    }
    const kind = editor.value
    const current = editingCore.value
    const identity = editingIdentity.value
    if (kind === 'character') {
      const result = await command('/v1/characters', input.data)
      if (!active) return
      const created = await request<Workspace>('/v1/characters/' + encodeURIComponent(result.id))
      if (active) emit('created', created)
    } else if (kind === 'core' && current?.version != null) {
      await command(base.value + '/core', input.data, current.version)
    } else if (kind === 'identity') {
      await command(base.value + '/identities', input.data)
    } else if (kind === 'identity-edit' && identity?.version != null) {
      await command(base.value + '/identities/' + identity.id, input.data, identity.version)
    } else if (kind === 'account') {
      await command(base.value + '/account-pool', input.data)
    } else if (kind === 'associate') {
      await command(base.value + '/account-pool/associations', input.data)
    } else if (kind === 'control') {
      await command(base.value + '/controls', input.data)
    } else return
    if (!active) return
    const label = title.value
    pending = undefined
    closeEditor()
    notice.value = kind === 'associate' ? '账号已关联，当前为暂停状态。' : label + '成功。'
    if (kind !== 'character') await load()
  })
}

onMounted(() => { if (props.characterId) void run(load) })
</script>

<template>
  <div class="character-workspace">
    <UiAlert v-if="error && !editor" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
    <CharacterEditorDialog :open="isCharacter" :creating="editor === 'character'"
      v-model:slug="form.slug" v-model:name="form.name" v-model:timezone="form.timezone"
      v-model:disclosure="form.disclosure" v-model:reason="form.reason"
      :busy="busy" :error="error" :field-error="fieldError" :field-input="fieldInput"
      @touch="touched.add($event)" @save="save" @close="closeEditor" @closed="focusWorkspaceHeading" />
    <IdentityEditorDialog :open="isIdentity" :creating="editor === 'identity'"
      v-model:slug="form.slug" v-model:name="form.name" v-model:timezone="form.timezone" v-model:writing-style="form.style"
      v-model:draft-model-profile="form.draftModelProfile" v-model:participation="form.participation"
      v-model:writing-prompt="form.writingPrompt" v-model:reason="form.reason" v-model:group-chat="form.groupChat"
      :inherited-timezone="workspace?.timezone ?? 'UTC'" :draft-models="draftModels" :default-draft-model="defaultDraftModel"
      :max-writing-prompt-length="schemas?.management.maxIdentityWritingPromptLength"
      :busy="busy" :error="error" :field-error="fieldError" :field-input="fieldInput"
      @touch="touched.add($event)" @save="save" @close="closeEditor" @closed="focusWorkspaceHeading" />
    <UiDialog id="character-workspace-editor" class="workspace-editor" :open="!!editor && !isCharacter && !isIdentity"
      :title="title" :busy="busy" @update:open="!$event && closeEditor()" @closed="focusWorkspaceHeading">
      <UiAlert v-if="error" class="editor-alert" tone="error" role="alert">{{ error }}</UiAlert>
      <p v-if="editor === 'control' && target" ref="accountControlSummary" tabindex="-1">{{ target.name }} · {{ status(target.status) }}</p>
      <p v-if="target?.revoke">撤销后，原账号不能恢复，可为该身份关联其他账号。历史记录仍可查看。</p>
      <p v-else-if="connectorFor(target?.platform)">{{ target?.status === 'ACTIVE' ? connectorFor(target?.platform)?.plugin.pauseMessage
          : connectorFor(target?.platform)?.plugin.resumeMessage }}</p>
      <template v-if="editor === 'linked-account' && linkedAccount">
        <p>{{ boundAccountLabel(linkedAccount) }} · {{ status(linkedAccount.status) }}</p>
        <div class="editor-actions">
          <UiButton v-if="['ACTIVE', 'PAUSED'].includes(linkedAccount.status)" variant="soft"
            :tone="linkedAccount.status === 'ACTIVE' ? 'warning' : 'default'" @click="accountControl(linkedAccount)">
            {{ linkedAccount.status === 'ACTIVE' ? '暂停账号' : '恢复账号' }}
          </UiButton>
          <UiButton tone="error" @click="accountControl(linkedAccount, true)">撤销账号</UiButton>
          <UiButton @click="closeEditor">关闭</UiButton>
        </div>
      </template>
      <template v-else-if="editor === 'remove-account' && removingAccount">
        <p class="remove-account-name">{{ accountLabel(removingAccount) }}</p>
        <p>移除后，如需使用此账号，可以重新添加。</p>
        <div class="editor-actions">
          <UiButton :disabled="busy" @click="closeEditor">取消</UiButton>
          <UiButton tone="error" :loading="busy" :disabled="busy" @click="removeAccount">确认移除</UiButton>
        </div>
      </template>
      <form v-else @submit.prevent="save">
        <template v-if="editor === 'account'">
          <UiField label="平台" for="workspace-platform" :invalid="!!fieldError('platform')">
            <UiCombobox placeholder="选择平台" v-model="form.platform" :input-attrs="fieldInput('platform')"
              :disabled="busy" :options="platformChoices" @update:model-value="resetAccountEditor" @blur="touched.add('platform')" />
            <template v-if="fieldError('platform')" #feedback>
              <span id="workspace-platform-error">{{ fieldError('platform') }}</span>
            </template>
          </UiField>
          <template v-if="registrationConnector">
            <component :is="registrationConnector.plugin.Form" v-bind="registrationConnector.state.formProps()" :busy="busy" />
          </template>
          <template v-else-if="form.platform">
          <UiField label="实例标识" for="workspace-instance" :invalid="!!fieldError('instance')">
            <input class="ui-control" placeholder="例如：sandbox" v-model="form.instance" v-bind="fieldInput('instance')"
              @blur="touched.add('instance')" :maxlength="120" />
            <template v-if="fieldError('instance')" #feedback>
              <span id="workspace-instance-error">{{ fieldError('instance') }}</span>
            </template>
          </UiField>
          <UiField label="模拟平台账号标识" for="workspace-remote" :invalid="!!fieldError('remote')">
            <input class="ui-control" placeholder="例如：demo-account" v-model="form.remoteId" v-bind="fieldInput('remote')" @blur="touched.add('remote')" maxlength="240" />
            <template v-if="fieldError('remote')" #feedback>
              <span id="workspace-remote-error">{{ fieldError('remote') }}</span>
            </template>
          </UiField>
          </template>
        </template>
        <template v-if="editor === 'associate'">
          <p>关联到 {{ editingIdentity && identityName(editingIdentity) }}</p>
          <p v-if="!accountPool.length" class="workspace-muted">账号池暂无可关联账号，请先登记账号。</p>
          <UiField v-else label="平台账号" for="workspace-registrationId"
            :invalid="!!fieldError('registrationId')">
            <UiCombobox v-model="form.registrationId" placeholder="从账号池选择未关联账号"
              :input-attrs="fieldInput('registrationId')" @blur="touched.add('registrationId')"
              :options="accountPool.map(item => ({ label: accountLabel(item), value: item.id }))" />
            <template v-if="fieldError('registrationId')" #feedback>
              <span id="workspace-registrationId-error">{{ fieldError('registrationId') }}</span>
            </template>
          </UiField>
        </template>
        <UiField v-if="editor === 'control'" label="变更原因说明（可选）"
          for="workspace-reason" :invalid="!!fieldError('reason')">
          <input class="ui-control" placeholder="例如：维护期间暂停运行" v-model="form.reason" v-bind="fieldInput('reason')" @blur="touched.add('reason')" maxlength="240" />
          <template v-if="fieldError('reason')" #feedback>
            <span id="workspace-reason-error">{{ fieldError('reason') }}</span>
          </template>
        </UiField>
        <div class="editor-actions">
          <UiButton :tone="target?.revoke ? 'error' : target?.status === 'ACTIVE' ? 'warning' : 'primary'"
            type="submit" :loading="busy" :disabled="busy || (editor === 'associate' && !accountPool.length)
              || (editor === 'account' && (!form.platform || (registrationConnector && !registrationConnector.state.ready())))">
            {{ editor === 'account' ? '确定' : title }}
          </UiButton>
          <UiButton :disabled="busy" @click="closeEditor">取消</UiButton>
        </div>
      </form>
    </UiDialog>
    <div v-if="!accountsOnly" class="workspace-card" :class="{ 'character-columns': characters.length }">
      <section class="character-list" aria-labelledby="characters-heading">
        <div class="console-section-heading">
          <h3 id="characters-heading">角色</h3>
          <UiButton v-if="canCreate" size="small" :tone="characters.length ? 'default' : 'primary'" :disabled="busy" @click="open('character')">新建角色</UiButton>
        </div>
        <UiEmpty v-if="!characters.length" :description="canCreate ? '尚未创建角色。' : '当前账号没有可访问的角色。'" />
        <ul v-else class="record-list">
          <li v-for="character in characters" :key="character.id" class="record-row" :class="{ 'role-selected': character.id === characterId }">
            <div class="record-header">
              <button type="button" class="record-name role-select" :disabled="busy" :aria-pressed="character.id === characterId"
                @click="emit('selectCharacter', character.id)">{{ character.profile?.name || character.slug }}</button>
              <UiBadge class="record-status" :tone="character.status === 'ACTIVE' ? 'success' : 'warning'">{{ status(character.status) }}</UiBadge>
              <button v-if="character.id === characterId && admin && workspace?.version" class="row-icon-button record-settings" type="button"
                :aria-label="'设置角色 ' + (character.profile?.name || character.slug)" title="设置角色"
                :disabled="busy" @click="open('core')">
                <span class="i-lucide-settings" aria-hidden="true" />
              </button>
              <button v-if="character.version != null" class="row-icon-button record-control" type="button" :aria-disabled="busy"
                :aria-label="stateAction(character.status) + '角色 ' + (character.profile?.name || character.slug)"
                :title="stateAction(character.status) + '角色'"
                @click="changeState('CHARACTER', character, character.profile?.name || character.slug)">
                <span :class="character.status === 'ACTIVE' ? 'i-lucide-pause' : 'i-lucide-play'" aria-hidden="true" />
              </button>
            </div>
            <span class="role-note workspace-muted">{{ character.profile?.aiDisclosure || character.timezone }}</span>
          </li>
        </ul>
        <UiButton v-if="moreCharacters" variant="text" size="small" :disabled="busy" @click="emit('loadCharacters')">加载更多角色</UiButton>
      </section>
      <section v-if="characters.length" class="identity-list" aria-labelledby="identities-heading">
        <div class="console-section-heading">
          <h3 id="identities-heading" ref="workspaceHeading" tabindex="-1">{{ workspace ? (workspace.profile?.name || workspace.slug) + '的身份' : '身份' }}</h3>
          <div v-if="workspace" class="workspace-actions">
            <span class="workspace-muted">{{ identities.length }} 个身份</span>
            <UiButton v-if="admin" size="small" tone="primary" :disabled="busy" @click="open('identity')">添加身份</UiButton>
          </div>
        </div>
        <UiSpinner v-if="busy && !workspace" aria-label="正在加载身份" />
        <UiButton v-else-if="!workspace && characterId && error && !editor" size="small" @click="run(load)">重新加载</UiButton>
        <UiEmpty v-else-if="!identities.length" :description="workspace ? '尚未添加身份。' : '选择角色后查看身份。'" />
        <ul v-else class="record-list">
          <li v-for="identity in identities" :key="identity.id" class="record-row">
            <div class="record-header">
              <strong class="record-name">{{ identityName(identity) }}</strong>
              <UiBadge class="record-status" :tone="identity.status === 'ACTIVE' ? 'success' : 'warning'">{{ status(identity.status) }}</UiBadge>
              <button v-if="admin && identity.version" class="row-icon-button record-settings" type="button"
                :aria-label="'编辑身份 ' + identityName(identity)" title="编辑身份" :disabled="busy" @click="open('identity-edit', identity)">
                <span class="i-lucide-settings" aria-hidden="true" />
              </button>
              <button v-if="admin && identity.version != null" class="row-icon-button record-control" type="button" :aria-disabled="busy"
                :aria-label="stateAction(identity.status) + '身份 ' + identityName(identity)" :title="stateAction(identity.status) + '身份'"
                @click="changeState('IDENTITY', identity, identityName(identity))">
                <span :class="identity.status === 'ACTIVE' ? 'i-lucide-pause' : 'i-lucide-play'" aria-hidden="true" />
              </button>
            </div>
            <div v-if="accountsByIdentity.has(identity.id)" class="workspace-actions">
              <template v-for="account in accountsByIdentity.get(identity.id)" :key="account.id">
                <UiButton v-if="admin" variant="text" tone="primary" :disabled="busy" @click="openLinkedAccount(account)">{{ boundAccountLabel(account) }}</UiButton>
                <span v-else>{{ boundAccountLabel(account) }}</span>
              </template>
            </div>
            <div v-else class="workspace-row">
              <span class="workspace-muted">未关联平台账号</span>
              <UiButton v-if="admin" size="small" :disabled="busy" @click="open('associate', identity)">关联账号</UiButton>
            </div>
          </li>
        </ul>
      </section>
    </div>
    <UiSpinner v-else-if="busy && !workspace" />
    <UiButton v-else-if="!workspace && characterId && error && !editor" size="small" @click="run(load)">重新加载</UiButton>
    <template v-else-if="workspace">
      <section class="workspace-card" aria-labelledby="platform-accounts-heading">
        <div class="console-section-heading">
          <h3 id="platform-accounts-heading" :ref="(node) => { if (accountsOnly) workspaceHeading = node as HTMLElement | undefined }" tabindex="-1">平台账号池</h3>
          <div v-if="admin || accountsOnly" class="workspace-actions">
            <UiButton v-if="admin" size="small" tone="primary" :disabled="busy || !platformChoices.length"
              @click="open('account')">添加账号</UiButton>
            <UiButton v-if="accountsOnly" variant="text" :disabled="busy" @click="run(load)">刷新账号</UiButton>
          </div>
        </div>
        <UiAlert v-if="admin && !workspace.simulationPlatforms.length" tone="warning">当前部署未启用模拟适配器。</UiAlert>
        <ul v-if="accountPool.length" class="workspace-list">
          <li v-for="item in accountPool" :key="item.id" class="workspace-row">
            <div class="account-summary">
              <component v-if="connectorFor(item.platform)?.plugin.labelProps(item)" :is="connectorFor(item.platform)?.plugin.Label"
                v-bind="connectorFor(item.platform)?.plugin.labelProps(item)" />
              <span v-else>{{ accountLabel(item) }}</span>
              <p v-if="connectorFor(item.platform)?.state.accountCheckLabel(item)" class="workspace-muted account-check" role="status">{{ connectorFor(item.platform)?.state.accountCheckLabel(item) }}</p>
            </div>
            <div class="workspace-actions">
              <UiBadge>未关联</UiBadge>
              <UiButton v-if="admin && connectorFor(item.platform)?.state.canRefreshProfile(item)"
                size="small" variant="soft" :disabled="busy" @click="connectorFor(item.platform)?.state.check(item)">核验并更新资料</UiButton>
              <UiButton v-if="admin" size="small" tone="error" variant="soft" :disabled="busy" @click="confirmRemoveAccount(item)">移除账号</UiButton>
            </div>
          </li>
        </ul>
        <UiEmpty v-if="!accounts.length && !accountPool.length" description="暂无平台账号。" />
        <ul v-if="accounts.length" class="workspace-list">
          <li v-for="account in accounts" :key="account.id" class="workspace-row">
            <div class="account-summary">
              <div class="workspace-actions">
              <component v-if="connectorFor(account.platform)?.plugin.labelProps(account)" :is="connectorFor(account.platform)?.plugin.Label"
                v-bind="connectorFor(account.platform)?.plugin.labelProps(account)" />
              <strong v-else>{{ boundAccountLabel(account) }}</strong>
              <UiBadge>{{ status(account.status) }}</UiBadge>
              </div>
              <span class="workspace-muted">{{ workspace.profile?.name || workspace.slug }} / {{
                identities.find(item => item.id === account.identityId)?.profile?.displayName
                  || identities.find(item => item.id === account.identityId)?.slug || '身份不可用'
              }}</span>
              <p v-if="connectorFor(account.platform)?.state.accountCheckLabel(account)" class="workspace-muted account-check" role="status">{{ connectorFor(account.platform)?.state.accountCheckLabel(account) }}</p>
            </div>
            <div class="workspace-actions">
              <UiButton v-if="admin && connectorFor(account.platform)?.state.canCheck(account)"
                size="small" variant="soft" :disabled="busy" :loading="connectorFor(account.platform)?.state.checkingAccount.value === account.id"
                @click="connectorFor(account.platform)?.state.check(account)">核验连接</UiButton>
              <UiButton v-if="admin && connectorFor(account.platform)" size="small"
                @click="emit('account', account.id)">查看读取状态</UiButton>
              <UiButton v-if="admin && (connectorFor(account.platform) || isSimulationPlatform(account.platform)) && ['ACTIVE', 'PAUSED'].includes(account.status)"
                size="small" :tone="account.status === 'ACTIVE' ? 'warning' : 'default'" variant="soft" :disabled="busy" @click="accountControl(account)">
                {{ account.status === 'ACTIVE' ? '暂停账号' : '恢复账号' }}
              </UiButton>
              <UiButton v-if="admin && account.status !== 'REVOKED'"
                size="small" tone="error" :disabled="busy" @click="accountControl(account, true)">
                撤销账号
              </UiButton>
            </div>
          </li>
        </ul>
      </section>
      <component v-if="connector && connectorDetails && admin" :is="connectorDetails.plugin.Details" :key="connector.id + '/' + connector.version"
        :character-id="characterId" :account-id="connector.id" :account-status="connector.status" :can-review="!!admin"
        :account-label="boundAccountLabel(connector)" :identity-label="connectorIdentity ? identityName(connectorIdentity) : '身份不可用'"
        :can-propose="canProposeConnectorReply"
        @expired="emit('expired')" @proposals="(accountId: string, proposalId?: string) => emit('proposals', connector!.platform, accountId, proposalId)" />
      <UiAlert v-else-if="accountDetail" tone="warning">找不到当前角色的连接器账号。</UiAlert>
    </template>
  </div>
</template>

<style scoped>
.character-workspace { display: grid; gap: 1.25rem; min-width: 0; }
.account-check { margin: 0; }
.workspace-card { min-width: 0; padding: 1rem; background: var(--console-surface); border: 1px solid var(--console-line); border-radius: 5px; }
.character-columns { display: grid; grid-template-columns: minmax(12rem, 2fr) minmax(0, 3fr); align-items: start; }
.character-list, .identity-list { min-width: 0; }
.character-columns .character-list { padding-inline-end: 1rem; }
.identity-list { padding-inline-start: 1rem; border-inline-start: 1px solid var(--console-line); }
.character-columns .console-section-heading { align-items: center; min-block-size: 2rem; }
.record-list { --record-action-size: 2rem; list-style: none; margin: 0; padding: 0; }
.record-row { display: grid; gap: .25rem; padding: .5rem .625rem; border-block-start: 1px solid var(--console-line); }
.record-header { display: grid; grid-template-columns: minmax(0, 1fr) max-content repeat(2, var(--record-action-size));
  grid-template-areas: "name status settings control"; align-items: center; gap: .25rem; min-block-size: var(--record-action-size); }
.role-select, .row-icon-button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; border-radius: 4px; }
.role-select { align-self: stretch; padding: 0; text-align: start; }
.role-select:enabled:hover, .row-icon-button:enabled:not([aria-disabled="true"]):hover { background: var(--console-hover); }
.role-select:focus-visible, .row-icon-button:focus-visible { outline: 2px solid var(--console-accent-text); outline-offset: 1px; }
.role-selected { background: var(--console-selected); }
.record-name { grid-area: name; font-weight: 650; overflow-wrap: anywhere; }
.record-status { grid-area: status; }
.record-settings { grid-area: settings; }
.record-control { grid-area: control; }
.role-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-icon-button { display: grid; place-items: center; inline-size: var(--record-action-size); block-size: var(--record-action-size); padding: 0; }
.row-icon-button[aria-disabled="true"] { cursor: wait; opacity: .6; }
.workspace-muted { color: var(--console-muted); font-size: .8125rem; }
.account-summary { display: grid; gap: .5rem; }
.remove-account-name { overflow-wrap: anywhere; }
.workspace-list > li { padding-block: .625rem; }
.workspace-actions, .workspace-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.workspace-row { justify-content: space-between; overflow-wrap: anywhere; }
.workspace-list { list-style: none; margin: 0; padding: 0; }
.workspace-list > li + li { border-top: 1px solid var(--console-line); margin-top: .5rem; padding-top: .5rem; }
@media (max-width: 42rem) {
  .character-columns { grid-template-columns: minmax(0, 1fr); }
  .character-columns .character-list { padding-inline-end: 0; }
  .identity-list { padding-inline-start: 0; padding-block-start: 1rem; margin-block-start: 1rem; border-inline-start: 0; border-block-start: 1px solid var(--console-line); }
}
@media (pointer: coarse) {
  .record-list { --record-action-size: 2.75rem; }
}
</style>

<style>
.workspace-editor { overscroll-behavior: contain; }
.workspace-editor .editor-alert { margin-block-end: 1rem; }
.workspace-editor .editor-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: .5rem; }
.workspace-editor .editor-hint { color: var(--console-muted); }
</style>
