<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, identityView } from '../../packages/contracts/management.js'
import type { runReplayView, simulationRunQuery, simulationRunSummary } from '../../packages/contracts/simulation-observability.js'
import SimulationReconciliation from './SimulationReconciliation.vue'
import type { ReconciliationView } from '../../packages/contracts/action-review.js'
import { runFilterKeys } from './console-location.js'
import { request, RequestError } from './request.js'

type Run = z.infer<typeof simulationRunSummary>
type Replay = z.infer<typeof runReplayView>
type Account = z.infer<typeof accountView>
type Character = z.infer<typeof characterWorkspaceView>
type Identity = z.infer<typeof identityView>
type Page<T> = { items: T[]; nextCursor: string | null }

const props = defineProps<{ characterId: string; canStart: boolean; detailId?: string; runQuery: string }>()
const emit = defineEmits<{ expired: []; open: [id?: string]; audit: [id: string]; commitment: [id: string]; filter: [query: string] }>()
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const rows = ref<Run[]>([])
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const character = ref<Character>()
const cursor = ref<string | null>(null)
const selected = ref<Replay>()
function accountName(id: string, platform?: string) {
  const account = accounts.value.find((item) => item.id === id)
  return account ? account.platform + ' · ' + account.instanceKey : platform ?? id
}
const timeline = computed(() => {
  if (!selected.value) return []
  const { state, inbound, draft, proposal } = selected.value
  const inboundKind = { POST: '发帖', REPLY: '回复', MENTION: '提及' }
  const model = [draft?.modelId, draft?.modelVersion].filter(Boolean).join(' · ')
  const review = proposal?.reviewDecision === 'APPROVE' ? '已批准'
    : proposal?.reviewDecision === 'REJECT' ? '已拒绝'
      : state === 'WAITING_APPROVAL' ? '待审批' : '无决定'
  const result = proposal?.receiptAt ? '已写入'
    : proposal?.attemptStatus === 'UNKNOWN' || state === 'RECONCILING' ? '待核对'
      : proposal?.attemptStatus === 'NOT_SENT' ? '已确认未写入' : '无回执'
  return [
    { label: '入站', status: inboundKind[inbound.kind], at: inbound.receivedAt },
    { label: '草稿', status: draft ? '已生成' : '无记录', at: draft?.createdAt, detail: model },
    { label: '审批', status: review, at: proposal?.reviewedAt ?? proposal?.createdAt },
    { label: '获准执行', status: proposal?.permittedAt ? '已发放' : '未发放', at: proposal?.permittedAt },
    { label: '模拟回执', status: result, at: proposal?.receiptAt },
  ]
})
const detailError = ref('')
const loadingDetail = ref(false)
const detailHeading = ref<HTMLElement>()
const listHeading = ref<HTMLElement>()
const resolutionNotice = ref('')
let detailRevision = 0
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
const showForm = ref(false)
let pending: { body: string; key: string } | undefined
let active = true
onBeforeUnmount(() => { active = false })

const stateLabels = {
  QUEUED: '已排队', CONTEXT_READY: '准备草稿', DRAFTED: '草稿已生成', WAITING_APPROVAL: '待审批', READY: '待执行',
  EXECUTING: '执行中', RECONCILING: '待对账', SIMULATED: '模拟完成',
  REJECTED: '已拒绝', BLOCKED: '已拦截', CANCELED: '已取消', EXPIRED: '已过期',
} satisfies Record<NonNullable<z.infer<typeof simulationRunQuery>['state']>, string>

function stateName(state: string) {
  return (stateLabels as Record<string, string>)[state] ?? state
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

async function detail(id?: string) {
  const current = ++detailRevision
  selected.value = undefined
  detailError.value = ''
  loadingDetail.value = !!id
  if (!id) return
  try {
    const view = await request<Replay>(base.value + '/runs/' + encodeURIComponent(id) + '/replay')
    if (active && current === detailRevision) selected.value = view
  } catch (cause) {
    if (!active || current !== detailRevision) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) emit('expired')
    else detailError.value = status === 403 || status === 404 ? '找不到该角色的运行详情。' : '无法读取运行详情，请重试。'
  } finally {
    if (current === detailRevision) loadingDetail.value = false
  }
}

watch(() => props.detailId, (id, previous) => {
  resolutionNotice.value = ''
  void detail(id)
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
  <div class="simulation-workspace" :class="{ 'has-run-detail': detailId }">
    <section class="run-results" aria-labelledby="run-list-heading">
      <div class="console-section-heading">
        <h3 id="run-list-heading" ref="listHeading" tabindex="-1">最近运行</h3>
        <div class="run-actions">
          <NButton v-if="canStart && !showForm" type="primary" :disabled="busy || !options.length"
            @click="showForm = true">发起模拟</NButton>
          <NButton size="small" quaternary :disabled="busy || loadingList" @click="refresh">刷新运行</NButton>
        </div>
      </div>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NAlert v-if="loadingError" type="warning" role="status">{{ loadingError }}</NAlert>
      <p v-if="canStart && !busy && !options.length && !loadingError" class="run-muted">发起模拟前，请在「角色与身份」启用模拟账号及其角色和身份。</p>
      <section v-if="showForm" class="run-editor" aria-labelledby="run-editor-heading">
        <h4 id="run-editor-heading">发起模拟</h4>
        <NForm @submit.prevent="start">
          <NFormItem label="模拟账号" :label-props="{ for: 'run-account' }">
            <NSelect placeholder="选择接收模拟消息的账号" filterable v-model:value="accountId" :options="options" :input-props="{ id: 'run-account' }" :disabled="busy" />
          </NFormItem>
          <NFormItem label="模拟消息" :label-props="{ for: 'run-message' }">
            <NInput placeholder="例如：你好，能介绍一下你的工作吗？" v-model:value="message" type="textarea" :rows="3" :input-props="{ id: 'run-message' }"
              :maxlength="4000" :disabled="busy" />
          </NFormItem>
          <div class="run-actions">
            <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !accountId || !message.trim()">开始模拟</NButton>
            <NButton :disabled="busy" @click="showForm = false">取消</NButton>
          </div>
        </NForm>
      </section>
      <NForm class="run-filters" @submit.prevent="applyFilters">
        <NFormItem label="状态" :label-props="{ for: 'filter-run-state' }">
          <NSelect placeholder="全部状态" filterable v-model:value="filters.state" :options="stateOptions" :input-props="{ id: 'filter-run-state' }" />
        </NFormItem>
        <NFormItem label="身份" :label-props="{ for: 'filter-run-identity' }">
          <NSelect placeholder="全部身份" filterable v-model:value="filters.identityId" :options="identityOptions"
            :input-props="{ id: 'filter-run-identity' }" @update:value="filters.accountId = ''" />
        </NFormItem>
        <NFormItem label="账号" :label-props="{ for: 'filter-run-account' }">
          <NSelect placeholder="全部账号" filterable v-model:value="filters.accountId" :options="accountOptions" :input-props="{ id: 'filter-run-account' }" />
        </NFormItem>
        <NFormItem label="开始日期（UTC）" :label-props="{ for: 'filter-run-from' }">
          <input id="filter-run-from" v-model="filters.from" type="date" min="0001-01-01" max="9999-12-31" />
        </NFormItem>
        <NFormItem label="截止日期（UTC）" :label-props="{ for: 'filter-run-through' }">
          <input id="filter-run-through" v-model="filters.through" type="date" min="0001-01-01" max="9999-12-31" />
        </NFormItem>
        <div class="run-actions">
          <NButton attr-type="submit" :disabled="invalidDates">筛选</NButton>
          <NButton v-if="runQuery" quaternary @click="emit('filter', '')">清除筛选</NButton>
        </div>
      </NForm>
      <NAlert v-if="invalidDates" type="warning" role="status">截止日期应等于或晚于开始日期。</NAlert>
      <NAlert v-if="listError" type="error" role="alert">{{ listError }}</NAlert>
      <p v-if="loadingList && !rows.length" role="status">正在加载运行…</p>
      <NEmpty v-if="!rows.length && !loadingList && !listError"
        :description="runQuery ? '没有符合筛选条件的运行。' : '暂无模拟运行。'" />
      <ul v-if="rows.length" class="run-list">
        <li v-for="item in rows" :key="item.id">
          <button :id="'run-row-' + item.id" type="button" class="run-row" :aria-current="detailId === item.id ? 'true' : undefined"
            @click="emit('open', item.id)">
            <span><strong>{{ identityName(item.identityId) }}</strong><span class="run-muted">{{ accountName(item.accountId, item.platform) }}</span></span>
            <span><NTag size="small" :bordered="false">{{ stateName(item.state) }}</NTag>
              <time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time></span>
          </button>
        </li>
      </ul>
      <NButton v-if="cursor" size="small" :disabled="busy || loadingList" @click="list(true)">加载更多</NButton>
    </section>
    <section v-if="detailId" class="run-detail" aria-labelledby="run-detail-heading">
      <div class="console-section-heading">
        <h3 id="run-detail-heading" ref="detailHeading" tabindex="-1">运行详情</h3>
        <NButton size="small" quaternary @click="emit('open')">返回运行列表</NButton>
      </div>
      <NAlert v-if="resolutionNotice" type="success" role="status">{{ resolutionNotice }}</NAlert>
      <NAlert v-if="detailError" type="error" role="alert">{{ detailError }}</NAlert>
      <NButton v-if="detailError" size="small" @click="detail(detailId)">重新加载详情</NButton>
      <NSpin v-if="loadingDetail" aria-label="正在加载运行详情" />
      <template v-if="selected">
        <div class="run-actions">
          <NTag size="small" :bordered="false">{{ stateName(selected.state) }}</NTag>
          <NButton size="small" quaternary @click="emit('audit', selected.id)">查看相关审计</NButton>
          <NButton v-if="canStart && selected.state === 'SIMULATED' && selected.proposal?.receiptAt"
            size="small" quaternary @click="emit('commitment', selected.id)">登记模拟承诺</NButton>
        </div>
        <dl>
          <div><dt>身份</dt><dd>{{ identityName(selected.identityId) }}</dd></div>
          <div><dt>平台账号</dt><dd>{{ accountName(selected.accountId) }}</dd></div>
          <div><dt>运行 ID</dt><dd>{{ selected.id }}</dd></div>
        </dl>
        <ol class="run-timeline" aria-label="运行轨迹">
          <li v-for="stage in timeline" :key="stage.label">
            <strong>{{ stage.label }}</strong>
            <div class="run-actions">
              <NTag size="small" :bordered="false">{{ stage.status }}</NTag>
              <span v-if="stage.detail">{{ stage.detail }}</span>
              <time v-if="stage.at" :datetime="stage.at">{{ new Date(stage.at).toLocaleString() }}</time>
            </div>
          </li>
        </ol>
        <SimulationReconciliation v-if="canStart && selected.state === 'RECONCILING' && selected.proposal"
          :key="selected.proposal.id" :character-id="characterId" :action-id="selected.proposal.id"
          @expired="emit('expired')" @resolved="reconciled" />
      </template>
    </section>
  </div>
</template>

<style scoped>
.simulation-workspace { display: grid; gap: 1.5rem; min-width: 0; }
.simulation-workspace.has-run-detail { grid-template-columns: minmax(18rem, 2fr) minmax(0, 3fr); }
.run-results, .run-detail { min-width: 0; }
.run-detail { padding-inline-start: 1.25rem; border-inline-start: 1px solid #dfe7e6; }
.run-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; overflow-wrap: anywhere; }
.run-muted, time { color: #485c5b; font-size: .875rem; }
.run-editor { padding: 1rem 0; border-block: 1px solid #dfe7e6; }
.run-editor h4 { margin: 0 0 .625rem; }
.run-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.25rem), 1fr)); gap: 0 .75rem; align-items: start; }
.run-filters input[type="date"] { box-sizing: border-box; width: 100%; font: inherit; height: 34px; border: 1px solid #cbd5d3;
  border-radius: 6px; background: #fff; padding-inline: .5rem; color: inherit; }
.run-filters .run-actions { align-self: center; margin-bottom: .75rem; }
.run-list, .run-timeline { list-style: none; margin: 0 0 .5rem; padding: 0; }
.run-list li, .run-timeline li { border-top: 1px solid #dfe7e6; }
.run-row { width: 100%; display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem 1rem; padding: .625rem .5rem;
  background: transparent; border: 0; text-align: start; font: inherit; color: inherit; cursor: pointer; }
.run-row > span { display: grid; gap: .15rem; min-width: 0; overflow-wrap: anywhere; }
.run-row > span:last-child { justify-items: start; }
.run-row:hover, .run-row[aria-current] { background: #e9f1ef; }
.run-row:focus-visible { outline-offset: -2px; }
.run-timeline li { display: grid; grid-template-columns: 5rem minmax(0, 1fr); align-items: baseline; gap: .5rem; padding: .5rem 0; }
dl { display: grid; gap: .5rem; }
dl > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .5rem; }
dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 46rem) {
  .simulation-workspace.has-run-detail { grid-template-columns: minmax(0, 1fr); }
  .has-run-detail .run-results { display: none; }
  .run-detail { padding: 0; border: 0; }
}
</style>
