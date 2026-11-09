<script setup lang="ts">
import { nextTick, onMounted, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, identityView, memoryProvenanceView, memoryView } from '../../packages/contracts/management.js'
import MemoryGrantWorkspace from './MemoryGrantWorkspace.vue'
import { characterPath, focusRecord, formatTime, queryPath, readAll, useConsoleTask, type Page } from './console-data.js'
import { request, RequestError } from './request.js'

type Memory = z.infer<typeof memoryView>
type Provenance = z.infer<typeof memoryProvenanceView>
type Identity = z.infer<typeof identityView>
type Account = z.infer<typeof accountView>
const props = defineProps<{ characterId: string; canEdit: boolean; detailId?: string }>()
const emit = defineEmits<{ expired: []; open: [id?: string] }>()
const { busy, error, notice, active, run, command } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const rows = ref<Memory[]>([])
const cursor = ref<string | null>(null)
const selected = ref<Memory>()
const listHeading = ref<HTMLElement>()
const detailHeading = ref<HTMLElement>()
const copied = ref(false)
const provenance = ref<Provenance>()
const filters = reactive({ identityId: '', scope: '', status: '' })
let applied = { ...filters }
const correcting = ref(false)
const content = ref('')
const reason = ref('')
const scopeOptions = [
  { value: 'CORE', label: '核心' }, { value: 'IDENTITY', label: '身份' },
  { value: 'ACCOUNT', label: '账号' }, { value: 'CONVERSATION', label: '会话' },
]
const visibilityLabels: Record<string, string> = {
  PUBLIC: '公开', PERSONAL: '个人', CONFIDENTIAL: '机密', RESTRICTED: '受限',
}

function scopeName(scope: string) {
  return scopeOptions.find((item) => item.value === scope)?.label ?? scope
}

function statusName(status: string) {
  return statusOptions.find((item) => item.value === status)?.label ?? status
}

function accountName(id: string | null) {
  const account = accounts.value.find((item) => item.id === id)
  return account ? account.platform + ' · ' + account.instanceKey : undefined
}

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    if (active() && props.detailId === id) copied.value = true
  } catch {
    if (active() && props.detailId === id) error.value = '无法复制，请从详情中手动复制记忆 ID。'
  }
}

const statusOptions = [{ value: 'ACTIVE', label: '有效' }, { value: 'REVOKED', label: '已撤销' }]

function name(id: string | null) {
  const identity = identities.value.find((item) => item.id === id)
  return identity?.profile?.displayName || identity?.slug || id
}

async function list(append = false) {
  const page = await request<Page<Memory>>(queryPath(base + '/memories', { ...applied, cursor: append ? cursor.value : null }))
  if (!active()) return
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

function apply() {
  applied = { ...filters }
  rows.value = []
  cursor.value = null
  void run(() => list())
}

let selection = 0
const detailError = ref('')
const loadingDetail = ref(false)
async function detail(id = props.detailId) {
  const revision = ++selection
  provenance.value = undefined
  selected.value = undefined
  detailError.value = ''
  loadingDetail.value = !!id
  if (!id) return
  try {
    const result = await request<{ memory: Memory; provenance: Provenance }>(base + '/memories/' + id)
    if (!active() || revision !== selection) return
    selected.value = result.memory
    provenance.value = result.provenance
  } catch (cause) {
    if (!active() || revision !== selection) return
    if (cause instanceof RequestError && cause.status === 401) emit('expired')
    else detailError.value = '无法读取当前角色的记忆详情。'
  } finally { if (revision === selection) loadingDetail.value = false }
}

watch(() => props.detailId, (id, previous) => {
  correcting.value = false
  content.value = ''
  reason.value = ''
  notice.value = ''
  copied.value = false
  void detail(id)
  void nextTick(() => {
    if (active() && id === props.detailId) focusRecord('memory-row-', id, previous, detailHeading.value, listHeading.value)
  })
}, { immediate: true })

function correct() {
  const current = provenance.value
  if (!props.canEdit || !current || !content.value.trim() || !reason.value.trim()) return
  void run(async () => {
    await command(base + '/memories/' + current.id + '/correction',
      { content: content.value.trim(), reason: reason.value.trim() }, 'PUT', current.revision)
    if (!active() || props.detailId !== current.id) return
    correcting.value = false
    content.value = ''
    reason.value = ''
    notice.value = '记忆修订已保存。'
    await Promise.all([detail(current.id), list()])
  })
}

onMounted(() => {
  void run(async () => {
    const [names, bindings] = await Promise.all([readAll<Identity>(base + '/identities', active), readAll<Account>(base + '/accounts', active), list()])
    if (active()) { identities.value = names; accounts.value = bindings }
  })
})
</script>

<template>
  <div class="console-split" :class="{ 'console-split--detail': detailId }">
    <section class="console-split-list" aria-labelledby="memory-list-heading">
      <div class="console-section-heading">
        <h3 id="memory-list-heading" ref="listHeading" tabindex="-1">记忆列表</h3>
        <NButton size="small" quaternary :disabled="busy" @click="run(() => list())">刷新列表</NButton>
      </div>
      <NAlert v-if="error && !detailId" type="error" role="alert">{{ error }}</NAlert>
      <NForm @submit.prevent="apply">
        <div class="console-form-grid">
          <NFormItem label="身份" :label-props="{ for: 'memory-identity' }">
            <NSelect placeholder="全部身份" filterable clearable :value="filters.identityId || null"
              :options="identities.map(({ id }) => ({ value: id, label: name(id) ?? id }))"
              :disabled="busy" :input-props="{ id: 'memory-identity' }" @update:value="filters.identityId = $event ?? ''" />
          </NFormItem>
          <NFormItem label="记忆范围" :label-props="{ for: 'memory-scope' }">
            <NSelect placeholder="全部范围" filterable clearable :value="filters.scope || null" :options="scopeOptions" :disabled="busy"
              :input-props="{ id: 'memory-scope' }" @update:value="filters.scope = $event ?? ''" />
          </NFormItem>
          <NFormItem label="状态" :label-props="{ for: 'memory-status' }">
            <NSelect placeholder="全部状态" filterable clearable :value="filters.status || null" :options="statusOptions" :disabled="busy"
              :input-props="{ id: 'memory-status' }" @update:value="filters.status = $event ?? ''" />
          </NFormItem>
        </div>
        <NButton attr-type="submit" size="small" :disabled="busy">筛选记忆</NButton>
      </NForm>
      <NSpin v-if="busy && !rows.length" />
      <NEmpty v-else-if="!rows.length && !error" description="暂无符合条件的记忆。" />
      <ul v-if="rows.length" class="console-select-list">
        <li v-for="row in rows" :key="row.id">
          <button :id="'memory-row-' + row.id" type="button" class="console-record" :disabled="busy"
            :aria-current="detailId === row.id ? 'true' : undefined" @click="emit('open', row.id)">
            <span class="console-record-main">
              <strong>{{ scopeName(row.scope) }}记忆<template v-if="row.identityId"> · {{ name(row.identityId) }}</template></strong>
              <span v-if="accountName(row.accountId)">{{ accountName(row.accountId) }}</span>
            </span>
            <span class="console-record-meta">
              <NTag size="small" :bordered="false">{{ statusName(row.status) }} · {{ visibilityLabels[row.visibility] ?? row.visibility }}</NTag>
              <time v-if="row.createdAt" :datetime="row.createdAt">{{ formatTime(row.createdAt) }}</time>
            </span>
          </button>
        </li>
      </ul>
      <NButton v-if="cursor" size="small" :disabled="busy" @click="run(() => list(true))">加载更多记忆</NButton>
    </section>

    <section v-if="detailId" class="console-split-detail" aria-labelledby="memory-detail-heading">
      <div class="console-section-heading">
        <h3 id="memory-detail-heading" ref="detailHeading" tabindex="-1">记忆详情</h3>
        <NButton size="small" quaternary :disabled="busy" @click="emit('open')">返回记忆列表</NButton>
      </div>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
      <NAlert v-if="detailError" type="error" role="alert">{{ detailError }}</NAlert>
      <NButton v-if="detailError" size="small" @click="detail()">重新加载详情</NButton>
      <NSpin v-if="loadingDetail" aria-label="正在加载记忆详情" />
      <template v-if="selected && provenance">
        <div class="console-actions">
          <NTag size="small" :bordered="false">{{ scopeName(selected.scope) }} · {{ statusName(provenance.status) }}</NTag>
          <NTag size="small" :bordered="false">{{ visibilityLabels[selected.visibility] ?? selected.visibility }}</NTag>
          <span>版本 {{ provenance.revision }}</span>
        </div>
        <p v-if="selected.identityId">身份 {{ name(selected.identityId) }}</p>
        <p v-if="selected.accountId">账号 {{ accountName(selected.accountId) ?? selected.accountId }}</p>
        <p v-if="selected.expiresAt">到期 {{ formatTime(selected.expiresAt) }}</p>
        <div class="console-actions">
          <NButton v-if="provenance.parentMemoryId" size="small" quaternary :disabled="busy"
            @click="emit('open', provenance.parentMemoryId)">查看原记忆</NButton>
        </div>
        <h4>来源</h4>
        <NEmpty v-if="!provenance.sources.length" description="暂无来源。" />
        <ul v-else class="console-record-list">
          <li v-for="source in provenance.sources" :key="source.id">
            <div class="console-actions">{{ source.kind }} <NTag size="small">{{ visibilityLabels[source.classification] }}</NTag>
              <NTag v-if="source.revokedAt" size="small">已撤销</NTag></div>
            <span>{{ source.id }}</span>
          </li>
        </ul>
        <h4>修订</h4>
        <ul v-if="provenance.corrections.length" class="console-record-list">
          <li v-for="item in provenance.corrections" :key="item.revision">v{{ item.revision }} · {{ item.reason }} · {{ formatTime(item.createdAt) }}</li>
        </ul>
        <NEmpty v-else description="暂无纠错记录。" />
        <div class="console-actions">
          <NButton v-if="canEdit && provenance.status === 'ACTIVE' && !correcting" size="small" :disabled="busy"
            @click="correcting = true">纠正记忆</NButton>
          <NButton v-if="correcting" size="small" :disabled="busy" @click="detail()">重新读取修订</NButton>
        </div>
        <NForm v-if="correcting" @submit.prevent="correct">
          <NFormItem label="更正后的正文" :label-props="{ for: 'memory-correction' }">
            <NInput placeholder="输入更正后应保留的内容" v-model:value="content" type="textarea" maxlength="1500" :disabled="busy" :input-props="{ id: 'memory-correction' }" />
          </NFormItem>
          <NFormItem label="纠错理由" :label-props="{ for: 'memory-reason' }">
            <NInput placeholder="例如：原记录把时间写错了" v-model:value="reason" maxlength="240" :disabled="busy" :input-props="{ id: 'memory-reason' }" />
          </NFormItem>
          <div class="console-actions">
            <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!content.trim() || !reason.trim()">保存修订</NButton>
            <NButton :disabled="busy" @click="correcting = false">取消</NButton>
          </div>
        </NForm>
        <MemoryGrantWorkspace v-if="canEdit" :key="selected.id" :character-id="characterId" :memory="selected"
          :identities="identities" :accounts="accounts" @expired="emit('expired')" />
        <details class="memory-identifiers">
          <summary>记录标识</summary>
          <p>记忆 ID {{ selected.id }}</p>
          <p v-if="selected.conversationId">会话 ID {{ selected.conversationId }}</p>
          <NButton size="small" @click="copyId(selected.id)">{{ copied ? '已复制' : '复制记忆 ID' }}</NButton>
        </details>
      </template>
    </section>
  </div>
</template>

<style scoped>
.console-split-detail { overflow-wrap: anywhere; }
.memory-identifiers { margin-top: 1rem; color: #485c5b; }
.memory-identifiers summary { cursor: pointer; }
</style>
