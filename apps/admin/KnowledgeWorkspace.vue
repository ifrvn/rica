<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, identityView, memoryProvenanceView, memoryView } from '../../packages/contracts/management.js'
import MemoryGrantWorkspace from './MemoryGrantWorkspace.vue'
import { characterPath, formatTime, queryPath, readAll, useConsoleTask, type Page } from './console-data.js'
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

watch(() => props.detailId, (id) => {
  correcting.value = false
  content.value = ''
  reason.value = ''
  notice.value = ''
  void detail(id)
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
  <section class="console-workspace console-stack" aria-label="记忆与授权">
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NAlert v-if="detailError" type="error" role="alert">{{ detailError }}</NAlert>
    <NSpin v-if="loadingDetail" />
    <template v-if="selected && provenance">
      <NCard title="记忆详情" size="small">
        <template #header-extra><NButton size="small" :disabled="busy" @click="emit('open')">关闭详情</NButton></template>
        <p>{{ scopeOptions.find(item => item.value === selected?.scope)?.label }} · {{ selected.visibility }} · v{{ provenance.revision }} ·
          {{ statusOptions.find(item => item.value === provenance?.status)?.label }}</p>
        <p>{{ selected.id }}<template v-if="selected.identityId"> · {{ name(selected.identityId) }}</template></p>
        <p v-if="selected.accountId">账号 {{ accounts.find(({ id }) => id === selected?.accountId)?.instanceKey ?? selected.accountId }}</p>
        <p v-if="selected.conversationId">会话 {{ selected.conversationId }}</p>
        <p v-if="selected.expiresAt">到期 {{ formatTime(selected.expiresAt) }}</p>
        <NButton v-if="provenance.parentMemoryId" size="small" :disabled="busy" @click="emit('open', provenance.parentMemoryId)">打开父记忆</NButton>
        <h3>来源</h3>
        <NEmpty v-if="!provenance.sources.length" description="暂无来源。" />
        <ul v-else class="console-record-list">
          <li v-for="source in provenance.sources" :key="source.id">
            <div class="console-actions">{{ source.kind }} <NTag size="small">{{ source.classification }}</NTag>
              <NTag v-if="source.revokedAt" size="small">已撤销</NTag></div>
            <span>{{ source.id }}</span>
          </li>
        </ul>
        <h3>修订</h3>
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
            <NInput v-model:value="content" type="textarea" maxlength="1500" :disabled="busy" :input-props="{ id: 'memory-correction' }" />
          </NFormItem>
          <NFormItem label="纠错理由" :label-props="{ for: 'memory-reason' }">
            <NInput v-model:value="reason" maxlength="240" :disabled="busy" :input-props="{ id: 'memory-reason' }" />
          </NFormItem>
          <div class="console-actions">
            <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!content.trim() || !reason.trim()">保存修订</NButton>
            <NButton :disabled="busy" @click="correcting = false">取消</NButton>
          </div>
        </NForm>
      </NCard>
      <MemoryGrantWorkspace v-if="canEdit" :key="selected.id" :character-id="characterId" :memory="selected"
        :identities="identities" :accounts="accounts" @expired="emit('expired')" />
    </template>
    <NCard title="记忆" size="small">
      <NForm @submit.prevent="apply">
        <div class="console-form-grid">
          <NFormItem label="身份" :label-props="{ for: 'memory-identity' }">
            <NSelect filterable clearable :value="filters.identityId || null"
              :options="identities.map(({ id }) => ({ value: id, label: name(id) ?? id }))"
              :disabled="busy" :input-props="{ id: 'memory-identity' }" @update:value="filters.identityId = $event ?? ''" />
          </NFormItem>
          <NFormItem label="作用域" :label-props="{ for: 'memory-scope' }">
            <NSelect filterable clearable :value="filters.scope || null" :options="scopeOptions" :disabled="busy"
              :input-props="{ id: 'memory-scope' }" @update:value="filters.scope = $event ?? ''" />
          </NFormItem>
          <NFormItem label="状态" :label-props="{ for: 'memory-status' }">
            <NSelect filterable clearable :value="filters.status || null" :options="statusOptions" :disabled="busy"
              :input-props="{ id: 'memory-status' }" @update:value="filters.status = $event ?? ''" />
          </NFormItem>
        </div>
        <NButton attr-type="submit" size="small" :disabled="busy">筛选记忆</NButton>
      </NForm>
      <NSpin v-if="busy && !rows.length" />
      <NEmpty v-else-if="!rows.length && !error" description="暂无符合条件的记忆。" />
      <ul v-if="rows.length" class="console-record-list">
        <li v-for="row in rows" :key="row.id">
          <div class="console-actions">
            <NButton size="small" quaternary :disabled="busy" @click="emit('open', row.id)">查看记忆 {{ row.id.slice(0, 8) }}</NButton>
            <NTag size="small">{{ scopeOptions.find(item => item.value === row.scope)?.label }}</NTag>
            <NTag size="small">{{ statusOptions.find(item => item.value === row.status)?.label }}</NTag>
            <span>{{ name(row.identityId) }}</span>
          </div>
        </li>
      </ul>
      <NButton v-if="cursor" size="small" :disabled="busy" @click="run(() => list(true))">加载更多记忆</NButton>
    </NCard>
  </section>
</template>
