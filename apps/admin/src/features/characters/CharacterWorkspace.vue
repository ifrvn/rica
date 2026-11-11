<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, shallowRef } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { z } from '@hono/zod-openapi'
import type { accountRegistrationView, accountView, characterView, characterWorkspaceView, identityView } from '../../../../../packages/contracts/management.js'
import type { PluginStatus } from '../plugins/plugin-status.js'
import TimeZoneSelect from '../../shared/TimeZoneSelect.vue'
import ConnectorAccountStatus from './ConnectorAccountStatus.vue'
import { request, RequestError } from '../../shared/request.js'

type Workspace = z.infer<typeof characterWorkspaceView>
type Character = z.infer<typeof characterView>
type Identity = z.infer<typeof identityView>
type Account = z.infer<typeof accountView>
type Registration = z.infer<typeof accountRegistrationView>
type Page<T> = { items: T[]; nextCursor: string | null }
type Editor = 'character' | 'core' | 'identity' | 'identity-edit' | 'account' | 'connector-account' | 'associate' | 'control' | 'linked-account'
type Control = { scope: 'CHARACTER' | 'IDENTITY' | 'ACCOUNT'; id: string; name: string; status: string; connector?: boolean; revoke?: boolean }

const props = defineProps<{
  characterId: string; canCreate: boolean; accountsOnly?: boolean; accountDetail?: string;
  characters: Character[]; moreCharacters: boolean;
}>()
const emit = defineEmits<{
  created: [character: Workspace]; updated: [character: Workspace]; expired: []; roles: [roles: Workspace['roles']];
  account: [id?: string]; proposals: [id: string]; selectCharacter: [id: string]; loadCharacters: [];
}>()
const workspace = ref<Workspace>()
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const accountPool = ref<Registration[]>([])
const newbiRegistrationAvailable = ref(false)
const newbiEndpoint = ref<string>()
const editor = ref<Editor>()
const editingIdentity = ref<Identity>()
const editingCore = ref<Workspace>()
const target = ref<Control>()
const linkedAccount = ref<Account>()
const busy = ref(false)
const error = ref('')
const notice = ref('')
const form = reactive({ slug: '', name: '', timezone: '', disclosure: '', style: 'neutral',
  registrationId: null as string | null, platform: '', instance: '', remoteId: '', reason: '', writingPrompt: '' })
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const admin = computed(() => workspace.value?.roles.includes('ADMIN'))
const inspectConnector = computed(() => admin.value || workspace.value?.roles.includes('AUDITOR'))
const connector = computed(() => accounts.value.find(({ id, platform }) => id === props.accountDetail && platform === 'newbi'))
const isCharacter = computed(() => editor.value === 'character' || editor.value === 'core')
const isIdentity = computed(() => editor.value === 'identity' || editor.value === 'identity-edit')
const title = computed(() => ({
  character: '新建角色', core: '角色设置', identity: '添加身份', 'identity-edit': '编辑身份',
  account: '添加模拟账号', 'connector-account': '接入 Newbi 账号', associate: '关联平台账号',
  'linked-account': '已关联的平台账号',
  control: target.value?.revoke ? '撤销账号'
    : (target.value?.status === 'ACTIVE' ? '暂停' : '恢复')
      + ({ CHARACTER: '角色', IDENTITY: '身份', ACCOUNT: '账号' }[target.value?.scope ?? 'ACCOUNT']),
})[editor.value ?? 'character'])
const styles = [
  { label: '中性', value: 'neutral' }, { label: '正式', value: 'formal' },
  { label: '随和', value: 'casual' }, { label: '简洁', value: 'concise' },
]
const editorHeading = ref<HTMLElement>()
const workspaceHeading = ref<HTMLElement>()
let editorTrigger: HTMLElement | undefined
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
const boundAccountLabel = (account: Account) => account.platform + ' · ' + account.instanceKey

function accountControl(account: Account, revoke = false) {
  open('control', undefined, { scope: 'ACCOUNT', id: account.id, name: boundAccountLabel(account),
    status: account.status, connector: account.platform === 'newbi', revoke })
}
const schemas = shallowRef<{
  management: typeof import('../../../../../packages/contracts/management.js')
  connector: typeof import('../../../../../packages/contracts/newbi-pilot.js')
}>()

async function loadSchemas() {
  if (schemas.value) return
  const [management, connector] = await Promise.all([
    import('../../../../../packages/contracts/management.js'), import('../../../../../packages/contracts/newbi-pilot.js'),
  ])
  if (active) schemas.value = { management, connector }
}
const attempted = ref(false)
const touched = ref(new Set<string>())
const parsed = computed(() => {
  if (!schemas.value) return
  const { accountBindingInput, characterInput, controlInput, coreInput, identityInput, identityUpdate, simulationAccountRegistration } = schemas.value.management
  const { connectorAccountRegistration } = schemas.value.connector
  const reason = form.reason.trim() || undefined
  const coreProfile = { ...editingCore.value?.profile, name: form.name.trim() || undefined, aiDisclosure: form.disclosure.trim() }
  const roleProfile = { ...editingIdentity.value?.profile, displayName: form.name.trim() || undefined,
    timezone: form.timezone || undefined, writingStyle: form.style, writingPrompt: form.writingPrompt.trim() || undefined }
  switch (editor.value) {
    case 'character': return characterInput.safeParse({ slug: form.slug.trim(), timezone: form.timezone, coreProfile })
    case 'core': return coreInput.safeParse({ coreProfile, reason })
    case 'identity': return identityInput.safeParse({ slug: form.slug.trim(), roleProfile })
    case 'identity-edit': return identityUpdate.safeParse({ roleProfile, reason })
    case 'account': return simulationAccountRegistration.safeParse({
      platform: form.platform, instanceKey: form.instance.trim(), remoteAccountId: form.remoteId.trim(),
    })
    case 'connector-account': return connectorAccountRegistration.safeParse({
      endpoint: form.instance.trim(), agentId: form.remoteId.trim(),
    })
    case 'associate': return accountBindingInput.safeParse({
      registrationId: form.registrationId, identityId: editingIdentity.value?.id,
    })
    case 'control': {
      const item = target.value
      if (item) return controlInput.safeParse({ scope: item.scope, scopeId: item.id, reason,
        operation: item.revoke ? 'REVOKE_ACCOUNT' : item.status === 'ACTIVE' ? 'PAUSE' : 'RESUME' })
    }
  }
})
const validationMessages: Record<string, string> = {
  slug: '使用小写字母或数字开头，最多 63 个字符，可含连字符。',
  name: '请输入不超过 120 个字符的名称。',
  timezone: '请选择可用的时区。',
  disclosure: '请输入 1–240 个字符的 AI 身份说明。',
  style: '请选择写作风格。',
  writingPrompt: '提示词最多 4000 个字符，可分行填写。',
  registrationId: '请选择要关联的平台账号。',
  platform: '请选择模拟平台。',
  instance: '请检查实例名称或本机接口地址。',
  remote: '请检查账号标识或 Agent ID。',
  reason: '变更原因最多 240 个字符。',
}
const fieldByPath: Record<string, string> = {
  displayName: 'name', aiDisclosure: 'disclosure', writingStyle: 'style',
  instanceKey: 'instance', endpoint: 'instance', remoteAccountId: 'remote', agentId: 'remote',
}
const invalidFields = computed(() => new Set(parsed.value?.error?.issues.map(({ path }) => {
  const field = String(path.at(-1))
  return fieldByPath[field] ?? field
})))

function fieldError(field: string) {
  return invalidFields.value.has(field) && (attempted.value || touched.value.has(field)) ? validationMessages[field] : undefined
}

function fieldInput(field: string) {
  return { id: 'workspace-' + field, 'aria-invalid': fieldError(field) ? true : undefined,
    'aria-describedby': fieldError(field) ? 'workspace-' + field + '-error' : undefined }
}

function closeEditor() {
  editor.value = undefined
}

function updateEditorOpen(show: boolean) {
  if (!show && !busy.value) closeEditor()
}

function restoreEditorFocus(event: Event) {
  event.preventDefault()
  if (!active) return
  if (editorTrigger?.isConnected) editorTrigger.focus()
  else workspaceHeading.value?.focus()
  editorTrigger = undefined
}

let pending: { signature: string; key: string } | undefined
let active = true
onBeforeUnmount(() => { active = false })

function accountLabel(account: Registration) {
  return [account.platform === 'newbi' ? 'Newbi' : account.platform, account.instanceKey, account.remoteAccountId].join(' · ')
}

function status(value: string) {
  const labels: Record<string, string> = {
    ACTIVE: '运行中', PAUSED: '已暂停', PENDING: '待启用', REVOKED: '已撤销', REAUTH_REQUIRED: '需要重新授权',
  }
  return labels[value] ?? value
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
    current.roles.some((role) => role === 'ADMIN' || role === 'AUDITOR') ? all<Registration>(base.value + '/account-pool') : [],
    props.accountsOnly && current.roles.includes('ADMIN')
      ? request<PluginStatus>(base.value + '/plugins').catch((cause) => {
        if (cause instanceof RequestError && cause.status === 401) throw cause
        return undefined
      })
      : undefined,
  ])
  if (!active) return
  workspace.value = current
  identities.value = nextIdentities
  accounts.value = nextAccounts
  accountPool.value = pool
  newbiRegistrationAvailable.value = pluginStatus?.newbiRegistrationAvailable === true
  newbiEndpoint.value = pluginStatus?.deployment?.newbi.endpoint ?? undefined
  emit('roles', current.roles)
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
    if (code === 409 && target.value?.connector && target.value.status === 'PAUSED' && !target.value.revoke) {
      error.value = '恢复未完成。请核对部署中的读取凭据、服务地址和 Agent ID，再重试。'
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

function open(kind: Editor, identity?: Identity, resource?: Control) {
  if (!editor.value) editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  attempted.value = false
  touched.value.clear()
  editor.value = kind
  editingIdentity.value = identity
  editingCore.value = kind === 'core' ? workspace.value : undefined
  target.value = resource
  const core = editingCore.value?.profile
  pending = undefined
  error.value = ''
  notice.value = ''
  Object.assign(form, { slug: '', name: core?.name ?? identity?.profile?.displayName ?? '',
    timezone: kind === 'character' ? Intl.DateTimeFormat().resolvedOptions().timeZone : identity?.profile?.timezone ?? '',
    disclosure: core?.aiDisclosure ?? '', style: identity?.profile?.writingStyle ?? 'neutral',
    writingPrompt: identity?.profile?.writingPrompt ?? '',
    registrationId: null, platform: workspace.value?.simulationPlatforms[0] ?? '',
    instance: kind === 'connector-account' ? newbiEndpoint.value ?? '' : 'local', remoteId: '', reason: '' })
  void nextTick(() => editorHeading.value?.focus())
  void loadSchemas().catch(() => {})
}

function openLinkedAccount(account: Account) {
  linkedAccount.value = account
  open('linked-account')
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
    } else if (kind === 'account' || kind === 'connector-account') {
      await command(base.value + '/account-pool', input.data)
    } else if (kind === 'associate') {
      await command(base.value + '/account-pool/associations', input.data)
    } else if (kind === 'control') {
      await command(base.value + '/controls', input.data)
    } else return
    if (!active) return
    const label = title.value
    pending = undefined
    if (kind === 'associate') editorTrigger = undefined
    closeEditor()
    notice.value = kind === 'associate' ? '账号已关联，当前为暂停状态。' : label + '成功。'
    if (kind !== 'character') await load()
  })
}

onMounted(() => { if (props.characterId) void run(load) })
</script>

<template>
  <div class="character-workspace">
    <NAlert v-if="error && !editor" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <DialogRoot :open="!!editor" @update:open="updateEditorOpen">
    <DialogPortal>
    <DialogOverlay class="workspace-overlay" />
    <DialogContent class="workspace-editor" :aria-describedby="undefined" @close-auto-focus="restoreEditorFocus"
      @open-auto-focus.prevent="editorHeading?.focus()" @pointer-down-outside.prevent>
      <DialogTitle as-child><h3 ref="editorHeading" tabindex="-1">{{ title }}</h3></DialogTitle>
      <NAlert v-if="error" class="editor-alert" type="error" role="alert">{{ error }}</NAlert>
      <p v-if="editor === 'control' && target">{{ target.name }} · {{ status(target.status) }}</p>
      <p v-if="target?.revoke">撤销后，原账号不能恢复，可为该身份关联其他账号。历史记录仍可查看。</p>
      <p v-else-if="target?.connector">{{ target.status === 'ACTIVE' ? '暂停后，此账号无法领取新的读取任务或发送许可。'
          : '恢复前会核对读取权限。发送仍需独立审批和执行许可。' }}</p>
      <template v-if="editor === 'linked-account' && linkedAccount">
        <p>{{ boundAccountLabel(linkedAccount) }} · {{ status(linkedAccount.status) }}</p>
        <div class="workspace-actions editor-actions">
          <NButton v-if="['ACTIVE', 'PAUSED'].includes(linkedAccount.status)" secondary
            :type="linkedAccount.status === 'ACTIVE' ? 'warning' : 'default'" @click="accountControl(linkedAccount)">
            {{ linkedAccount.status === 'ACTIVE' ? '暂停账号' : '恢复账号' }}
          </NButton>
          <NButton type="error" @click="accountControl(linkedAccount, true)">撤销账号</NButton>
          <NButton @click="closeEditor">关闭</NButton>
        </div>
      </template>
      <NForm v-else @submit.prevent="save">
        <NFormItem v-if="editor === 'character' || editor === 'identity'" label="唯一标识" :label-props="{ for: 'workspace-slug' }" :validation-status="fieldError('slug') ? 'error' : undefined">
          <NInput v-model:value="form.slug" :input-props="fieldInput('slug')" @blur="touched.add('slug')" placeholder="小写字母、数字和连字符" maxlength="63" />
          <template v-if="fieldError('slug')" #feedback>
            <span id="workspace-slug-error">{{ fieldError('slug') }}</span>
          </template>
        </NFormItem>
        <NFormItem v-if="isCharacter || isIdentity" label="名称" :label-props="{ for: 'workspace-name' }" :validation-status="fieldError('name') ? 'error' : undefined">
          <NInput placeholder="例如：小黎" v-model:value="form.name" :input-props="fieldInput('name')" @blur="touched.add('name')" maxlength="120" />
          <template v-if="fieldError('name')" #feedback>
            <span id="workspace-name-error">{{ fieldError('name') }}</span>
          </template>
        </NFormItem>
        <NFormItem v-if="editor === 'character' || isIdentity" label="时区" :label-props="{ for: 'workspace-timezone' }" :validation-status="fieldError('timezone') ? 'error' : undefined">
          <TimeZoneSelect v-model:value="form.timezone" id="workspace-timezone" :to="false" :inherited="isIdentity ? workspace?.timezone ?? 'UTC' : undefined"
            :invalid="!!fieldError('timezone')" @blur="touched.add('timezone')" />
          <template v-if="fieldError('timezone')" #feedback>
            <span id="workspace-timezone-error">{{ fieldError('timezone') }}</span>
          </template>
        </NFormItem>
        <NFormItem v-if="isCharacter" label="AI 身份说明" :label-props="{ for: 'workspace-disclosure' }" :validation-status="fieldError('disclosure') ? 'error' : undefined">
          <NInput placeholder="例如：我是由 AI 驱动的虚拟角色" v-model:value="form.disclosure" :input-props="fieldInput('disclosure')" @blur="touched.add('disclosure')" maxlength="240" />
          <template v-if="fieldError('disclosure')" #feedback>
            <span id="workspace-disclosure-error">{{ fieldError('disclosure') }}</span>
          </template>
        </NFormItem>
        <NFormItem v-if="isIdentity" label="写作风格" :label-props="{ for: 'workspace-style' }" :validation-status="fieldError('style') ? 'error' : undefined">
          <NSelect placeholder="选择写作风格" filterable v-model:value="form.style" :to="false" :options="styles" :input-props="fieldInput('style')" @blur="touched.add('style')" />
          <template v-if="fieldError('style')" #feedback>
            <span id="workspace-style-error">{{ fieldError('style') }}</span>
          </template>
        </NFormItem>
        <NFormItem v-if="isIdentity" label="身份提示词（可选）" :label-props="{ for: 'workspace-writingPrompt' }"
          :validation-status="fieldError('writingPrompt') ? 'error' : undefined">
          <NInput v-model:value="form.writingPrompt" type="textarea" :rows="4"
            :maxlength="schemas?.management.maxIdentityWritingPromptLength" :input-props="fieldInput('writingPrompt')"
            placeholder="例如：你负责回答产品使用问题。先给操作步骤，遇到不确定的信息就请对方补充背景。"
            @blur="touched.add('writingPrompt')" />
          <template #feedback>
            <span v-if="fieldError('writingPrompt')" id="workspace-writingPrompt-error">{{ fieldError('writingPrompt') }}</span>
            <span v-else>模拟模型仍按模板生成回复。</span>
          </template>
        </NFormItem>
        <template v-if="editor === 'account' || editor === 'connector-account'">
          <NFormItem v-if="editor === 'account'" label="模拟平台" :label-props="{ for: 'workspace-platform' }" :validation-status="fieldError('platform') ? 'error' : undefined">
            <NSelect placeholder="选择模拟平台" filterable v-model:value="form.platform" :to="false" :input-props="fieldInput('platform')" @blur="touched.add('platform')"
              :options="workspace?.simulationPlatforms.map(value => ({ label: value, value }))" />
            <template v-if="fieldError('platform')" #feedback>
              <span id="workspace-platform-error">{{ fieldError('platform') }}</span>
            </template>
          </NFormItem>
          <NFormItem :label="editor === 'account' ? '实例标识' : '本机 API 地址'" :label-props="{ for: 'workspace-instance' }" :validation-status="fieldError('instance') ? 'error' : undefined">
            <NInput :placeholder="editor === 'account' ? '例如：sandbox' : '例如：http://127.0.0.1:5000/agent-api/v1'" v-model:value="form.instance"
              :readonly="editor === 'connector-account' && !!newbiEndpoint" :input-props="fieldInput('instance')"
              @blur="touched.add('instance')" :maxlength="editor === 'account' ? 120 : 160" />
            <template v-if="fieldError('instance')" #feedback>
              <span id="workspace-instance-error">{{ fieldError('instance') }}</span>
            </template>
          </NFormItem>
          <NFormItem :label="editor === 'account' ? '模拟平台账号标识' : 'Agent ID'" :label-props="{ for: 'workspace-remote' }" :validation-status="fieldError('remote') ? 'error' : undefined">
            <NInput :placeholder="editor === 'account' ? '例如：demo-account' : '输入连接器分配的 Agent ID'" v-model:value="form.remoteId" :input-props="fieldInput('remote')" @blur="touched.add('remote')" maxlength="240" />
            <template v-if="fieldError('remote')" #feedback>
              <span id="workspace-remote-error">{{ fieldError('remote') }}</span>
            </template>
          </NFormItem>
        </template>
        <template v-if="editor === 'associate'">
          <p>关联到 {{ editingIdentity && identityName(editingIdentity) }}</p>
          <p v-if="!accountPool.length" class="workspace-muted">账号池暂无可关联账号，请先登记账号。</p>
          <NFormItem v-else label="平台账号" :label-props="{ for: 'workspace-registrationId' }"
            :validation-status="fieldError('registrationId') ? 'error' : undefined">
            <NSelect v-model:value="form.registrationId" :to="false" filterable placeholder="从账号池选择未关联账号"
              :input-props="fieldInput('registrationId')" @blur="touched.add('registrationId')"
              :options="accountPool.map(item => ({ label: accountLabel(item), value: item.id }))" />
            <template v-if="fieldError('registrationId')" #feedback>
              <span id="workspace-registrationId-error">{{ fieldError('registrationId') }}</span>
            </template>
          </NFormItem>
        </template>
        <NFormItem v-if="editor === 'core' || editor === 'identity-edit' || editor === 'control'" label="变更原因说明（可选）"
          :label-props="{ for: 'workspace-reason' }" :validation-status="fieldError('reason') ? 'error' : undefined">
          <NInput :placeholder="editor === 'core' ? '例如：统一 AI 身份披露文案' : editor === 'identity-edit' ? '例如：调整此身份的写作风格' : '例如：维护期间暂停运行'" v-model:value="form.reason" :input-props="fieldInput('reason')" @blur="touched.add('reason')" maxlength="240" />
          <template v-if="fieldError('reason')" #feedback>
            <span id="workspace-reason-error">{{ fieldError('reason') }}</span>
          </template>
        </NFormItem>
        <div class="workspace-actions editor-actions">
          <NButton :type="target?.revoke ? 'error' : target?.status === 'ACTIVE' ? 'warning' : 'primary'"
            attr-type="submit" :loading="busy" :disabled="busy || (editor === 'associate' && !accountPool.length)">
            {{ editor === 'core' || editor === 'identity-edit' ? '保存修改' : title }}
          </NButton>
          <NButton :disabled="busy" @click="closeEditor">取消</NButton>
        </div>
      </NForm>
      <div v-if="editor === 'core' && workspace" class="editor-lifecycle">
        <NButton secondary :type="workspace.status === 'ACTIVE' ? 'warning' : 'default'" :disabled="busy"
          @click="open('control', undefined, { scope: 'CHARACTER', id: workspace.id, name: workspace.profile?.name || workspace.slug, status: workspace.status })">
          {{ workspace.status === 'ACTIVE' ? '暂停角色' : '恢复角色' }}
        </NButton>
      </div>
      <div v-if="editor === 'identity-edit' && editingIdentity" class="editor-lifecycle">
        <NButton secondary :type="editingIdentity.status === 'ACTIVE' ? 'warning' : 'default'" :disabled="busy"
          @click="open('control', undefined, { scope: 'IDENTITY', id: editingIdentity.id, name: identityName(editingIdentity), status: editingIdentity.status })">
          {{ editingIdentity.status === 'ACTIVE' ? '暂停身份' : '恢复身份' }}
        </NButton>
      </div>
    </DialogContent>
    </DialogPortal>
    </DialogRoot>
    <div v-if="!accountsOnly" class="workspace-card character-columns">
      <section class="character-list" aria-labelledby="characters-heading">
        <div class="console-section-heading">
          <h3 id="characters-heading">角色</h3>
          <NButton v-if="canCreate" size="small" :type="characters.length ? 'default' : 'primary'" :disabled="busy" @click="open('character')">新建角色</NButton>
        </div>
        <NEmpty v-if="!characters.length" :description="canCreate ? '尚未创建角色。' : '当前账号没有可访问的角色。'" />
        <ul v-else class="role-list">
          <li v-for="character in characters" :key="character.id" class="role-row">
            <button type="button" class="role-select" :disabled="busy" :aria-pressed="character.id === characterId"
              @click="emit('selectCharacter', character.id)">
              <span class="role-title"><strong>{{ character.profile?.name || character.slug }}</strong>
                <NTag size="small" :bordered="false" :type="character.status === 'ACTIVE' ? 'success' : 'warning'">{{ status(character.status) }}</NTag></span>
              <span class="role-note workspace-muted">{{ character.profile?.aiDisclosure || character.timezone }}</span>
            </button>
            <button v-if="character.id === characterId && admin && workspace?.version" class="role-settings" type="button"
              :aria-label="'设置角色 ' + (character.profile?.name || character.slug)" :disabled="busy" @click="open('core')">
              <span class="i-lucide-settings" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <NButton v-if="moreCharacters" text size="small" :disabled="busy" @click="emit('loadCharacters')">加载更多角色</NButton>
      </section>
      <section class="identity-list" aria-labelledby="identities-heading">
        <div class="console-section-heading">
          <h3 id="identities-heading" ref="workspaceHeading" tabindex="-1">{{ workspace ? (workspace.profile?.name || workspace.slug) + '的身份' : '身份' }}</h3>
          <div v-if="workspace" class="workspace-actions">
            <span class="workspace-muted">{{ identities.length }} 个身份</span>
            <NButton v-if="admin" size="small" type="primary" :disabled="busy" @click="open('identity')">添加身份</NButton>
          </div>
        </div>
        <NSpin v-if="busy && !workspace" aria-label="正在加载身份" />
        <NButton v-else-if="!workspace && characterId && error && !editor" size="small" @click="run(load)">重新加载</NButton>
        <NEmpty v-else-if="!identities.length" :description="workspace ? '尚未添加身份。' : '选择角色后查看身份。'" />
        <ul v-else class="workspace-list">
          <li v-for="identity in identities" :key="identity.id" class="identity-row">
            <div class="workspace-row">
              <button v-if="admin && identity.version" class="identity-name" type="button" :disabled="busy"
                :aria-label="'编辑身份 ' + identityName(identity)" @click="open('identity-edit', identity)">
                {{ identityName(identity) }}<span class="i-lucide-pencil edit-icon" aria-hidden="true" />
              </button>
              <strong v-else>{{ identityName(identity) }}</strong>
              <NTag size="small" :bordered="false" :type="identity.status === 'ACTIVE' ? 'success' : 'warning'">{{ status(identity.status) }}</NTag>
            </div>
            <div v-if="accountsByIdentity.has(identity.id)" class="workspace-actions">
              <template v-for="account in accountsByIdentity.get(identity.id)" :key="account.id">
                <NButton v-if="admin" text type="primary" :disabled="busy" @click="openLinkedAccount(account)">{{ boundAccountLabel(account) }}</NButton>
                <span v-else>{{ boundAccountLabel(account) }}</span>
              </template>
            </div>
            <div v-else class="workspace-row">
              <span class="workspace-muted">未关联平台账号</span>
              <NButton v-if="admin" size="small" :disabled="busy" @click="open('associate', identity)">关联账号</NButton>
            </div>
          </li>
        </ul>
      </section>
    </div>
    <NSpin v-else-if="busy && !workspace" />
    <NButton v-else-if="!workspace && characterId && error && !editor" size="small" @click="run(load)">重新加载</NButton>
    <template v-else-if="workspace">
      <section class="workspace-card" aria-labelledby="platform-accounts-heading">
        <div class="console-section-heading">
          <h3 id="platform-accounts-heading" :ref="(node) => { if (accountsOnly) workspaceHeading = node as HTMLElement | undefined }" tabindex="-1">平台账号池</h3>
          <div v-if="admin || accountsOnly" class="workspace-actions">
            <NButton v-if="admin" size="small" :disabled="busy || !workspace.simulationPlatforms.length"
              @click="open('account')">添加模拟账号</NButton>
            <NButton v-if="admin && newbiRegistrationAvailable" size="small" :disabled="busy"
              @click="open('connector-account')">接入 Newbi 账号</NButton>
            <NButton v-if="accountsOnly" text :disabled="busy" @click="run(load)">刷新账号</NButton>
          </div>
        </div>
        <NAlert v-if="admin && !workspace.simulationPlatforms.length" type="warning">当前部署未启用模拟适配器。</NAlert>
        <ul v-if="accountPool.length" class="workspace-list">
          <li v-for="item in accountPool" :key="item.id" class="workspace-row">
            <span>{{ accountLabel(item) }}</span>
            <NTag size="small" :bordered="false">未关联</NTag>
          </li>
        </ul>
        <NEmpty v-if="!accounts.length && !accountPool.length" description="暂无平台账号。" />
        <ul v-if="accounts.length" class="workspace-list">
          <li v-for="account in accounts" :key="account.id" class="workspace-row">
            <div class="account-summary">
              <span class="workspace-actions"><strong>{{ boundAccountLabel(account) }}</strong>
              <NTag size="small">{{ status(account.status) }}</NTag>
              </span>
              <span class="workspace-muted">{{ workspace.profile?.name || workspace.slug }} / {{
                identities.find(item => item.id === account.identityId)?.profile?.displayName
                  || identities.find(item => item.id === account.identityId)?.slug || '身份不可用'
              }}</span>
            </div>
            <div class="workspace-actions">
              <NButton v-if="inspectConnector && account.platform === 'newbi'" size="small"
                @click="emit('account', account.id)">查看读取状态</NButton>
              <NButton v-if="admin && ['mock-a', 'mock-b', 'newbi'].includes(account.platform) && ['ACTIVE', 'PAUSED'].includes(account.status)"
                size="small" :type="account.status === 'ACTIVE' ? 'warning' : 'default'" secondary :disabled="busy" @click="accountControl(account)">
                {{ account.status === 'ACTIVE' ? '暂停账号' : '恢复账号' }}
              </NButton>
              <NButton v-if="admin && account.status !== 'REVOKED'"
                size="small" type="error" :disabled="busy" @click="accountControl(account, true)">
                撤销账号
              </NButton>
            </div>
          </li>
        </ul>
      </section>
      <ConnectorAccountStatus v-if="connector && inspectConnector" :key="connector.id + '/' + connector.version"
        :character-id="characterId" :account-id="connector.id" :account-status="connector.status" :can-review="!!admin"
        @expired="emit('expired')" @proposals="emit('proposals', connector.id)" />
      <NAlert v-else-if="accountDetail" type="warning">找不到当前角色的连接器账号。</NAlert>
    </template>
  </div>
</template>

<style scoped>
.character-workspace { display: grid; gap: 1.25rem; min-width: 0; }
.workspace-card { min-width: 0; padding: 1rem; background: var(--console-surface); border: 1px solid var(--console-line); border-radius: 5px; }
.character-columns { display: grid; grid-template-columns: minmax(12rem, 2fr) minmax(0, 3fr); align-items: start; }
.character-list, .identity-list { min-width: 0; }
.character-list { padding-inline-end: 1rem; }
.identity-list { padding-inline-start: 1rem; border-inline-start: 1px solid var(--console-line); }
.role-list { list-style: none; margin: 0; padding: 0; }
.role-row { position: relative; border-top: 1px solid var(--console-line); }
.role-select, .role-settings, .identity-name { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.role-select { display: grid; gap: .35rem; width: 100%; padding: .75rem 2.75rem .75rem .625rem; text-align: start; }
.role-select:enabled:hover, .role-settings:enabled:hover { background: var(--console-hover); }
.role-select[aria-pressed="true"] { background: var(--console-selected); }
.role-title { display: flex; flex-wrap: wrap; align-items: center; gap: .375rem; overflow-wrap: anywhere; }
.role-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role-settings { position: absolute; display: grid; place-items: center; inset-inline-end: .25rem; inset-block-end: .25rem; width: 2rem; height: 2rem; border-radius: 4px; }
.workspace-muted { color: var(--console-muted); font-size: .8125rem; }
.identity-row, .account-summary { display: grid; gap: .5rem; }
.identity-name { display: inline-flex; align-items: center; gap: .375rem; padding: 0; text-align: start; font-weight: 650; }
.identity-name:enabled:hover { color: var(--console-accent-text); }
.edit-icon { opacity: 0; flex: none; }
.identity-row:hover .edit-icon, .identity-row:focus-within .edit-icon { opacity: 1; }
.workspace-overlay { position: fixed; inset: 0; z-index: 1000; background: #0006; }
.workspace-editor { position: fixed; z-index: 1001; inset-block-start: 50%; inset-inline-start: 50%; transform: translate(-50%, -50%);
  box-sizing: border-box; width: min(34rem, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); overflow: auto;
  padding: 1.25rem; color: var(--console-text); background: var(--console-surface); border: 1px solid var(--console-line); border-radius: 8px; }
.workspace-editor h3 { margin: 0 0 1rem; }
.editor-alert { margin-block-end: 1rem; }
.editor-actions { justify-content: flex-end; }
.editor-lifecycle { margin-block-start: 1rem; padding-block-start: 1rem; border-top: 1px solid var(--console-line); }
.workspace-list > li { padding-block: .625rem; }
.workspace-actions, .workspace-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.workspace-row { justify-content: space-between; overflow-wrap: anywhere; }
.workspace-list { list-style: none; margin: 0; padding: 0; }
.workspace-list > li + li { border-top: 1px solid var(--console-line); margin-top: .5rem; padding-top: .5rem; }
@media (max-width: 42rem) {
  .character-columns { grid-template-columns: minmax(0, 1fr); }
  .character-list { padding-inline-end: 0; }
  .identity-list { padding-inline-start: 0; padding-block-start: 1rem; margin-block-start: 1rem; border-inline-start: 0; border-block-start: 1px solid var(--console-line); }
}
@media (pointer: coarse) {
  .role-settings { width: 2.75rem; height: 2.75rem; }
  .role-select { padding-inline-end: 3.25rem; }
  .identity-name { min-height: 2.75rem; }
  .edit-icon { opacity: 1; }
}
</style>
