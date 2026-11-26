<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiCombobox, UiSpinner, UiBadge } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, identityView } from '@ricajs/contracts/management'
import type { runReplayView, simulationRunQuery, simulationRunSummary } from '../contracts/observability.js'
import SimulationReconciliation from './SimulationReconciliation.vue'
import SimulationChat from './SimulationChat.vue'
import { simulationAccounts } from './simulation-accounts.js'
import { formatTime, readAll } from '@ricajs/console-shared/console-data'
import { autoReviewHandoffLabel } from '@ricajs/contracts/auto-review'
import type { ReconciliationView } from '../contracts/review.js'
import { chatReplyStopLabels } from '../contracts/review.js'
import { runFilterKeys, runStateLabels as stateLabels } from './run-filters.js'
import { request, RequestError } from '@ricajs/console-shared/request'

type Run = z.infer<typeof simulationRunSummary>
type Replay = z.infer<typeof runReplayView>
type Account = z.infer<typeof accountView>
type Character = z.infer<typeof characterWorkspaceView>
type Identity = z.infer<typeof identityView>
type Page<T> = { items: T[]; nextCursor: string | null }

const props = defineProps<{ characterId: string; canStart: boolean; canReview: boolean; detailId?: string; runQuery: string; showForm: boolean }>()
const emit = defineEmits<{ expired: []; open: [id?: string]; review: [id: string, historical: boolean]; audit: [id: string]; commitment: [id: string];
  filter: [query: string]; executorHealth: []; identities: []; settings: [] }>()
const base = computed(() => '/v1/characters/' + encodeURIComponent(props.characterId))
const rows = ref<Run[]>([])
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const character = ref<Character>()
const cursor = ref<string | null>(null)
const splitLayout = window.matchMedia('(min-width: 66rem)')
const wide = ref(splitLayout.matches)
const chatLatest = ref<string>()
const followingRoom = ref(false)
const previewId = computed(() => props.detailId ?? (followingRoom.value ? chatLatest.value : rows.value[0]?.id))
const selected = ref<Replay>()
const waitReasons = {
  QUIET_HOURS: '当前处于角色静默时段。',
  DAILY_LIMIT: '这个模拟账号的当日执行额度已用完。',
  CONTACT_COOLDOWN: '尚未达到可以再次回复这位联系人的时间。',
  ACCOUNT_BUSY: '同一账号有一个正在执行的提案。',
  ACCOUNT_RECONCILING: '同一账号有未确认的执行结果。完成对账后可继续。',
  PROPOSAL_EXPIRED: '提案已过有效期，等待执行器标记为过期。',
}
const timedWaitReasons = new Set(['QUIET_HOURS', 'DAILY_LIMIT', 'CONTACT_COOLDOWN'])
const stoppedReasons: Record<string, string> = {
  ACCOUNT_UNAVAILABLE: '角色、身份或账号当前不可用。',
  BINDING_CHANGED: '身份、账号或角色配置的绑定已经变化。',
  CONVERSATION_UNAVAILABLE: '会话或联系人当前不可用。',
  DRAFT_UNAVAILABLE: '这次运行未生成可用草稿。',
  SCHEDULE_CHANGED: '关联的计划已更新、暂停或失效。',
  APPROVAL_INVALID: '审批已失效，或已批准的内容与当前提案不匹配。',
  ADAPTER_MISMATCH: '模拟适配器未启用，或当前版本与批准时不同。',
  PAYLOAD_INVALID: '草稿、证据或当前授权未通过执行前核验。',
  PROPOSAL_EXPIRED: '提案已过有效期。',
  MODEL_BUDGET_EXHAUSTED: '角色当日模型预算不足，已跳过模型调用。',
  MODEL_NO_REPLY: '此身份选择旁听。',
  MODEL_DECISION_INVALID_OUTPUT: '模型的参与判断未通过格式校验，运行已停止。',
  MODEL_WRITING_INVALID_OUTPUT: '模型的写作结果未通过格式校验，未生成草稿。',
  ...chatReplyStopLabels,
}
const participationLabels = { talkative: '话痨', balanced: '适中', reserved: '寡言' }
const decisionLabels = { DIRECT_REQUEST: '收到直接提问或点名', RELEVANT_TOPIC: '话题适合此身份回应',
  SOCIAL_OPENING: '适合自然接话', ALREADY_ADDRESSED: '话题已回应或重复', BYSTANDER: '适合旁听', UNCLEAR: '对话意图不明确' }
const modelStage = { DECISION: '参与判断', WRITING: '写作', REVIEW: 'AI 审核' }
const stopReason = computed(() => stoppedReasons[selected.value?.stateReason ?? selected.value?.chatStop ?? ''])
const awaitingHuman = computed(() => selected.value?.state === 'WAITING_APPROVAL' && !selected.value.chatStop)
const modelName = computed(() => [selected.value?.draft?.modelId, selected.value?.draft?.modelVersion].filter(Boolean).join(' · '))
function accountName(id: string, platform?: string) {
  const account = accounts.value.find((item) => item.id === id)
  return account ? account.platform + ' · ' + account.instanceKey : platform ?? id
}
const timeline = computed(() => {
  if (!selected.value) return []
  const { state, inbound, draft, proposal, transcript } = selected.value
  const inboundKind = { POST: '发帖', REPLY: '回复', MENTION: '提及' }
  const review = proposal?.reviewDecision === 'APPROVE' ? (selected.value.autoApproved ? 'AI 已批准' : '人工已批准')
    : proposal?.reviewDecision === 'REJECT' ? '已拒绝'
      : state === 'WAITING_APPROVAL' ? (selected.value.autoReviewPending ? 'AI 审核中' : '待人工审批') : '无决定'
  const result = proposal?.receiptAt ? '已写入'
    : proposal?.attemptStatus === 'UNKNOWN' || state === 'RECONCILING' ? '待核对'
      : proposal?.attemptStatus === 'NOT_SENT' ? '已确认未写入' : '无回执'
  return [
    { label: '收到消息', status: inboundKind[inbound.kind], at: inbound.receivedAt },
    { label: '生成草稿', status: draft ? '已生成' : '无记录', at: draft?.createdAt },
    { label: '审批', status: review, at: proposal?.reviewedAt ?? proposal?.createdAt, quote: transcript?.reviewReason },
    { label: '执行许可', status: proposal?.permittedAt ? '已发放' : state === 'READY' ? '等待发放' : '未发放', at: proposal?.permittedAt },
    { label: '模拟回执', status: result, at: proposal?.receiptAt },
  ]
})
const detailError = ref('')
const loadingDetail = ref(false)
const detailHeading = ref<HTMLElement>()
const listHeading = ref<HTMLElement>()
const resolutionNotice = ref('')
let detailRevision = 0
let detailTimer: ReturnType<typeof setTimeout> | undefined
const progressingStates = new Set(['QUEUED', 'CONTEXT_READY', 'DRAFTED', 'WAITING_APPROVAL', 'READY', 'EXECUTING'])
const trackingRun = computed(() => !!selected.value && !detailError.value && progressingStates.has(selected.value.state))
const busy = ref(false)
const error = ref('')
const loadingError = ref('')
const listError = ref('')
const loadingList = ref(false)
let listRevision = 0
const filters = ref({ state: '', identityId: '', accountId: '', from: '', through: '' })
const invalidDates = computed(() => !!filters.value.from && !!filters.value.through && filters.value.from > filters.value.through)
let active = true
function syncLayout(event: MediaQueryListEvent) { wide.value = event.matches }
onBeforeUnmount(() => {
  active = false
  splitLayout.removeEventListener('change', syncLayout)
  clearTimeout(detailTimer)
})

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
  isIm: character.value?.simulationImPlatforms.some(platform => platform === item.platform) ?? false,
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
      detailTimer = setTimeout(() => { void detail(id, true) }, view.autoReviewPending ? 1500 : 3500)
    }
    return view
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

function reconciled(outcome: NonNullable<ReconciliationView['outcome']>) {
  resolutionNotice.value = outcome === 'CONFIRMED' ? '已确认模拟回执。' : '已按未写入回执结案。'
  void detail(previewId.value)
  void act(() => list())
}

async function openReview() {
  const id = previewId.value
  const wasWaiting = selected.value?.state === 'WAITING_APPROVAL'
  const view = await detail(id, true)
  if (previewId.value === id && view?.proposal && !view.autoReviewPending
    && (!wasWaiting || view.state === 'WAITING_APPROVAL')) emit('review', view.proposal.id, view.proposal.reviewDecision !== null)
}

function returnToSimulation() {
  emit('open')
  void nextTick(() => document.getElementById('simulation-chat-heading')?.focus())
}

onMounted(() => {
  splitLayout.addEventListener('change', syncLayout)
  wide.value = splitLayout.matches
  void act(load)
})
</script>

<template>
  <div class="simulation-workspace">
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="loadingError" tone="warning" role="status">{{ loadingError }}</UiAlert>
    <div class="run-layout" :class="{ 'run-layout--split': wide && previewId }">
      <div class="run-left">
        <SimulationChat :base="base" :accounts="options" :can-start="canStart" :selected="previewId"
          :requested-chat="detailId || !followingRoom ? selected?.chatId : undefined"
          :requested-account="detailId ? selected?.accountId : undefined"
          :focus-composer="showForm" :state-name="stateName"
          :identity="identityName"
          @expired="emit('expired')" @identities="emit('identities')" @open="emit('open', $event)"
          @latest="chatLatest = $event" @browse="followingRoom = $event" @sent="list()" />
        <details class="console-card run-list" :open="!!runQuery">
          <summary id="run-list-heading" ref="listHeading" tabindex="-1">运行历史</summary>
          <div class="console-section-heading">
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
        </details>
      </div>
      <section v-if="previewId" class="console-card run-detail" aria-labelledby="run-detail-heading">
        <div class="console-section-heading">
          <h3 id="run-detail-heading" ref="detailHeading" tabindex="-1">模拟运行详情</h3>
          <UiBadge v-if="selected" :tone="stateTone(selected.state)">{{ selected.chatStop ? '不再待处理' : stateName(selected.state) }}</UiBadge>
          <div v-if="!wide" class="run-actions">
            <UiButton size="small" variant="quiet" :disabled="busy || loadingDetail" @click="refresh">刷新运行</UiButton>
            <UiButton size="small" variant="quiet" @click="returnToSimulation">返回模拟</UiButton>
          </div>
        </div>
        <UiAlert v-if="resolutionNotice" tone="success" role="status">{{ resolutionNotice }}</UiAlert>
        <UiAlert v-if="detailError" tone="error" role="alert">{{ detailError }}</UiAlert>
        <UiButton v-if="detailError" size="small" :disabled="loadingDetail" @click="detail(previewId)">重新加载详情</UiButton>
        <UiSpinner v-if="loadingDetail" aria-label="正在加载运行详情" />
        <template v-if="selected">
          <div class="run-actions">
            <span v-if="trackingRun" class="run-muted">自动更新中</span>
            <UiButton v-if="canReview && selected.proposal && !selected.autoReviewPending" size="small"
              :tone="awaitingHuman ? 'primary' : 'default'"
              :variant="awaitingHuman ? 'solid' : 'soft'" @click="openReview">
              {{ awaitingHuman ? '前往审批' : selected.proposal.reviewDecision ? '查看审批记录' : '查看提案' }}
            </UiButton>
            <UiButton size="small" variant="quiet" @click="emit('audit', selected.id)">查看相关审计</UiButton>
            <UiButton v-if="canStart && selected.state === 'SIMULATED' && selected.proposal?.receiptAt"
              size="small" variant="quiet" @click="emit('commitment', selected.id)">登记模拟承诺</UiButton>
          </div>
          <UiAlert v-if="selected.autoReviewPending && selected.state === 'WAITING_APPROVAL'" tone="info" title="AI 审核中">
            审核完成后会自动更新；需要人工复审时可从这里进入审批。
          </UiAlert>
          <UiAlert v-else-if="awaitingHuman" tone="info"
            :title="canReview ? '草稿已生成，等待人工审批' : '此提案需要审批权限'">
            <p v-if="selected.autoReviewHandoff">
              {{ autoReviewHandoffLabel(selected.autoReviewHandoff) }} · {{ selected.autoReviewHandoff.reason }}
            </p>
            {{ canReview ? '点击「前往审批」即可查看拟回复正文，并决定是否批准。' : '请联系当前角色的管理员处理这次模拟提案。' }}
          </UiAlert>
          <UiAlert v-if="selected.state === 'READY' && !selected.chatStop" tone="info"
            :title="selected.autoApproved ? 'AI 已批准，等待模拟执行器' : '已批准，等待模拟执行器'">
            <template v-if="selected.executionWait">
              <p>{{ waitReasons[selected.executionWait.reason] }}</p>
              <p v-if="selected.executionWait.nextAt">预计最早可执行 {{ formatTime(selected.executionWait.nextAt) }}</p>
              <p v-else-if="timedWaitReasons.has(selected.executionWait.reason)">等待结束前，提案将过期。</p>
            </template>
            <p v-else>等待执行器领取许可并写入模拟回执。</p>
            <div class="console-actions">
              <UiButton v-if="selected.executionWait && timedWaitReasons.has(selected.executionWait.reason)"
                size="small" variant="soft" @click="emit('settings')">调整模拟限制</UiButton>
              <UiButton size="small" variant="soft" @click="emit('executorHealth')">查看模拟执行器</UiButton>
            </div>
          </UiAlert>
          <UiAlert v-else-if="selected.state === 'EXECUTING'" tone="info" title="已领取许可，正在等待模拟回执">
            回执写入后，这条运行会显示「模拟完成」。
          </UiAlert>
          <UiAlert v-if="stopReason && selected.stateReason !== 'MODEL_NO_REPLY'"
            :tone="selected.state === 'SKIPPED' ? 'info' : 'warning'">{{ stopReason }}</UiAlert>
          <dl class="run-meta">
            <div><dt>身份</dt><dd>{{ identityName(selected.identityId) }}</dd></div>
            <div><dt>平台账号</dt><dd>{{ accountName(selected.accountId) }}</dd></div>
            <div v-if="modelName"><dt>模型</dt><dd>{{ modelName }}</dd></div>
            <div v-if="selected.participationDecision"><dt>参与决定</dt><dd>{{ participationLabels[selected.participationDecision.participation] }} · {{ decisionLabels[selected.participationDecision.reason] }}</dd></div>
            <div><dt>运行 ID</dt><dd>{{ selected.id }}</dd></div>
          </dl>
          <section aria-labelledby="run-prompts-heading" class="run-prompts">
            <h4 id="run-prompts-heading">模型调用</h4>
            <p v-if="selected.participationDecision && !selected.modelCalls.some(call => call.stage === 'DECISION')">参与决定由本地规则产生。</p>
            <p v-else-if="!selected.modelCalls.length">暂无模型调用记录。</p>
            <details v-for="call in selected.modelCalls" :key="call.id">
              <summary>{{ modelStage[call.stage] }} · {{ call.model }} · {{ formatTime(call.at) }}</summary>
              <dl>
                <dt>模型返回</dt>
                <dd v-if="call.output !== null"><pre class="console-payload">{{ call.output }}</pre></dd>
                <dd v-else>暂无可查看的模型返回。</dd>
                <dt>System Prompt</dt>
                <dd v-if="call.systemPrompt !== null"><pre class="console-payload">{{ call.systemPrompt }}</pre></dd>
                <dd v-else>提示词已超过保留期限或来源已不可用。</dd>
              </dl>
            </details>
          </section>
          <details v-if="selected.glossary.length" class="run-prompts">
            <summary>当轮黑话 · {{ selected.glossary.length }} 条</summary>
            <dl v-for="term in selected.glossary" :key="term.id">
              <dt>{{ term.term }} · 第 {{ term.version }} 版</dt><dd>{{ term.meaning }}</dd>
            </dl>
          </details>
          <details v-if="!selected.modelCalls.length && (selected.systemPrompts?.core || selected.systemPrompts?.identity)" class="run-prompts">
            <summary>当时的角色与身份设定</summary>
            <dl>
              <template v-if="selected.systemPrompts.core">
                <dt>角色核心设定</dt><dd class="console-payload">{{ selected.systemPrompts.core }}</dd>
              </template>
              <template v-if="selected.systemPrompts.identity">
                <dt>身份提示词</dt><dd class="console-payload">{{ selected.systemPrompts.identity }}</dd>
              </template>
            </dl>
          </details>
          <section v-if="selected.transcript" aria-labelledby="run-messages-heading" class="run-messages">
            <h4 id="run-messages-heading">消息内容</h4>
            <dl>
              <dt>入站消息</dt><dd class="console-payload">{{ selected.transcript.message }}</dd>
              <template v-if="selected.transcript.draft">
                <dt>回复正文</dt><dd class="console-payload">{{ selected.transcript.draft }}</dd>
              </template>
            </dl>
          </section>
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
.run-layout--split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.run-left { display: grid; gap: .75rem; min-width: 0; }
.run-list > summary { cursor: pointer; font-weight: 600; }
.run-list, .run-detail { display: grid; gap: .875rem; }
.console-card .console-section-heading { align-items: center; margin: 0; }
.run-actions, .run-row-title { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
.run-muted, time, dt { color: var(--console-muted); font-size: .875rem; }
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
.run-prompts { min-width: 0; border-block: 1px solid var(--console-line); padding-block: .625rem; }
.run-prompts summary { cursor: pointer; }
.run-messages h4 { margin: 0; }
.run-prompts dl, .run-messages dl { display: grid; gap: .375rem; margin-block: .625rem 0; }
.run-prompts dd, .run-messages dd { min-width: 0; margin: 0 0 .375rem; }
.run-timeline { list-style: none; display: grid; gap: 1rem; margin: 0; padding: 0; }
.run-timeline li { display: grid; gap: .5rem; border-inline-start: 2px solid var(--console-line); padding-inline-start: .75rem; }
.run-quote { margin: 0; }
@media (max-width: 30rem) {
  .run-meta { grid-template-columns: minmax(0, 1fr); gap: .5rem; }
}
</style>
