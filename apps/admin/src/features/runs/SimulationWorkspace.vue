<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiCombobox, UiSpinner, UiBadge } from '@rica/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, identityView } from '../../../../../packages/contracts/management.js'
import type { runReplayView, simulationRunQuery, simulationRunSummary } from '../../../../../packages/contracts/simulation-observability.js'
import SimulationReconciliation from './SimulationReconciliation.vue'
import { simulationAccounts } from './simulation-accounts.js'
import { readAll } from '@rica/console-shared/console-data'
import type { ReconciliationView } from '../../../../../packages/contracts/action-review.js'
import { runFilterKeys } from '../../app/console-location.js'
import { request, RequestError } from '@rica/console-shared/request'

type Run = z.infer<typeof simulationRunSummary>
type Replay = z.infer<typeof runReplayView>
type Account = z.infer<typeof accountView>
type Character = z.infer<typeof characterWorkspaceView>
type Identity = z.infer<typeof identityView>
type Page<T> = { items: T[]; nextCursor: string | null }

const props = defineProps<{ characterId: string; canStart: boolean; canReview: boolean; detailId?: string; runQuery: string; showForm: boolean }>()
const emit = defineEmits<{ expired: []; open: [id?: string]; review: [id: string]; audit: [id: string]; commitment: [id: string];
  filter: [query: string]; form: [open: boolean]; executorHealth: []; identities: [] }>()
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const rows = ref<Run[]>([])
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const character = ref<Character>()
const cursor = ref<string | null>(null)
const splitLayout = window.matchMedia('(min-width: 66rem)')
const wide = ref(splitLayout.matches)
const previewId = computed(() => props.detailId ?? (wide.value && !props.showForm ? rows.value[0]?.id : undefined))
const selected = ref<Replay>()
const modelName = computed(() => [selected.value?.draft?.modelId, selected.value?.draft?.modelVersion].filter(Boolean).join(' · '))
function accountName(id: string, platform?: string) {
  const account = accounts.value.find((item) => item.id === id)
  return account ? account.platform + ' · ' + account.instanceKey : platform ?? id
}
const timeline = computed(() => {
  if (!selected.value) return []
  const { state, inbound, draft, proposal, transcript } = selected.value
  const inboundKind = { POST: '发帖', REPLY: '回复', MENTION: '提及' }
  const review = proposal?.reviewDecision === 'APPROVE' ? '已批准'
    : proposal?.reviewDecision === 'REJECT' ? '已拒绝'
      : state === 'WAITING_APPROVAL' ? '待审批' : '无决定'
  const result = proposal?.receiptAt ? '已写入'
    : proposal?.attemptStatus === 'UNKNOWN' || state === 'RECONCILING' ? '待核对'
      : proposal?.attemptStatus === 'NOT_SENT' ? '已确认未写入' : '无回执'
  return [
    { label: '收到消息', status: inboundKind[inbound.kind], at: inbound.receivedAt, quote: transcript?.message },
    { label: '生成草稿', status: draft ? '已生成' : '无记录', at: draft?.createdAt, quote: transcript?.draft },
    { label: '人工审批', status: review, at: proposal?.reviewedAt ?? proposal?.createdAt, quote: transcript?.reviewReason },
    { label: '执行许可', status: proposal?.permittedAt ? '已发放' : state === 'READY' ? '等待发放' : '未发放', at: proposal?.permittedAt },
    { label: '模拟回执', status: result, at: proposal?.receiptAt },
  ]
})
const detailError = ref('')
const loadingDetail = ref(false)
const detailHeading = ref<HTMLElement>()
const listHeading = ref<HTMLElement>()
const editorHeading = ref<HTMLElement>()
const resolutionNotice = ref('')
let detailRevision = 0
let detailTimer: ReturnType<typeof setTimeout> | undefined
const progressingStates = new Set(['QUEUED', 'CONTEXT_READY', 'DRAFTED', 'WAITING_APPROVAL', 'READY', 'EXECUTING'])
const trackingRun = computed(() => !!selected.value && !detailError.value && progressingStates.has(selected.value.state))
const accountId = ref('')
const message = ref('')
const busy = ref(false)
const error = ref('')
const loadingError = ref('')
const listError = ref('')
const loadingList = ref(false)
let listRevision = 0
const filters = ref({ state: '', identityId: '', accountId: '', from: '', through: '' })
const invalidDates = computed(() => !!filters.value.from && !!filters.value.through && filters.value.from > filters.value.through)
let pending: { body: string; key: string } | undefined
let active = true
function syncLayout(event: MediaQueryListEvent) { wide.value = event.matches }
onBeforeUnmount(() => {
  active = false
  splitLayout.removeEventListener('change', syncLayout)
  clearTimeout(detailTimer)
})

const stateLabels = {
  QUEUED: '已排队', CONTEXT_READY: '准备草稿', DRAFTED: '草稿已生成', WAITING_APPROVAL: '待审批', READY: '待执行',
  EXECUTING: '执行中', RECONCILING: '待对账', SIMULATED: '模拟完成',
  REJECTED: '已拒绝', BLOCKED: '已拦截', CANCELED: '已取消', EXPIRED: '已过期',
} satisfies Record<NonNullable<z.infer<typeof simulationRunQuery>['state']>, string>

function stateName(state: string) {
  return (stateLabels as Record<string, string>)[state] ?? state
}

function stateTone(state: string) {
  if (state === 'SIMULATED') return 'success'
  if (state === 'WAITING_APPROVAL' || state === 'RECONCILING') return 'warning'
  if (state === 'READY' || state === 'EXECUTING') return 'info'
  return 'default'
}

const stateOptions = [{ label: '全部', value: '' }, ...Object.entries(stateLabels).map(([value, label]) => ({ label, value }))]
const identityOptions = computed(() => [{ label: '全部', value: '' },
  ...identities.value.map(({ id }) => ({ value: id, label: identityName(id) }))])
const accountOptions = computed(() => [{ label: '全部', value: '' }, ...accounts.value
  .filter(({ identityId }) => !filters.value.identityId || identityId === filters.value.identityId)
  .map(({ id, platform, instanceKey }) => ({ value: id, label: platform + ' · ' + instanceKey }))])

function applyFilters() {
  if (invalidDates.value) return
  const query = new URLSearchParams()
  for (const key of runFilterKeys) {
    if (filters.value[key]) query.set(key, filters.value[key])
  }
  emit('filter', query.toString())
}

function identityName(id: string) {
  const identity = identities.value.find((item) => item.id === id)
  return identity?.profile?.displayName || identity?.slug || id
}

const options = computed(() => simulationAccounts(character.value, identities.value, accounts.value).map((item) => ({
  value: item.id, label: identityName(item.identityId) + ' · ' + item.platform + ' · ' + item.instanceKey,
})))

async function list(append = false) {
  const current = ++listRevision
  const query = new URLSearchParams(props.runQuery)
  if (append && cursor.value) query.set('cursor', cursor.value)
  loadingList.value = true
  listError.value = ''
  try {
    const page = await request<Page<Run>>(base.value + '/runs?' + query.toString())
    if (!active || current !== listRevision) return
    rows.value = append ? [...rows.value, ...page.items] : page.items
    cursor.value = page.nextCursor
  } catch (cause) {
    if (!active || current !== listRevision) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) emit('expired')
    else {
      if (status === 403 || status === 404) {
        rows.value = []
        cursor.value = null
      }
      listError.value = ({
        403: '当前账号无权查看运行。', 404: '找不到该角色的运行。', 422: '筛选条件无效，请清除后重新选择。',
      } as Record<number, string>)[status] ?? '无法加载运行，请刷新后重试。'
    }
  } finally {
    if (current === listRevision) loadingList.value = false
  }
}

watch(() => props.runQuery, (value, previous) => {
  const query = new URLSearchParams(value)
  for (const key of runFilterKeys) filters.value[key] = query.get(key) ?? ''
  if (previous === undefined) return
  rows.value = []
  cursor.value = null
  void list()
}, { immediate: true })

async function detail(id?: string, background = false) {
  clearTimeout(detailTimer)
  const current = ++detailRevision
  detailError.value = ''
  loadingDetail.value = !!id && !background
  if (!id) return
  try {
    const view = await request<Replay>(base.value + '/runs/' + encodeURIComponent(id) + '/replay')
    if (!active || current !== detailRevision) return
    selected.value = view
    if (progressingStates.has(view.state)) {
      detailTimer = setTimeout(() => { void detail(id, true) }, 4000)
    }
  } catch (cause) {
    if (!active || current !== detailRevision) return
    const status = cause instanceof RequestError ? cause.status : 0
    if ([401, 403, 404].includes(status)) selected.value = undefined
    if (status === 401) emit('expired')
    else detailError.value = status === 403 || status === 404 ? '找不到该角色的运行详情。' : '无法读取运行详情，请重试。'
  } finally {
    if (current === detailRevision) loadingDetail.value = false
  }
}

watch(previewId, (id) => {
  selected.value = undefined
  resolutionNotice.value = ''
  void detail(id)
}, { immediate: true })

watch(() => props.detailId, (id, previous) => {
  void nextTick(() => {
    if (!active || id !== props.detailId) return
    if (id) detailHeading.value?.focus()
    else if (previous) (document.getElementById('run-row-' + previous) ?? listHeading.value)?.focus()
  })
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
      readAll<Identity>(base.value + '/identities', () => active),
      readAll<Account>(base.value + '/accounts', () => active),
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
    await Promise.all([load(), detail(previewId.value)])
  })
}

watch(() => props.showForm, (open, previous) => {
  void nextTick(() => {
    if (!active || props.detailId || open !== props.showForm) return
    if (open) editorHeading.value?.focus()
    else if (previous) document.getElementById('run-start-trigger')?.focus()
  })
}, { immediate: true })

function reconciled(outcome: NonNullable<ReconciliationView['outcome']>) {
  resolutionNotice.value = outcome === 'CONFIRMED' ? '已确认模拟回执。' : '已按未写入回执结案。'
  void detail(previewId.value)
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
    message.value = ''
    pending = undefined
    emit('open', result.id)
    await list()
  })
}

onMounted(() => {
  splitLayout.addEventListener('change', syncLayout)
  wide.value = splitLayout.matches
  void act(load)
})
</script>

<template>
  <div class="simulation-workspace">
    <div v-if="canStart && (!detailId || wide) && !showForm" class="run-actions">
      <UiButton id="run-start-trigger" tone="primary" :disabled="busy || !options.length"
        @click="emit('form', true)">发起模拟</UiButton>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="loadingError" tone="warning" role="status">{{ loadingError }}</UiAlert>
    <div v-if="!detailId && canStart && !busy && !options.length && !loadingError" class="run-actions">
      <span class="run-muted">发起模拟前，请启用角色、身份和已关联的模拟账号。</span>
      <UiButton size="small" variant="soft" @click="emit('identities')">前往角色与身份</UiButton>
    </div>
    <section v-if="canStart && showForm && !detailId" class="run-editor console-card" aria-labelledby="run-editor-heading">
      <h3 id="run-editor-heading" ref="editorHeading" tabindex="-1">发起模拟</h3>
      <form @submit.prevent="start">
        <UiField label="身份和模拟账号" for="run-account">
          <UiCombobox placeholder="选择接收模拟消息的账号" v-model="accountId" :options="options" :input-attrs="{ id: 'run-account' }" :disabled="busy" />
        </UiField>
        <UiField label="模拟收到的消息" for="run-message">
          <textarea class="ui-control" placeholder="例如：你好，能介绍一下你的工作吗？" v-model="message" :rows="3" v-bind="{ id: 'run-message' }"
            :maxlength="4000" :disabled="busy"></textarea>
        </UiField>
        <div class="run-actions run-editor-actions">
          <UiButton :disabled="busy" @click="emit('form', false)">取消</UiButton>
          <UiButton tone="primary" type="submit" :loading="busy" :disabled="busy || !accountId || !message.trim()">开始模拟</UiButton>
        </div>
      </form>
    </section>
    <div v-else class="run-layout" :class="{ 'run-layout--split': wide && previewId }">
      <section v-if="wide || !detailId" class="console-card run-list" aria-labelledby="run-list-heading">
        <div class="console-section-heading">
          <h3 id="run-list-heading" ref="listHeading" tabindex="-1">最近运行</h3>
          <UiButton size="small" variant="quiet" :disabled="busy || loadingList" @click="refresh">刷新运行</UiButton>
        </div>
        <details class="run-filter-panel" :open="!!runQuery">
          <summary>{{ runQuery ? '筛选 · 已应用' : '筛选运行' }}</summary>
          <form class="run-filters" aria-label="筛选运行" @submit.prevent="applyFilters">
            <UiField label="状态" for="filter-run-state">
              <UiCombobox placeholder="全部状态" v-model="filters.state" :options="stateOptions" :input-attrs="{ id: 'filter-run-state' }" />
            </UiField>
            <UiField label="身份" for="filter-run-identity">
              <UiCombobox placeholder="全部身份" v-model="filters.identityId" :options="identityOptions"
                :input-attrs="{ id: 'filter-run-identity' }" @update:model-value="filters.accountId = ''" />
            </UiField>
            <UiField label="账号" for="filter-run-account">
              <UiCombobox placeholder="全部账号" v-model="filters.accountId" :options="accountOptions" :input-attrs="{ id: 'filter-run-account' }" />
            </UiField>
            <UiField label="开始日期（UTC）" for="filter-run-from">
              <input id="filter-run-from" v-model="filters.from" type="date" min="0001-01-01" max="9999-12-31" />
            </UiField>
            <UiField label="截止日期（UTC）" for="filter-run-through">
              <input id="filter-run-through" v-model="filters.through" type="date" min="0001-01-01" max="9999-12-31" />
            </UiField>
            <div class="run-actions">
              <UiButton type="submit" :disabled="invalidDates">筛选</UiButton>
              <UiButton v-if="runQuery" variant="quiet" @click="emit('filter', '')">清除筛选</UiButton>
            </div>
          </form>
          <UiAlert v-if="invalidDates" tone="warning" role="status">截止日期应等于或晚于开始日期。</UiAlert>
        </details>
        <UiAlert v-if="listError" tone="error" role="alert">{{ listError }}</UiAlert>
        <p v-if="loadingList && !rows.length" role="status">正在加载运行…</p>
        <UiEmpty v-if="!rows.length && !loadingList && !listError"
          :description="runQuery ? '没有符合筛选条件的运行。' : '暂无模拟运行。'" />
        <ul v-if="rows.length" class="console-select-list run-list-rows">
          <li v-for="item in rows" :key="item.id">
            <button :id="'run-row-' + item.id" type="button" class="console-record" :aria-current="previewId === item.id ? 'true' : undefined"
              @click="emit('open', item.id)">
              <span class="run-row-title">
                <strong>{{ identityName(item.identityId) }}</strong>
                <UiBadge :tone="stateTone(item.state)">{{ stateName(item.state) }}</UiBadge>
              </span>
              <span class="run-muted">{{ accountName(item.accountId, item.platform) }}</span>
              <time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time>
            </button>
          </li>
        </ul>
        <UiButton v-if="cursor" class="run-load-more" size="small" :disabled="busy || loadingList" @click="list(true)">加载更多</UiButton>
      </section>
      <section v-if="previewId" class="console-card run-detail" aria-labelledby="run-detail-heading">
        <div class="console-section-heading">
          <h3 id="run-detail-heading" ref="detailHeading" tabindex="-1">模拟运行详情</h3>
          <UiBadge v-if="selected" :tone="stateTone(selected.state)">{{ stateName(selected.state) }}</UiBadge>
          <div v-if="!wide" class="run-actions">
            <UiButton size="small" variant="quiet" :disabled="busy || loadingDetail" @click="refresh">刷新运行</UiButton>
            <UiButton size="small" variant="quiet" @click="emit('open')">返回运行列表</UiButton>
          </div>
        </div>
        <UiAlert v-if="resolutionNotice" tone="success" role="status">{{ resolutionNotice }}</UiAlert>
        <UiAlert v-if="detailError" tone="error" role="alert">{{ detailError }}</UiAlert>
        <UiButton v-if="detailError" size="small" :disabled="loadingDetail" @click="detail(previewId)">重新加载详情</UiButton>
        <UiSpinner v-if="loadingDetail" aria-label="正在加载运行详情" />
        <template v-if="selected">
          <div class="run-actions">
            <span v-if="trackingRun" class="run-muted">自动更新中</span>
            <UiButton v-if="canReview && selected.proposal" size="small"
              :tone="selected.state === 'WAITING_APPROVAL' ? 'primary' : 'default'"
              :variant="selected.state !== 'WAITING_APPROVAL' ? 'soft' : 'solid'" @click="emit('review', selected.proposal.id)">
              {{ selected.state === 'WAITING_APPROVAL' ? '前往审批' : '查看模拟提案' }}
            </UiButton>
            <UiButton size="small" variant="quiet" @click="emit('audit', selected.id)">查看相关审计</UiButton>
            <UiButton v-if="canStart && selected.state === 'SIMULATED' && selected.proposal?.receiptAt"
              size="small" variant="quiet" @click="emit('commitment', selected.id)">登记模拟承诺</UiButton>
          </div>
          <UiAlert v-if="selected.state === 'WAITING_APPROVAL'" tone="info"
            :title="canReview ? '草稿已生成，等待审批' : '此提案需要审批权限'">
            {{ canReview ? '点击「前往审批」即可查看拟回复正文，并决定是否批准。' : '请联系当前角色的管理员处理这次模拟提案。' }}
          </UiAlert>
          <UiAlert v-if="selected.state === 'READY'" tone="info" title="已批准，等待模拟执行器">
            <p>执行器会自动领取许可并写入模拟回执。长时间等待时，先查看执行器状态。</p>
            <UiButton size="small" variant="soft" @click="emit('executorHealth')">查看模拟执行器</UiButton>
          </UiAlert>
          <UiAlert v-else-if="selected.state === 'EXECUTING'" tone="info" title="已领取许可，正在等待模拟回执">
            回执写入后，这条运行会显示「模拟完成」。
          </UiAlert>
          <dl class="run-meta">
            <div><dt>身份</dt><dd>{{ identityName(selected.identityId) }}</dd></div>
            <div><dt>平台账号</dt><dd>{{ accountName(selected.accountId) }}</dd></div>
            <div v-if="modelName"><dt>模型</dt><dd>{{ modelName }}</dd></div>
            <div><dt>运行 ID</dt><dd>{{ selected.id }}</dd></div>
          </dl>
          <ol class="run-timeline" aria-label="运行轨迹">
            <li v-for="stage in timeline" :key="stage.label">
              <div class="run-actions">
                <strong>{{ stage.label }}</strong>
                <UiBadge>{{ stage.status }}</UiBadge>
                <time v-if="stage.at" :datetime="stage.at">{{ new Date(stage.at).toLocaleString() }}</time>
              </div>
              <blockquote v-if="stage.quote" class="console-payload run-quote">{{ stage.quote }}</blockquote>
            </li>
          </ol>
          <SimulationReconciliation v-if="canStart && selected.state === 'RECONCILING' && selected.proposal"
            :key="selected.proposal.id" :character-id="characterId" :action-id="selected.proposal.id"
            @expired="emit('expired')" @resolved="reconciled" />
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.simulation-workspace { display: grid; gap: 1rem; min-width: 0; }
.run-layout { display: grid; gap: 1rem; min-width: 0; align-items: start; }
.run-layout--split { grid-template-columns: minmax(16rem, 1fr) minmax(0, 2fr); }
.run-list, .run-detail { display: grid; gap: .875rem; }
.console-card .console-section-heading { align-items: center; margin: 0; }
.run-actions, .run-row-title { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
.run-muted, time, dt { color: var(--console-muted); font-size: .875rem; }
.run-editor { width: min(100%, 42rem); box-sizing: border-box; }
.run-editor h3 { margin: 0 0 1rem; }
.run-editor-actions { justify-content: flex-end; }
.run-filter-panel summary { width: fit-content; cursor: pointer; font-size: .875rem; color: var(--console-muted); }
.run-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.25rem), 1fr)); gap: 0 .75rem; margin-top: .75rem; }
.run-filters input[type="date"] { box-sizing: border-box; width: 100%; font: inherit; height: 34px;
  border: 1px solid var(--console-field); border-radius: 5px; color: inherit; background: var(--console-surface); padding-inline: .5rem; }
.run-list-rows { margin: 0; }
.run-load-more { justify-self: start; }
.run-list-rows .console-record { display: grid; gap: .3rem; padding: .875rem .75rem; }
.run-row-title { justify-content: space-between; }
.run-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem 1rem; margin: 0; }
.run-meta dd { margin: .15rem 0 0; }
.run-timeline { list-style: none; display: grid; gap: 1rem; margin: 0; padding: 0; }
.run-timeline li { display: grid; gap: .5rem; border-inline-start: 2px solid var(--console-line); padding-inline-start: .75rem; }
.run-quote { margin: 0; }
@media (max-width: 30rem) {
  .run-meta { grid-template-columns: minmax(0, 1fr); gap: .5rem; }
}
</style>
