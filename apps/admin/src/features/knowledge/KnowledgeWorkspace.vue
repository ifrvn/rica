<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiDialog, UiCombobox, UiSpinner, UiBadge } from '@rica/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, identityView, memoryProvenanceView, memoryView } from '../../../../../packages/contracts/management.js'
import MemoryGrantWorkspace from './MemoryGrantWorkspace.vue'
import { characterPath, focusRecord, formatTime, queryPath, readAll, useConsoleTask, type Page } from '@rica/console-shared/console-data'
import { request, RequestError } from '@rica/console-shared/request'

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
const splitLayout = window.matchMedia('(min-width: 66rem)')
const wide = ref(splitLayout.matches)
const previewId = computed(() => props.detailId ?? (wide.value ? rows.value[0]?.id : undefined))
const selected = ref<Memory>()
const listHeading = ref<HTMLElement>()
const detailHeading = ref<HTMLElement>()
const copied = ref(false)
const provenance = ref<Provenance>()
const filters = reactive({ identityId: '', scope: '', status: '' })
let applied = { ...filters }
const correcting = ref(false)
const correctionTrigger = ref<InstanceType<typeof UiButton>>()
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
    if (active() && previewId.value === id) copied.value = true
  } catch {
    if (active() && previewId.value === id) error.value = '无法复制，请从详情中手动复制记忆 ID。'
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
async function detail(id = previewId.value) {
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

watch(previewId, (id) => {
  correcting.value = false
  content.value = ''
  reason.value = ''
  notice.value = ''
  copied.value = false
  void detail(id)
}, { immediate: true })

watch(() => props.detailId, (id, previous) => {
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
    if (!active() || previewId.value !== current.id) return
    correcting.value = false
    content.value = ''
    reason.value = ''
    notice.value = '记忆修订已保存。'
    await Promise.all([detail(current.id), list()])
  })
}

function syncLayout(event: MediaQueryListEvent) { wide.value = event.matches }
onBeforeUnmount(() => splitLayout.removeEventListener('change', syncLayout))

onMounted(() => {
  splitLayout.addEventListener('change', syncLayout)
  wide.value = splitLayout.matches
  void run(async () => {
    const [names, bindings] = await Promise.all([readAll<Identity>(base + '/identities', active), readAll<Account>(base + '/accounts', active), list()])
    if (active()) { identities.value = names; accounts.value = bindings }
  })
})
</script>

<template>
  <div class="memory-layout" :class="{ 'memory-layout--split': wide && previewId }">
    <section v-if="wide || !detailId" class="console-card console-stack memory-list" aria-labelledby="memory-list-heading">
      <div class="console-section-heading">
        <h3 id="memory-list-heading" ref="listHeading" tabindex="-1">记忆列表</h3>
        <UiButton size="small" variant="quiet" :disabled="busy" @click="run(() => list())">刷新列表</UiButton>
      </div>
      <UiAlert v-if="error && !previewId" tone="error" role="alert">{{ error }}</UiAlert>
      <details class="memory-filters">
        <summary>筛选记忆</summary>
        <form @submit.prevent="apply">
          <div class="console-form-grid">
            <UiField label="身份" for="memory-identity">
              <UiCombobox placeholder="全部身份" clearable :model-value="filters.identityId || null"
                :options="identities.map(({ id }) => ({ value: id, label: name(id) ?? id }))"
                :disabled="busy" :input-attrs="{ id: 'memory-identity' }" @update:model-value="filters.identityId = $event ?? ''" />
            </UiField>
            <UiField label="记忆范围" for="memory-scope">
              <UiCombobox placeholder="全部范围" clearable :model-value="filters.scope || null" :options="scopeOptions" :disabled="busy"
                :input-attrs="{ id: 'memory-scope' }" @update:model-value="filters.scope = $event ?? ''" />
            </UiField>
            <UiField label="状态" for="memory-status">
              <UiCombobox placeholder="全部状态" clearable :model-value="filters.status || null" :options="statusOptions" :disabled="busy"
                :input-attrs="{ id: 'memory-status' }" @update:model-value="filters.status = $event ?? ''" />
            </UiField>
          </div>
          <UiButton type="submit" size="small" :disabled="busy">筛选记忆</UiButton>
        </form>
      </details>
      <UiSpinner v-if="busy && !rows.length" />
      <UiEmpty v-else-if="!rows.length && !error" description="暂无符合条件的记忆。" />
      <ul v-if="rows.length" class="console-select-list">
        <li v-for="row in rows" :key="row.id">
          <button :id="'memory-row-' + row.id" type="button" class="console-record" :disabled="busy"
            :aria-current="previewId === row.id ? 'true' : undefined" @click="emit('open', row.id)">
            <span class="console-record-main">
              <strong>{{ scopeName(row.scope) }}记忆<template v-if="row.identityId"> · {{ name(row.identityId) }}</template></strong>
              <span v-if="accountName(row.accountId)">{{ accountName(row.accountId) }}</span>
            </span>
            <span class="console-record-meta">
              <UiBadge>{{ statusName(row.status) }} · {{ visibilityLabels[row.visibility] ?? row.visibility }}</UiBadge>
              <time v-if="row.createdAt" :datetime="row.createdAt">{{ formatTime(row.createdAt) }}</time>
            </span>
          </button>
        </li>
      </ul>
      <UiButton v-if="cursor" size="small" :disabled="busy" @click="run(() => list(true))">加载更多记忆</UiButton>
    </section>

    <section v-if="previewId" class="console-card console-stack memory-detail" aria-labelledby="memory-detail-heading">
      <div class="console-section-heading">
        <h3 id="memory-detail-heading" ref="detailHeading" tabindex="-1">记忆详情</h3>
        <UiButton v-if="!wide || detailId" size="small" variant="quiet" :disabled="busy" @click="emit('open')">返回记忆列表</UiButton>
      </div>
      <UiAlert v-if="error && !correcting" tone="error" role="alert">{{ error }}</UiAlert>
      <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
      <UiAlert v-if="detailError && !correcting" tone="error" role="alert">{{ detailError }}</UiAlert>
      <UiButton v-if="detailError && !correcting" size="small" @click="detail()">重新加载详情</UiButton>
      <UiSpinner v-if="loadingDetail" aria-label="正在加载记忆详情" />
      <template v-if="selected && provenance">
        <div class="console-actions">
          <UiBadge>{{ scopeName(selected.scope) }} · {{ statusName(provenance.status) }}</UiBadge>
          <UiBadge>{{ visibilityLabels[selected.visibility] ?? selected.visibility }}</UiBadge>
          <UiBadge>版本 {{ provenance.revision }}</UiBadge>
        </div>
        <dl class="memory-facts">
          <div v-if="selected.identityId"><dt>归属身份</dt><dd>{{ name(selected.identityId) }}</dd></div>
          <div v-if="selected.accountId"><dt>平台账号</dt><dd>{{ accountName(selected.accountId) ?? selected.accountId }}</dd></div>
          <div><dt>记录时间</dt><dd>{{ formatTime(selected.createdAt) }}</dd></div>
          <div v-if="selected.expiresAt"><dt>到期时间</dt><dd>{{ formatTime(selected.expiresAt) }}</dd></div>
        </dl>
        <div class="console-actions">
          <UiButton v-if="canEdit && provenance.status === 'ACTIVE'" ref="correctionTrigger" size="small" :disabled="busy"
            @click="correcting = true; error = ''">纠正记忆</UiButton>
          <UiButton v-if="provenance.parentMemoryId" size="small" variant="quiet" :disabled="busy"
            @click="emit('open', provenance.parentMemoryId)">查看原记忆</UiButton>
        </div>
        <h4>来源</h4>
        <UiEmpty v-if="!provenance.sources.length" description="暂无来源。" />
        <ul v-else class="console-record-list">
          <li v-for="source in provenance.sources" :key="source.id">
            <div class="console-actions">{{ source.kind }} <UiBadge>{{ visibilityLabels[source.classification] }}</UiBadge>
              <UiBadge v-if="source.revokedAt">已撤销</UiBadge></div>
            <span>{{ source.id }}</span>
          </li>
        </ul>
        <details v-if="provenance.corrections.length">
          <summary>纠错记录（{{ provenance.corrections.length }}）</summary>
          <ul class="console-group-list">
            <li v-for="item in provenance.corrections" :key="item.revision" class="console-group-row">
              <div>版本 {{ item.revision }} · {{ item.reason }}</div>
              <time class="console-group-meta" :datetime="item.createdAt">{{ formatTime(item.createdAt) }}</time>
            </li>
          </ul>
        </details>
        <MemoryGrantWorkspace v-if="canEdit" :key="selected.id" :character-id="characterId" :memory="selected"
          :identities="identities" :accounts="accounts" @expired="emit('expired')" />
        <details class="memory-identifiers">
          <summary>记录标识</summary>
          <p>记忆 ID {{ selected.id }}</p>
          <p v-if="selected.conversationId">会话 ID {{ selected.conversationId }}</p>
          <UiButton size="small" @click="copyId(selected.id)">{{ copied ? '已复制' : '复制记忆 ID' }}</UiButton>
        </details>
      </template>
    </section>
  </div>
  <UiDialog :open="correcting" title="纠正记忆"
    class="knowledge-dialog" :busy="busy"
    @update:open="show => { if (!show) correcting = false }"
    @closed="correctionTrigger?.$el?.focus()">
    <form @submit.prevent="correct">
      <UiAlert v-if="error || detailError" class="correction-error" tone="error" role="alert">{{ error || detailError }}</UiAlert>
      <UiField label="更正后的正文" for="memory-correction">
        <textarea class="ui-control" placeholder="输入更正后应保留的内容" v-model="content" maxlength="1500" :disabled="busy" v-bind="{ id: 'memory-correction' }"></textarea>
      </UiField>
      <UiField label="纠错理由" for="memory-reason">
        <input class="ui-control" placeholder="例如：原记录把时间写错了" v-model="reason" maxlength="240" :disabled="busy" v-bind="{ id: 'memory-reason' }" />
      </UiField>
      <div class="console-actions correction-actions">
        <UiButton tone="primary" type="submit" :loading="busy" :disabled="busy || loadingDetail || !provenance || !content.trim() || !reason.trim()">保存修订</UiButton>
        <UiButton variant="quiet" :disabled="busy || loadingDetail" @click="detail()">重新读取修订</UiButton>
        <UiButton :disabled="busy" @click="correcting = false">取消</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.memory-layout { display: grid; gap: 1rem; align-items: start; min-width: 0; }
.memory-layout--split { grid-template-columns: minmax(16rem, 1fr) minmax(0, 2fr); }
.memory-list .console-select-list { margin: 0; }
.memory-list .console-record { padding: .875rem .75rem; }
.memory-list > .ui-button, .memory-detail > .ui-button { justify-self: start; }
.memory-filters form { margin-top: .75rem; }
.memory-detail :is(h4, p, dl) { margin: 0; }
.memory-detail summary, .memory-filters summary { width: fit-content; cursor: pointer; color: var(--console-muted); }
.memory-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: .75rem; }
.memory-facts dt { font-size: .875rem; color: var(--console-muted); }
.memory-facts dd { margin: .2rem 0 0; }
.memory-identifiers p { margin-top: .5rem; }
.correction-error { margin-bottom: .75rem; }
.correction-actions { justify-content: flex-end; }
</style>
