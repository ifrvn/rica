<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, identityView } from '../../packages/contracts/management.js'
import { request, RequestError } from './request.js'

type Workspace = z.infer<typeof characterWorkspaceView>
type Identity = z.infer<typeof identityView>
type Account = z.infer<typeof accountView>
type Page<T> = { items: T[]; nextCursor: string | null }
type Editor = 'character' | 'core' | 'identity' | 'identity-edit' | 'account' | 'control'
type Control = { scope: 'CHARACTER' | 'IDENTITY' | 'ACCOUNT'; id: string; name: string; status: string }

const props = defineProps<{ characterId: string; canCreate: boolean }>()
const emit = defineEmits<{ created: [character: Workspace]; expired: []; roles: [roles: Workspace['roles']] }>()
const workspace = ref<Workspace>()
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const editor = ref<Editor>()
const editingIdentity = ref<Identity>()
const editingCore = ref<Workspace>()
const target = ref<Control>()
const busy = ref(false)
const error = ref('')
const notice = ref('')
const form = reactive({ slug: '', name: '', timezone: '', disclosure: '', style: 'neutral',
  identityId: '', platform: '', instance: '', remoteId: '', reason: '' })
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const admin = computed(() => workspace.value?.roles.includes('ADMIN'))
const isCharacter = computed(() => editor.value === 'character' || editor.value === 'core')
const isIdentity = computed(() => editor.value === 'identity' || editor.value === 'identity-edit')
const title = computed(() => ({
  character: '创建角色', core: '编辑核心', identity: '创建身份', 'identity-edit': '编辑身份',
  account: '登记模拟账号', control: target.value?.status === 'ACTIVE' ? '暂停' : '恢复',
})[editor.value ?? 'character'])
const styles = [
  { label: '中性', value: 'neutral' }, { label: '正式', value: 'formal' },
  { label: '随和', value: 'casual' }, { label: '简洁', value: 'concise' },
]
let pending: { signature: string; key: string } | undefined
let active = true
onBeforeUnmount(() => { active = false })

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
  const [nextIdentities, nextAccounts] = await Promise.all([
    all<Identity>(base.value + '/identities'), all<Account>(base.value + '/accounts'),
  ])
  if (!active) return
  workspace.value = current
  identities.value = nextIdentities
  accounts.value = nextAccounts
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
    error.value = ({
      403: '当前账号无权执行此操作。', 404: '当前角色或资源不可访问。', 409: '操作冲突，请核对当前状态。',
      412: '配置已更新。请取消编辑，刷新后重新核对。', 422: '请核对标识、时区和输入内容。',
    } as Record<number, string>)[code] ?? '操作未完成，请重试。'
  } finally {
    busy.value = false
  }
}

function open(kind: Editor, identity?: Identity, resource?: Control) {
  editor.value = kind
  editingIdentity.value = identity
  editingCore.value = kind === 'core' ? workspace.value : undefined
  target.value = resource
  const core = editingCore.value?.profile
  pending = undefined
  error.value = ''
  notice.value = ''
  Object.assign(form, { slug: '', name: core?.name ?? identity?.profile?.displayName ?? '',
    timezone: kind === 'character' ? 'UTC' : identity?.profile?.timezone ?? '',
    disclosure: core?.aiDisclosure ?? '', style: identity?.profile?.writingStyle ?? 'neutral',
    identityId: identities.value[0]?.id ?? '', platform: workspace.value?.simulationPlatforms[0] ?? '',
    instance: 'local', remoteId: '', reason: '' })
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
    const kind = editor.value
    const reason = form.reason.trim()
    const current = editingCore.value
    const identity = editingIdentity.value
    const coreProfile = { ...current?.profile, name: form.name.trim() || undefined, aiDisclosure: form.disclosure.trim() }
    const roleProfile = { ...identity?.profile, displayName: form.name.trim() || undefined,
      timezone: form.timezone.trim() || undefined, writingStyle: form.style }
    if (kind === 'character') {
      const result = await command('/v1/characters', { slug: form.slug.trim(), timezone: form.timezone.trim(), coreProfile })
      if (!active) return
      const created = await request<Workspace>('/v1/characters/' + encodeURIComponent(result.id))
      if (active) emit('created', created)
    } else if (kind === 'core' && current?.version != null) {
      await command(base.value + '/core', { coreProfile, reason }, current.version)
    } else if (kind === 'identity') {
      await command(base.value + '/identities', { slug: form.slug.trim(), roleProfile })
    } else if (kind === 'identity-edit' && identity?.version != null) {
      await command(base.value + '/identities/' + identity.id, { roleProfile, reason }, identity.version)
    } else if (kind === 'account') {
      await command(base.value + '/accounts', { identityId: form.identityId, platform: form.platform,
        instanceKey: form.instance.trim(), remoteAccountId: form.remoteId.trim() })
    } else if (kind === 'control' && target.value) {
      const { scope, id: scopeId, status } = target.value
      await command(base.value + '/controls', { scope, scopeId, operation: status === 'ACTIVE' ? 'PAUSE' : 'RESUME', reason })
    } else return
    if (!active) return
    editor.value = undefined
    pending = undefined
    notice.value = '已保存。'
    if (kind !== 'character') await load()
  })
}

const valid = computed(() => {
  if (editor.value === 'character') return !!(form.slug.trim() && form.timezone.trim() && form.disclosure.trim())
  if (editor.value === 'core') return !!(form.disclosure.trim() && form.reason.trim())
  if (editor.value === 'identity') return !!form.slug.trim()
  if (editor.value === 'identity-edit' || editor.value === 'control') return !!form.reason.trim()
  return !!(form.identityId && form.platform && form.instance.trim() && form.remoteId.trim())
})

onMounted(() => { if (props.characterId) void run(load) })
</script>

<template>
  <div class="character-workspace">
    <div class="workspace-actions">
      <NButton v-if="canCreate && !editor" type="primary" :disabled="busy" @click="open('character')">创建角色</NButton>
      <NButton v-if="characterId" size="small" :disabled="busy || !!editor" @click="run(load)">刷新</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NCard v-if="editor" :title="title" size="small">
      <p v-if="editor === 'control' && target">{{ target.name }} · {{ status(target.status) }}</p>
      <NForm @submit.prevent="save">
        <NFormItem v-if="editor === 'character' || editor === 'identity'" label="标识" :label-props="{ for: 'workspace-slug' }">
          <NInput v-model:value="form.slug" :input-props="{ id: 'workspace-slug' }" placeholder="小写字母、数字和连字符" maxlength="63" />
        </NFormItem>
        <NFormItem v-if="isCharacter || isIdentity" label="名称" :label-props="{ for: 'workspace-name' }">
          <NInput v-model:value="form.name" :input-props="{ id: 'workspace-name' }" maxlength="120" />
        </NFormItem>
        <NFormItem v-if="editor === 'character' || isIdentity" label="时区" :label-props="{ for: 'workspace-timezone' }">
          <NInput v-model:value="form.timezone" :input-props="{ id: 'workspace-timezone' }" placeholder="例如 Asia/Hong_Kong" />
        </NFormItem>
        <NFormItem v-if="isCharacter" label="AI 披露" :label-props="{ for: 'workspace-disclosure' }">
          <NInput v-model:value="form.disclosure" :input-props="{ id: 'workspace-disclosure' }" maxlength="240" />
        </NFormItem>
        <NFormItem v-if="isIdentity" label="写作风格" :label-props="{ for: 'workspace-style' }">
          <NSelect v-model:value="form.style" :options="styles" :input-props="{ id: 'workspace-style' }" />
        </NFormItem>
        <template v-if="editor === 'account'">
          <NFormItem label="身份" :label-props="{ for: 'workspace-identity' }">
            <NSelect v-model:value="form.identityId" :input-props="{ id: 'workspace-identity' }"
              :options="identities.map(item => ({ label: item.profile?.displayName || item.slug, value: item.id }))" />
          </NFormItem>
          <NFormItem label="模拟平台" :label-props="{ for: 'workspace-platform' }">
            <NSelect v-model:value="form.platform" :input-props="{ id: 'workspace-platform' }"
              :options="workspace?.simulationPlatforms.map(value => ({ label: value, value }))" />
          </NFormItem>
          <NFormItem label="实例标识" :label-props="{ for: 'workspace-instance' }">
            <NInput v-model:value="form.instance" :input-props="{ id: 'workspace-instance' }" maxlength="120" />
          </NFormItem>
          <NFormItem label="模拟平台账号标识" :label-props="{ for: 'workspace-remote' }">
            <NInput v-model:value="form.remoteId" :input-props="{ id: 'workspace-remote' }" maxlength="240" />
          </NFormItem>
        </template>
        <NFormItem v-if="editor === 'core' || editor === 'identity-edit' || editor === 'control'" label="理由"
          :label-props="{ for: 'workspace-reason' }">
          <NInput v-model:value="form.reason" :input-props="{ id: 'workspace-reason' }" maxlength="240" />
        </NFormItem>
        <div class="workspace-actions">
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !valid">{{ editor === 'control' ? title : '保存' }}</NButton>
          <NButton :disabled="busy" @click="editor = undefined">取消</NButton>
        </div>
      </NForm>
    </NCard>
    <NSpin v-else-if="busy && !workspace" />
    <NEmpty v-else-if="!workspace && !error" :description="canCreate ? '尚未创建角色。' : '当前账号没有可访问的角色。'" />
    <template v-else-if="workspace && !editor">
      <NCard :title="workspace.profile?.name || workspace.slug" size="small">
        <div class="workspace-row">
          <div>{{ workspace.timezone }} · 核心 v{{ workspace.version ?? '—' }} <NTag size="small">{{ status(workspace.status) }}</NTag></div>
          <div v-if="admin" class="workspace-actions">
            <NButton size="small" :disabled="busy || !workspace.version" @click="open('core')">编辑核心</NButton>
            <NButton size="small" :disabled="busy" @click="open('control', undefined,
              { scope: 'CHARACTER', id: workspace.id, name: workspace.profile?.name || workspace.slug, status: workspace.status })">
              {{ workspace.status === 'ACTIVE' ? '暂停角色' : '恢复角色' }}
            </NButton>
          </div>
        </div>
      </NCard>
      <NCard title="身份" size="small">
        <template v-if="admin" #header-extra><NButton size="small" :disabled="busy" @click="open('identity')">创建身份</NButton></template>
        <NEmpty v-if="!identities.length" description="暂无身份。" />
        <ul v-else class="workspace-list">
          <li v-for="identity in identities" :key="identity.id" class="workspace-row">
            <span>{{ identity.profile?.displayName || identity.slug }} <NTag size="small">{{ status(identity.status) }}</NTag></span>
            <div v-if="admin" class="workspace-actions">
              <NButton size="small" :disabled="busy || !identity.version" @click="open('identity-edit', identity)">编辑</NButton>
              <NButton size="small" :disabled="busy" @click="open('control', undefined,
                { scope: 'IDENTITY', id: identity.id, name: identity.profile?.displayName || identity.slug, status: identity.status })">
                {{ identity.status === 'ACTIVE' ? '暂停身份' : '恢复身份' }}
              </NButton>
            </div>
          </li>
        </ul>
      </NCard>
      <NCard title="平台账号" size="small">
        <template v-if="admin" #header-extra>
          <NButton size="small" :disabled="busy || !identities.length || !workspace.simulationPlatforms.length"
            @click="open('account')">登记模拟账号</NButton>
        </template>
        <NAlert v-if="admin && !workspace.simulationPlatforms.length" type="warning">当前部署未启用模拟适配器。</NAlert>
        <NEmpty v-if="!accounts.length" description="暂无平台账号。" />
        <ul v-else class="workspace-list">
          <li v-for="account in accounts" :key="account.id" class="workspace-row">
            <span>{{ account.platform }} · {{ account.instanceKey }} ·
              {{ identities.find(item => item.id === account.identityId)?.profile?.displayName
                || identities.find(item => item.id === account.identityId)?.slug }}
              <NTag size="small">{{ status(account.status) }}</NTag>
            </span>
            <NButton v-if="admin && ['mock-a', 'mock-b'].includes(account.platform) && ['ACTIVE', 'PAUSED'].includes(account.status)"
              size="small" :disabled="busy" @click="open('control', undefined,
                { scope: 'ACCOUNT', id: account.id, name: account.platform + ' · ' + account.instanceKey, status: account.status })">
              {{ account.status === 'ACTIVE' ? '暂停账号' : '恢复账号' }}
            </NButton>
          </li>
        </ul>
      </NCard>
    </template>
  </div>
</template>

<style scoped>
.character-workspace { display: grid; gap: 1rem; margin-top: 1rem; }
.workspace-actions, .workspace-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.workspace-row { justify-content: space-between; overflow-wrap: anywhere; }
.workspace-list { list-style: none; margin: 0; padding: 0; }
.workspace-list > li + li { border-top: 1px solid #e0e8e7; margin-top: .5rem; padding-top: .5rem; }
</style>
