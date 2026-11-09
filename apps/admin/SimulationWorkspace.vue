<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NSelect, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, identityView } from '../../packages/contracts/management.js'
import type { runReplayView, simulationRunSummary } from '../../packages/contracts/simulation-observability.js'
import SimulationReconciliation from './SimulationReconciliation.vue'
import type { ReconciliationView } from '../../packages/contracts/action-review.js'
import { request, RequestError } from './request.js'

type Run = z.infer<typeof simulationRunSummary>
type Replay = z.infer<typeof runReplayView>
type Account = z.infer<typeof accountView>
type Character = z.infer<typeof characterWorkspaceView>
type Identity = z.infer<typeof identityView>
type Page<T> = { items: T[]; nextCursor: string | null }

const props = defineProps<{ characterId: string; canStart: boolean; detailId?: string }>()
const emit = defineEmits<{ expired: []; open: [id: string]; audit: [id: string] }>()
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const rows = ref<Run[]>([])
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const character = ref<Character>()
const cursor = ref<string | null>(null)
const selected = ref<Replay>()
const selectedPlatform = computed(() => selected.value?.proposal?.adapterId
  ?? accounts.value.find(({ id }) => id === selected.value?.accountId)?.platform ?? '—')
const detailError = ref('')
const resolutionNotice = ref('')
let detailRevision = 0
const accountId = ref('')
const message = ref('')
const busy = ref(false)
const error = ref('')
const loadingError = ref('')
const showForm = ref(false)
let pending: { body: string; key: string } | undefined
let active = true
onBeforeUnmount(() => { active = false })

const stateLabels: Record<string, string> = {
  QUEUED: '已排队', CONTEXT_READY: '准备草稿', WAITING_APPROVAL: '待审批', READY: '待执行',
  EXECUTING: '执行中', RECONCILING: '待对账', SIMULATED: '模拟完成',
  REJECTED: '已拒绝', BLOCKED: '已拦截', CANCELED: '已取消', EXPIRED: '已过期',
}

function identityName(id: string) {
  const identity = identities.value.find((item) => item.id === id)
  return identity?.profile?.displayName || identity?.slug || id
}

const options = computed(() => accounts.value.filter((item) => item.status === 'ACTIVE'
  && character.value?.status === 'ACTIVE'
  && character.value.simulationPlatforms.some((platform) => platform === item.platform)
  && identities.value.some((identity) => identity.id === item.identityId && identity.status === 'ACTIVE')).map((item) => ({
  value: item.id, label: identityName(item.identityId) + ' · ' + item.platform + ' · ' + item.instanceKey,
})))

async function all<T>(path: string) {
  const items: T[] = []
  let next: string | null = null
  do {
    const page: Page<T> = await request(path + '?limit=100' + (next ? '&cursor=' + encodeURIComponent(next) : ''))
    items.push(...page.items)
    next = page.nextCursor
  } while (next && active)
  return items
}

async function list(append = false) {
  const query = append && cursor.value ? '?cursor=' + encodeURIComponent(cursor.value) : ''
  const page = await request<Page<Run>>(base.value + '/runs' + query)
  if (!active) return
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

async function detail(id?: string) {
  const current = ++detailRevision
  selected.value = undefined
  detailError.value = ''
  if (!id) return
  try {
    const view = await request<Replay>(base.value + '/runs/' + encodeURIComponent(id) + '/replay')
    if (active && current === detailRevision) selected.value = view
  } catch (cause) {
    if (!active || current !== detailRevision) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) emit('expired')
    else detailError.value = status === 403 || status === 404 ? '找不到该角色的运行详情。' : '无法读取运行详情，请刷新后重试。'
  }
}

watch(() => props.detailId, (id) => {
  resolutionNotice.value = ''
  void detail(id)
}, { immediate: true })

async function act(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await task() }
  catch (cause) {
    if (!active) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) { emit('expired'); return }
    if (status === 403 || status === 404) selected.value = undefined
    error.value = ({
      403: '当前账号无权执行此操作。', 404: '找不到该角色的运行或模拟账号。',
      409: '模拟账号、身份或角色不可用，请检查状态及已启用的适配器。',
      422: '请核对模拟消息和账号。',
    } as Record<number, string>)[status] ?? '操作未完成，请重试。'
  } finally { busy.value = false }
}

async function load() {
  loadingError.value = ''
  await Promise.all([
    list(),
    Promise.all([
      all<Identity>(base.value + '/identities'),
      all<Account>(base.value + '/accounts'),
      props.canStart ? request<Character>(base.value) : Promise.resolve(undefined),
    ]).then(([names, choices, current]) => {
      if (active) { identities.value = names; accounts.value = choices; character.value = current }
    })
      .catch((cause) => {
        if (cause instanceof RequestError && cause.status === 401) throw cause
        if (active) loadingError.value = '无法加载身份和账号，刷新后可重试。'
      }),
  ])
}

function refresh() {
  void act(async () => {
    await Promise.all([load(), detail(props.detailId)])
  })
}

function reconciled(outcome: NonNullable<ReconciliationView['outcome']>) {
  resolutionNotice.value = outcome === 'CONFIRMED' ? '已确认模拟回执。' : '已按未写入回执结案。'
  void detail(props.detailId)
  void act(() => list())
}

function start() {
  if (!props.canStart || !options.value.some(({ value }) => value === accountId.value) || !message.value.trim()) return
  const body = JSON.stringify({ accountId: accountId.value, message: message.value.trim() })
  if (pending?.body !== body) pending = { body, key: crypto.randomUUID() }
  const key = pending.key
  void act(async () => {
    const result = await request<{ id: string }>(base.value + '/runs', {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    })
    if (!active) return
    showForm.value = false
    message.value = ''
    pending = undefined
    emit('open', result.id)
    await list()
  })
}

onMounted(() => { void act(load) })
</script>

<template>
  <section class="simulation-workspace" aria-label="模拟运行">
    <div class="run-actions">
      <NButton v-if="canStart && !showForm" type="primary" :disabled="busy || !options.length"
        @click="showForm = true">运行一次模拟</NButton>
      <NButton :disabled="busy" @click="refresh">刷新</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="resolutionNotice" type="success" role="status">{{ resolutionNotice }}</NAlert>
    <NAlert v-if="detailError" type="error" role="alert">{{ detailError }}</NAlert>
    <NAlert v-if="loadingError" type="warning" role="status">{{ loadingError }}</NAlert>
    <NAlert v-if="canStart && !busy && !options.length && !loadingError" type="info">请先在角色与身份页启用角色、身份和可用的模拟账号。</NAlert>
    <NCard v-if="showForm" title="运行一次模拟" size="small">
      <NForm @submit.prevent="start">
        <NFormItem label="模拟账号" :label-props="{ for: 'run-account' }">
          <NSelect v-model:value="accountId" :options="options" :input-props="{ id: 'run-account' }" :disabled="busy" />
        </NFormItem>
        <NFormItem label="模拟消息" :label-props="{ for: 'run-message' }">
          <NInput v-model:value="message" type="textarea" :rows="3" :input-props="{ id: 'run-message' }"
            :maxlength="4000" :disabled="busy" />
        </NFormItem>
        <div class="run-actions">
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !accountId || !message.trim()">发起模拟</NButton>
          <NButton :disabled="busy" @click="showForm = false">取消</NButton>
        </div>
      </NForm>
    </NCard>
    <NCard v-if="selected" title="运行详情" size="small">
      <div class="run-actions">
        <NTag size="small">模拟</NTag>
        <NTag size="small">{{ stateLabels[selected.state] || selected.state }}</NTag>
        <NButton size="small" quaternary @click="emit('audit', selected.id)">查看相关审计</NButton>
      </div>
      <dl>
        <div><dt>身份</dt><dd>{{ identityName(selected.identityId) }}</dd></div>
        <div><dt>平台</dt><dd>{{ selectedPlatform }}</dd></div>
        <div><dt>运行 ID</dt><dd>{{ selected.id }}</dd></div>
        <div><dt>审批</dt><dd>{{ selected.proposal?.reviewDecision === 'APPROVE' ? '已批准'
          : selected.proposal?.reviewDecision === 'REJECT' ? '已拒绝' : '暂无决定' }}</dd></div>
        <div><dt>模拟回执</dt><dd>{{ selected.proposal?.receiptAt
          ? new Date(selected.proposal.receiptAt).toLocaleString() : '暂无回执' }}</dd></div>
      </dl>
    </NCard>
    <SimulationReconciliation v-if="canStart && selected?.state === 'RECONCILING' && selected.proposal"
      :key="selected.proposal.id" :character-id="characterId" :action-id="selected.proposal.id"
      @expired="emit('expired')" @resolved="reconciled" />
    <NCard title="最近运行" size="small">
      <NEmpty v-if="!rows.length && !busy && !error" description="暂无模拟运行。" />
      <ul v-if="rows.length" class="run-list">
        <li v-for="item in rows" :key="item.id" class="run-actions">
          <NButton quaternary :disabled="busy" :aria-pressed="selected?.id === item.id"
            @click="emit('open', item.id)">
            {{ new Date(item.createdAt).toLocaleString() }}
          </NButton>
          <span>{{ identityName(item.identityId) }} · {{ item.platform }}</span>
          <NTag size="small">{{ stateLabels[item.state] || item.state }}</NTag>
        </li>
      </ul>
      <NButton v-if="cursor" size="small" :disabled="busy" @click="act(() => list(true))">加载更多</NButton>
    </NCard>
  </section>
</template>

<style scoped>
.simulation-workspace { display: grid; gap: 1rem; margin-top: 1rem; }
.run-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; overflow-wrap: anywhere; }
.run-list { list-style: none; margin: 0 0 .5rem; padding: 0; }
.run-list li + li { border-top: 1px solid #e0e8e7; }
dl { display: grid; gap: .5rem; }
dl > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .5rem; }
dd { margin: 0; overflow-wrap: anywhere; }
</style>
