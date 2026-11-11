<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, shallowRef } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountRegistrationView, accountView, characterWorkspaceView, identityView } from '../../packages/contracts/management.js'
import TimeZoneSelect from './TimeZoneSelect.vue'
import ConnectorAccountStatus from './ConnectorAccountStatus.vue'
import { request, RequestError } from './request.js'

type Workspace = z.infer<typeof characterWorkspaceView>
type Identity = z.infer<typeof identityView>
type Account = z.infer<typeof accountView>
type Registration = z.infer<typeof accountRegistrationView>
type Page<T> = { items: T[]; nextCursor: string | null }
type Editor = 'character' | 'core' | 'identity' | 'identity-edit' | 'account' | 'connector-account' | 'associate' | 'control'
type Control = { scope: 'CHARACTER' | 'IDENTITY' | 'ACCOUNT'; id: string; name: string; status: string; connector?: boolean; revoke?: boolean }

const props = defineProps<{ characterId: string; canCreate: boolean; accountsOnly?: boolean; accountDetail?: string }>()
const emit = defineEmits<{ created: [character: Workspace]; expired: []; roles: [roles: Workspace['roles']]; account: [id?: string]; proposals: [id: string] }>()
const workspace = ref<Workspace>()
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const accountPool = ref<Registration[]>([])
const editor = ref<Editor>()
const editingIdentity = ref<Identity>()
const editingCore = ref<Workspace>()
const target = ref<Control>()
const busy = ref(false)
const error = ref('')
const notice = ref('')
const form = reactive({ slug: '', name: '', timezone: '', disclosure: '', style: 'neutral',
  registrationId: '', platform: '', instance: '', remoteId: '', reason: '', writingPrompt: '' })
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const admin = computed(() => workspace.value?.roles.includes('ADMIN'))
const inspectConnector = computed(() => admin.value || workspace.value?.roles.includes('AUDITOR'))
const connector = computed(() => accounts.value.find(({ id, platform }) => id === props.accountDetail && platform === 'newbi'))
const isCharacter = computed(() => editor.value === 'character' || editor.value === 'core')
const isIdentity = computed(() => editor.value === 'identity' || editor.value === 'identity-edit')
const title = computed(() => ({
  character: '创建角色', core: '编辑核心', identity: '创建身份', 'identity-edit': '编辑身份',
  account: '添加模拟账号', 'connector-account': '添加连接器账号', associate: '关联平台账号',
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
const schemas = shallowRef<{
  management: typeof import('../../packages/contracts/management.js')
  connector: typeof import('../../packages/contracts/newbi-pilot.js')
}>()

async function loadSchemas() {
  if (schemas.value) return
  const [management, connector] = await Promise.all([
    import('../../packages/contracts/management.js'), import('../../packages/contracts/newbi-pilot.js'),
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
  void nextTick(() => workspaceHeading.value?.focus())
}

let pending: { signature: string; key: string } | undefined
let active = true
onBeforeUnmount(() => { active = false })

function accountLabel(account: Registration) {
  return [account.platform === 'newbi' ? '本机连接器' : account.platform, account.instanceKey, account.remoteAccountId].join(' · ')
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
  const [nextIdentities, nextAccounts, pool] = await Promise.all([
    all<Identity>(base.value + '/identities'), all<Account>(base.value + '/accounts'),
    current.roles.some((role) => role === 'ADMIN' || role === 'AUDITOR') ? all<Registration>(base.value + '/account-pool') : [],
  ])
  if (!active) return
  workspace.value = current
  identities.value = nextIdentities
  accounts.value = nextAccounts
  accountPool.value = pool
  emit('roles', current.roles)
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
    registrationId: '', platform: workspace.value?.simulationPlatforms[0] ?? '',
    instance: kind === 'connector-account' ? '' : 'local', remoteId: '', reason: '' })
  void nextTick(() => editorHeading.value?.focus())
  void loadSchemas().catch(() => {})
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
    closeEditor()
    notice.value = kind === 'associate' ? '账号已关联，当前为暂停状态。' : label + '成功。'
    if (kind !== 'character') await load()
  })
}

onMounted(() => { if (props.characterId) void run(load) })
</script>

<template>
  <div class="character-workspace">
    <div v-if="canCreate && !workspace && !editor" class="workspace-actions">
      <NButton type="primary" :disabled="busy" @click="open('character')">创建角色</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <section v-if="editor" class="workspace-editor" aria-labelledby="workspace-editor-heading">
      <h3 id="workspace-editor-heading" ref="editorHeading" tabindex="-1">{{ title }}</h3>
      <p v-if="editor === 'control' && target">{{ target.name }} · {{ status(target.status) }}</p>
      <p v-if="target?.connector">{{ target.revoke ? '撤销后，此绑定无法恢复。待核对记录和回执仍可查看。'
        : target.status === 'ACTIVE' ? '暂停后，此账号无法领取新的读取任务或发送许可。'
          : '恢复前会核对读取权限。发送仍需独立审批和执行许可。' }}</p>
      <NForm @submit.prevent="save">
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
          <TimeZoneSelect v-model:value="form.timezone" id="workspace-timezone" :inherited="isIdentity ? workspace?.timezone ?? 'UTC' : undefined"
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
          <NSelect placeholder="选择写作风格" filterable v-model:value="form.style" :options="styles" :input-props="fieldInput('style')" @blur="touched.add('style')" />
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
            <NSelect placeholder="选择模拟平台" filterable v-model:value="form.platform" :input-props="fieldInput('platform')" @blur="touched.add('platform')"
              :options="workspace?.simulationPlatforms.map(value => ({ label: value, value }))" />
            <template v-if="fieldError('platform')" #feedback>
              <span id="workspace-platform-error">{{ fieldError('platform') }}</span>
            </template>
          </NFormItem>
          <NFormItem :label="editor === 'account' ? '实例标识' : '本机 API 地址'" :label-props="{ for: 'workspace-instance' }" :validation-status="fieldError('instance') ? 'error' : undefined">
            <NInput :placeholder="editor === 'account' ? '例如：sandbox' : '例如：http://127.0.0.1:5000/agent-api/v1'" v-model:value="form.instance" :input-props="fieldInput('instance')" @blur="touched.add('instance')" :maxlength="editor === 'account' ? 120 : 160" />
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
          <p>关联到 {{ editingIdentity?.profile?.displayName || editingIdentity?.slug }}</p>
          <NFormItem label="平台账号" :label-props="{ for: 'workspace-registrationId' }"
            :validation-status="fieldError('registrationId') ? 'error' : undefined">
            <NSelect v-model:value="form.registrationId" filterable placeholder="从账号池选择未关联账号"
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
        <div class="workspace-actions">
          <NButton :type="target?.revoke ? 'error' : target?.status === 'ACTIVE' ? 'warning' : 'primary'"
            attr-type="submit" :loading="busy" :disabled="busy">{{ editor === 'core' || editor === 'identity-edit' ? '保存修改' : title }}</NButton>
          <NButton :disabled="busy" @click="closeEditor">取消</NButton>
        </div>
      </NForm>
    </section>
    <NSpin v-else-if="busy && !workspace" />
    <NButton v-else-if="!workspace && characterId && error" size="small" @click="run(load)">重新加载</NButton>
    <NEmpty v-else-if="!workspace && !error" :description="canCreate ? '尚未创建角色。' : '当前账号没有可访问的角色。'" />
    <template v-else-if="workspace && !editor">
      <section v-if="!accountsOnly" class="workspace-section" aria-labelledby="character-summary-heading">
        <div class="console-section-heading">
          <h3 id="character-summary-heading" ref="workspaceHeading" tabindex="-1">{{ workspace.profile?.name || workspace.slug }}</h3>
          <div class="workspace-actions">
            <NButton v-if="canCreate" text type="primary" :disabled="busy" @click="open('character')">创建角色</NButton>
            <NButton text :disabled="busy" @click="run(load)">刷新</NButton>
          </div>
        </div>
        <div class="workspace-row">
          <div>{{ workspace.timezone }} <NTag size="small" :bordered="false">{{ status(workspace.status) }}</NTag></div>
          <div v-if="admin" class="workspace-actions">
            <NButton size="small" :disabled="busy || !workspace.version" @click="open('core')">编辑核心</NButton>
            <NButton size="small" :type="workspace.status === 'ACTIVE' ? 'warning' : 'default'" secondary :disabled="busy" @click="open('control', undefined,
              { scope: 'CHARACTER', id: workspace.id, name: workspace.profile?.name || workspace.slug, status: workspace.status })">
              {{ workspace.status === 'ACTIVE' ? '暂停角色' : '恢复角色' }}
            </NButton>
          </div>
        </div>
      </section>
      <section v-if="!accountsOnly" class="workspace-section" aria-labelledby="identities-heading">
        <div class="console-section-heading">
          <h3 id="identities-heading">身份</h3>
          <NButton v-if="admin" text type="primary" :disabled="busy" @click="open('identity')">创建身份</NButton>
        </div>
        <NEmpty v-if="!identities.length" description="暂无身份。" />
        <ul v-else class="workspace-list">
          <li v-for="identity in identities" :key="identity.id" class="workspace-row">
            <span>{{ identity.profile?.displayName || identity.slug }} <NTag size="small">{{ status(identity.status) }}</NTag></span>
            <div v-if="admin" class="workspace-actions">
              <NButton size="small" :disabled="busy || !accountPool.length" @click="open('associate', identity)">关联账号</NButton>
              <NButton size="small" :disabled="busy || !identity.version" @click="open('identity-edit', identity)">编辑</NButton>
              <NButton size="small" :type="identity.status === 'ACTIVE' ? 'warning' : 'default'" secondary :disabled="busy" @click="open('control', undefined,
                { scope: 'IDENTITY', id: identity.id, name: identity.profile?.displayName || identity.slug, status: identity.status })">
                {{ identity.status === 'ACTIVE' ? '暂停身份' : '恢复身份' }}
              </NButton>
            </div>
          </li>
        </ul>
      </section>
      <section class="workspace-section" aria-labelledby="platform-accounts-heading">
        <div class="console-section-heading">
          <h3 id="platform-accounts-heading" :ref="(node) => { if (accountsOnly) workspaceHeading = node as HTMLElement | undefined }" tabindex="-1">平台账号池</h3>
          <div v-if="admin || accountsOnly" class="workspace-actions">
            <NButton v-if="admin" size="small" :disabled="busy || !workspace.simulationPlatforms.length"
              @click="open('account')">添加模拟账号</NButton>
            <NButton v-if="admin" size="small" :disabled="busy" @click="open('connector-account')">添加连接器账号</NButton>
            <NButton v-if="accountsOnly" text :disabled="busy" @click="run(load)">刷新账号</NButton>
          </div>
        </div>
        <NAlert v-if="!accountsOnly && admin && !workspace.simulationPlatforms.length" type="warning">当前部署未启用模拟适配器。</NAlert>
        <ul v-if="accountPool.length" class="workspace-list">
          <li v-for="item in accountPool" :key="item.id" class="workspace-row">
            <span>{{ accountLabel(item) }}</span>
            <NTag size="small" :bordered="false">未关联</NTag>
          </li>
        </ul>
        <NEmpty v-if="!accounts.length && !accountPool.length" description="暂无平台账号。" />
        <ul v-if="accounts.length" class="workspace-list">
          <li v-for="account in accounts" :key="account.id" class="workspace-row">
            <span>{{ account.platform }} · {{ account.instanceKey }} ·
              {{ identities.find(item => item.id === account.identityId)?.profile?.displayName
                || identities.find(item => item.id === account.identityId)?.slug }}
              <NTag size="small">{{ status(account.status) }}</NTag>
            </span>
            <div class="workspace-actions">
              <NButton v-if="inspectConnector && account.platform === 'newbi'" size="small"
                @click="emit('account', account.id)">查看读取状态</NButton>
              <NButton v-if="admin && ['mock-a', 'mock-b', 'newbi'].includes(account.platform) && ['ACTIVE', 'PAUSED'].includes(account.status)"
                size="small" :type="account.status === 'ACTIVE' ? 'warning' : 'default'" secondary :disabled="busy" @click="open('control', undefined,
                  { scope: 'ACCOUNT', id: account.id, name: account.platform + ' · ' + account.instanceKey,
                    status: account.status, connector: account.platform === 'newbi' })">
                {{ account.status === 'ACTIVE' ? '暂停账号' : '恢复账号' }}
              </NButton>
              <NButton v-if="admin && account.platform === 'newbi' && account.status !== 'REVOKED'"
                size="small" type="error" :disabled="busy" @click="open('control', undefined,
                  { scope: 'ACCOUNT', id: account.id, name: account.instanceKey, status: account.status, connector: true, revoke: true })">
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
.workspace-section + .workspace-section { border-top: 1px solid var(--console-line); padding-top: 1rem; }
.workspace-editor { max-width: 37rem; }
.workspace-editor h3 { margin: 0 0 1rem; }
.workspace-list > li { padding-block: .625rem; }
.workspace-actions, .workspace-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.workspace-row { justify-content: space-between; overflow-wrap: anywhere; }
.workspace-list { list-style: none; margin: 0; padding: 0; }
.workspace-list > li + li { border-top: 1px solid var(--console-line); margin-top: .5rem; padding-top: .5rem; }
</style>
