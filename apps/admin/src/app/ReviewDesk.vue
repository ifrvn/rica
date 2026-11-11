<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NPopover, NSelect, NSpin, NTag } from 'naive-ui'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import ConnectorReview from '../features/review/ConnectorReview.vue'
import SimulationWorkspace from '../features/runs/SimulationWorkspace.vue'
import RunOperations from '../features/runs/RunOperations.vue'
import AuditWorkspace from '../features/access/AuditWorkspace.vue'
import { focusRecord } from '../shared/console-data.js'
import { request, RequestError } from '../shared/request.js'
import { consoleHash, readConsoleLocation, type ConsoleLocation, type ConsolePage } from './console-location.js'
import type { characterView, characterWorkspaceView } from '../../../../packages/contracts/management.js'
import type { z } from '@hono/zod-openapi'
import type { ActionView } from '../../../../packages/contracts/action-review.js'
import type { Readiness } from '../../../../packages/contracts/health.js'

defineProps<{ readiness?: Readiness; checkedAt?: string; checkingReadiness: boolean }>()
const emit = defineEmits<{ checkReadiness: [] }>()

const CharacterWorkspace = defineAsyncComponent(() => import('../features/characters/CharacterWorkspace.vue'))
const ConsoleHome = defineAsyncComponent(() => import('../features/home/ConsoleHome.vue'))
const GrowthWorkspace = defineAsyncComponent(() => import('../features/knowledge/GrowthWorkspace.vue'))
const KnowledgeWorkspace = defineAsyncComponent(() => import('../features/knowledge/KnowledgeWorkspace.vue'))
const MembershipWorkspace = defineAsyncComponent(() => import('../features/access/MembershipWorkspace.vue'))
const MetricsWorkspace = defineAsyncComponent(() => import('../features/runs/MetricsWorkspace.vue'))
const PlanningWorkspace = defineAsyncComponent(() => import('../features/planning/PlanningWorkspace.vue'))
const PluginWorkspace = defineAsyncComponent(() => import('../features/plugins/PluginWorkspace.vue'))
const SystemHealth = defineAsyncComponent(() => import('../features/health/SystemHealth.vue'))

type Character = z.infer<typeof characterView>
type Page<T> = { items: T[]; nextCursor: string | null }
type Decision = 'APPROVE' | 'REJECT'

const usernameInput = ref('')
const password = ref('')
const username = ref('')
const passkeyPassword = ref('')
const showPasskeyForm = ref(false)
const accountMenuOpen = ref(false)
const pageHeading = ref<HTMLElement>()
const passkeysAvailable = typeof window.PublicKeyCredential === 'function' && window.isSecureContext
const characters = ref<Character[]>([])
const canCreate = ref(false)
const tab = ref<ConsolePage>('character')
const runPages: ConsolePage[] = ['runs', 'outbox', 'metrics']
const inRuns = computed(() => runPages.includes(tab.value))
const knowledgePages = ['knowledge', 'growth'] as const
const accessPages = ['members', 'audit'] as const
const inKnowledge = computed(() => tab.value === 'knowledge' || tab.value === 'growth')
const inAccess = computed(() => tab.value === 'members' || tab.value === 'audit')
const mainPage = computed(() => inRuns.value ? 'runs'
  : inKnowledge.value ? 'knowledge'
    : inAccess.value ? 'audit'
      : tab.value === 'connector' ? 'review' : tab.value)
watch(tab, () => { void nextTick(() => pageHeading.value?.focus()) })
const pageTitle: Record<ConsolePage, string> = {
  home: '工作台', members: '成员与审计', knowledge: '记忆与身份成长', growth: '记忆与身份成长', planning: '计划与承诺', metrics: '模拟运行指标',
  character: '角色与身份', review: '审批', runs: '运行记录', outbox: '失败任务', audit: '成员与审计', plugins: '插件中心',
  health: '系统运行状况', accounts: '平台账号池', connector: '审批',
}
const detailId = ref<string>()
const reviewListHeading = ref<HTMLElement>()
const reviewDetailHeading = ref<HTMLElement>()
watch(detailId, (id, previous) => {
  if (tab.value === 'review') void nextTick(() => {
    if (tab.value === 'review' && id === detailId.value) focusRecord('review-row-', id, previous,
      reviewDetailHeading.value, reviewListHeading.value)
  })
})
const runQuery = ref('')
const startSimulation = ref(false)
const connectorAccountId = ref<string>()
const routing = ref(false)
let revision = 0
const characterCursor = ref<string | null>(null)
const roles = ref<string[]>([])
const simulationPlatforms = ref<z.infer<typeof characterWorkspaceView>['simulationPlatforms']>([])
const newbiInstalled = ref(false)
const canReadRuns = computed(() => roles.value.some((role) => role === 'ADMIN' || role === 'AUDITOR'))
const canReviewSimulation = computed(() => roles.value.includes('REVIEWER'))
const canReadConnector = computed(() => canReviewSimulation.value || roles.value.includes('ADMIN'))
const canReview = computed(() => canReviewSimulation.value || (canReadConnector.value && newbiInstalled.value))
const characterId = ref('')
const characterOptions = computed(() => characters.value.map(({ id, profile, slug }) => ({ label: profile?.name || slug, value: id })))
const currentCharacter = computed(() => characters.value.find(({ id }) => id === characterId.value))
const actions = ref<ActionView[]>([])
const nextCursor = ref<string | null>(null)
let queueLoaded = false
const selected = ref<ActionView>()
const reason = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
let pending: { signature: string; key: string } | undefined
const path = computed(() => '/v1/characters/' + encodeURIComponent(characterId.value) + '/actions')
const statusText: Record<ActionView['state'], string> = {
  WAITING_APPROVAL: '待审批', READY: '已批准', REJECTED: '已拒绝', CANCELED: '已失效', EXPIRED: '已过期',
  EXECUTING: '模拟执行中', RECONCILING: '待对账', SIMULATED: '模拟完成', BLOCKED: '执行已拦截',
}

function statusTone(state: ActionView['state']) {
  if (state === 'WAITING_APPROVAL' || state === 'RECONCILING') return 'warning'
  if (state === 'READY' || state === 'SIMULATED') return 'success'
  if (state === 'BLOCKED' || state === 'REJECTED') return 'error'
  return 'default'
}


function authPost<T>(path: string, data: object = {}) {
  return request<T>('/v1/auth/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
}

type Session = { username: string; canCreate: boolean }
type AuthenticationOptions = { challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }
type RegistrationOptions = { challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }

async function run(task: () => Promise<void>, scope?: number) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await task()
  } catch (cause) {
    if (scope !== undefined && scope !== revision) return
    const status = cause instanceof RequestError ? cause.status : 0
    const wasSignedIn = !!username.value
    if (status === 401 && wasSignedIn) resetSession()
    error.value = ({
      401: wasSignedIn ? '登录已过期，请重新登录。' : '登录失败，请核对账号信息或 Passkey。',
      403: '当前操作未获授权。', 404: '找不到该资源或管理服务。',
      409: '当前操作无法完成，请刷新后重试。', 412: '提案已更新，请重新打开后核对。',
      422: '提交的信息无法验证。', 429: '尝试次数过多，请稍后再试。', 503: '管理服务暂时不可用。',
    } as Record<number, string>)[status] ?? '操作未完成，请重试。'
    if ([401, 403, 404, 409, 412].includes(status) && selected.value) {
      selected.value = { ...selected.value, content: null }
    }
  } finally {
    busy.value = false
  }
}

async function openSession(session: Session) {
  username.value = session.username
  password.value = ''
  canCreate.value = session.canCreate
  await fetchCharacters()
  await restoreLocation()
}

async function fetchCharacters(cursor?: string) {
  const page = await request<Page<Character>>('/v1/characters?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
  const known = new Set(characters.value.map(({ id }) => id))
  characters.value = cursor ? [...characters.value, ...page.items.filter(({ id }) => !known.has(id))] : page.items
  characterCursor.value = page.nextCursor
}

function characterCreated(character: Character) {
  if (!characters.value.some(({ id }) => id === character.id)) characters.value = [...characters.value, character]
  changeCharacter(character.id)
  notice.value = '角色已创建。'
}

function characterUpdated(character: Character) {
  characters.value = characters.value.map((item) => item.id === character.id ? character : item)
}

function navigate(location: ConsoleLocation) {
  const hash = consoleHash(location)
  if (window.location.hash === hash && characterId.value === location.characterId
    && tab.value === location.page && detailId.value === location.detail) return
  if (window.location.hash !== hash) window.history.pushState(null, '', hash)
  void applyLocation(location)
}

function restoreLocation() {
  if (!username.value) return
  const location = readConsoleLocation(window.location.hash)
  const first = characters.value[0]
  return applyLocation(location ?? (first && { characterId: first.id, page: 'home' }), !location, !location)
}

async function applyLocation(location?: ConsoleLocation, replace = false, landing = false) {
  const current = ++revision
  const target = location?.characterId ?? ''
  const changedCharacter = target !== characterId.value
  const changedPage = tab.value !== location?.page
  if (changedCharacter || changedPage) {
    actions.value = []
    nextCursor.value = null
    queueLoaded = false
  }
  resetReview()
  error.value = ''
  notice.value = ''
  detailId.value = undefined
  if (changedCharacter) {
    characterId.value = ''
    roles.value = []
  }
  routing.value = true
  try {
    if (!location) {
      tab.value = 'character'
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
      return
    }
    if (changedCharacter) {
      const workspace = await request<z.infer<typeof characterWorkspaceView>>('/v1/characters/' + target)
      if (current !== revision) return
      roles.value = workspace.roles
      simulationPlatforms.value = workspace.simulationPlatforms
      newbiInstalled.value = workspace.newbiInstalled
      if (!characters.value.some(({ id }) => id === target)) characters.value = [...characters.value, workspace]
      else characterUpdated(workspace)
    }
    characterId.value = target
    const page = landing && !roles.value.includes('ADMIN')
      ? canReviewSimulation.value ? 'review' : canReadRuns.value ? 'audit' : 'character'
      : location.page
    const denied = (['home', 'runs', 'outbox', 'audit', 'plugins', 'health', 'accounts', 'members', 'knowledge', 'growth', 'metrics'].includes(page) && !canReadRuns.value)
      || (page === 'planning' && !roles.value.includes('ADMIN'))
      || (page === 'connector' && !canReadConnector.value)
      || (page === 'review' && (!canReview.value || (!!location.detail && !canReviewSimulation.value)))
    tab.value = denied ? 'character' : page === 'review' && !canReviewSimulation.value ? 'connector' : page
    detailId.value = denied ? undefined : location.detail
    runQuery.value = tab.value === 'runs' ? location.runQuery ?? '' : ''
    startSimulation.value = tab.value === 'runs' && roles.value.includes('ADMIN') && !!location.startSimulation
    connectorAccountId.value = tab.value === 'connector' ? location.connectorAccountId : undefined
    if (denied) error.value = '当前账号无权打开此链接。'
    if (replace || tab.value !== location.page || (location.startSimulation && !startSimulation.value)) {
      window.history.replaceState(null, '', consoleHash({ characterId: target, page: tab.value, detail: detailId.value,
        runQuery: runQuery.value, startSimulation: startSimulation.value }))
    }
    if (tab.value === 'review' && canReviewSimulation.value) {
      if (!queueLoaded) await fetchQueue(current)
      if (current === revision && location.detail) await fetchAction(location.detail, current)
    }
  } catch (cause) {
    if (current !== revision) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) {
      resetSession()
      error.value = '登录已过期，请重新登录。'
    }
    else {
      if (changedCharacter && !characterId.value) tab.value = 'character'
      error.value = status === 403 || status === 404 ? '无法访问链接中的角色或详情。' : '无法打开链接，请重试。'
    }
  } finally {
    if (current === revision) routing.value = false
  }
}

function refreshMembership() {
  const target = characterId.value
  void run(async () => {
    await fetchCharacters()
    if (characterId.value !== target) return
    characterId.value = ''
    roles.value = []
    const next = characters.value.some(({ id }) => id === target) ? target : characters.value[0]?.id
    await applyLocation(next ? { characterId: next, page: next === target ? 'members' : 'character' } : undefined, true)
  })
}

function closePlanning(feedback?: string) {
  changeTab('planning')
  if (feedback) notice.value = feedback
}

function changeTab(page: ConsolePage) {
  if (characterId.value) navigate({ characterId: characterId.value, page })
}

onBeforeUnmount(() => {
  ++revision
  window.removeEventListener('hashchange', restoreLocation)
})
onMounted(() => {
  window.addEventListener('hashchange', restoreLocation)
  void run(async () => {
    const session = await request<Session>('/v1/auth/session').catch((cause: unknown) => {
      if (cause instanceof RequestError && (cause.status === 401 || cause.status === 404)) return null
      throw cause
    })
    if (session) await openSession(session)
  })
})

async function connect() {
  await run(async () => openSession(await authPost<Session>('login', {
    username: usernameInput.value, password: password.value,
  })))
}

async function passkeyLogin() {
  await run(async () => {
    const { challengeId, options } = await authPost<AuthenticationOptions>('passkeys/login/options')
    const response = await startAuthentication({ optionsJSON: options })
    await openSession(await authPost<Session>('passkeys/login/verify', { challengeId, response }))
  })
}

async function registerPasskey() {
  await run(async () => {
    const { challengeId, options } = await authPost<RegistrationOptions>('passkeys/register/options', {
      password: passkeyPassword.value,
    })
    passkeyPassword.value = ''
    const response = await startRegistration({ optionsJSON: options })
    await authPost('passkeys/register/verify', { challengeId, response })
    accountMenuOpen.value = false
    notice.value = '已添加 Passkey。'
  })
}

function resetReview() {
  selected.value = undefined
  reason.value = ''
  pending = undefined
}

async function disconnect() {
  await run(async () => {
    await authPost('logout')
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    resetSession()
  })
}

function resetSession() {
  ++revision
  routing.value = false
  detailId.value = undefined
  username.value = ''
  password.value = ''
  passkeyPassword.value = ''
  accountMenuOpen.value = false
  showPasskeyForm.value = false
  canCreate.value = false
  tab.value = 'character'
  roles.value = []
  characterCursor.value = null
  characters.value = []
  characterId.value = ''
  actions.value = []
  nextCursor.value = null
  queueLoaded = false
  error.value = ''
  notice.value = ''
  resetReview()
}

async function fetchQueue(current: number, append = false) {
  const cursor = append && nextCursor.value ? '?cursor=' + encodeURIComponent(nextCursor.value) : ''
  const result = await request<Page<ActionView>>(path.value + cursor)
  if (current !== revision) return
  actions.value = append ? [...actions.value, ...result.items] : result.items
  nextCursor.value = result.nextCursor
  queueLoaded = true
}

async function loadQueue(append = false) {
  const current = revision
  await run(async () => {
    await fetchQueue(current, append)
    const preview = selected.value
    if (current === revision && !append && preview?.state === 'WAITING_APPROVAL'
      && !actions.value.some(({ id }) => id === preview.id)) selected.value = { ...preview, content: null }
  }, current)
}

function changeCharacter(id: string) {
  navigate({ characterId: id, page: 'character' })
}

async function fetchAction(id: string, current: number) {
  const action = await request<ActionView>(path.value + '/' + id)
  if (current === revision) selected.value = action
}

function openAction(id?: string) {
  if (!id || detailId.value !== id) navigate({ characterId: characterId.value, page: 'review', detail: id })
  else {
    const current = revision
    void run(() => fetchAction(id, current), current)
  }
}

function openRun(id?: string) {
  navigate({ characterId: characterId.value, page: 'runs', detail: id, runQuery: runQuery.value })
}

function openRunAudit(id: string) {
  navigate({ characterId: characterId.value, page: 'audit', detail: id })
}

async function decide(decision: Decision) {
  const proposal = selected.value
  const note = reason.value.trim()
  if (busy.value || !proposal?.content || proposal.state !== 'WAITING_APPROVAL' || !note) return
  const data = { decision, reviewDigest: proposal.reviewDigest, reason: note }
  const signature = JSON.stringify([proposal.id, proposal.version, data])
  if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
  const { key } = pending
  const current = revision
  await run(async () => {
    const outcome = await request<{ status: 'READY' | 'REJECTED'; version: number }>(
      path.value + '/' + proposal.id + '/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"run-v' + proposal.version + '"',
          'Idempotency-Key': key },
        body: JSON.stringify(data),
      },
    )
    if (current !== revision) return
    actions.value = actions.value.filter(({ id }) => id !== proposal.id)
    selected.value = { ...proposal, content: null, state: outcome.status, version: outcome.version }
    reason.value = ''
    pending = undefined
    notice.value = outcome.status === 'READY' ? '已批准，等待模拟执行。' : '已拒绝模拟提案。'
  }, current)
}
</script>

<template>
  <section class="review-desk" aria-labelledby="review-heading" :aria-busy="busy || routing">
    <NCard v-if="!username" class="login-card">
      <h2 id="review-heading">登录控制台</h2>
      <NForm :show-feedback="false" @submit.prevent="connect">
        <NFormItem label="用户名" :label-props="{ for: 'review-username' }">
          <NInput v-model:value="usernameInput" :input-props="{ id: 'review-username', autocomplete: 'username', required: true }"
            :disabled="busy" placeholder="输入本地用户名" />
        </NFormItem>
        <NFormItem label="密码" :label-props="{ for: 'review-password' }">
          <NInput v-model:value="password" type="password"
            :input-props="{ id: 'review-password', autocomplete: 'current-password', required: true }"
            :disabled="busy" placeholder="输入账号密码" />
        </NFormItem>
        <NAlert v-if="error" type="error" role="alert" class="login-alert">{{ error }}</NAlert>
        <div class="login-actions">
          <NButton type="primary" attr-type="submit" block :disabled="busy">登录</NButton>
          <NButton v-if="passkeysAvailable" block :disabled="busy" @click="passkeyLogin">使用 Passkey</NButton>
        </div>
      </NForm>
    </NCard>

    <template v-else>
      <Teleport v-if="characters.length" to="#masthead-role">
        <div class="role-picker">
          <label for="review-character">角色</label>
          <NSelect :value="characterId || null" :options="characterOptions" :disabled="busy"
            :input-props="{ id: 'review-character' }" placeholder="选择角色" filterable @update:value="changeCharacter" />
          <NButton v-if="characterCursor" size="small" :disabled="busy"
            @click="run(() => fetchCharacters(characterCursor ?? undefined))">更多角色</NButton>
        </div>
      </Teleport>
      <Teleport to="#masthead-account">
        <div class="workspace-account">
          <NPopover v-model:show="accountMenuOpen" trigger="click" placement="bottom-end"
            @update:show="if (!$event) { showPasskeyForm = false; passkeyPassword = '' }">
            <template #trigger>
              <NButton size="small" quaternary class="account-name" :aria-expanded="accountMenuOpen"
                :aria-label="'账号设置 · ' + username">{{ username }} <span aria-hidden="true">⌄</span></NButton>
            </template>
            <div class="account-menu">
              <NButton v-if="passkeysAvailable && !showPasskeyForm" size="small" quaternary
                :disabled="busy" @click="showPasskeyForm = true">添加通行密钥</NButton>
              <NForm v-if="showPasskeyForm" :show-feedback="false" @submit.prevent="registerPasskey">
                <NFormItem label="确认密码" :label-props="{ for: 'review-passkey-password' }">
                  <NInput v-model:value="passkeyPassword" type="password"
                    :input-props="{ id: 'review-passkey-password', autocomplete: 'current-password', required: true }"
                    :disabled="busy" placeholder="输入当前密码以确认身份" />
                </NFormItem>
                <NButton attr-type="submit" type="primary" size="small" class="passkey-submit" :disabled="busy">确认添加</NButton>
              </NForm>
              <NButton size="small" quaternary :disabled="busy" @click="disconnect">退出登录</NButton>
            </div>
          </NPopover>
        </div>
      </Teleport>

      <div class="workspace-shell" :class="{ 'workspace-shell--with-nav': characters.length }">
      <nav v-if="characters.length" class="console-navigation" aria-label="控制台导航">
        <button v-if="canReadRuns" type="button" :aria-current="mainPage === 'home' ? 'page' : undefined" :disabled="busy || routing"
          @click="changeTab('home')"><span class="i-lucide-layout-dashboard" aria-hidden="true" />工作台</button>
        <button v-if="canReview" type="button" :aria-current="mainPage === 'review' ? 'page' : undefined" :disabled="busy || routing"
          @click="changeTab(canReviewSimulation ? 'review' : 'connector')"><span class="i-lucide-clipboard-check" aria-hidden="true" />审批</button>
        <button v-if="canReadRuns" type="button" :aria-current="mainPage === 'runs' ? 'page' : undefined" :disabled="busy || routing"
          @click="changeTab('runs')"><span class="i-lucide-activity" aria-hidden="true" />运行记录</button>
        <span class="console-nav-label">角色管理</span>
        <button type="button" :aria-current="mainPage === 'character' ? 'page' : undefined" :disabled="busy || routing"
          @click="changeTab('character')"><span class="i-lucide-users" aria-hidden="true" />角色与身份</button>
        <template v-if="canReadRuns">
          <button type="button" :aria-current="mainPage === 'accounts' ? 'page' : undefined" :disabled="busy || routing"
            @click="changeTab('accounts')"><span class="i-lucide-contact" aria-hidden="true" />平台账号池</button>
          <button type="button" :aria-current="mainPage === 'knowledge' ? 'page' : undefined" :disabled="busy || routing"
            @click="changeTab('knowledge')"><span class="i-lucide-book-open" aria-hidden="true" />记忆与身份成长</button>
          <button v-if="roles.includes('ADMIN')" type="button" :aria-current="mainPage === 'planning' ? 'page' : undefined" :disabled="busy || routing"
            @click="changeTab('planning')"><span class="i-lucide-calendar-days" aria-hidden="true" />计划与承诺</button>
          <button type="button" :aria-current="mainPage === 'audit' ? 'page' : undefined" :disabled="busy || routing"
            @click="changeTab(roles.includes('ADMIN') ? 'members' : 'audit')"><span class="i-lucide-history" aria-hidden="true" />成员与审计</button>
          <span class="console-nav-label">部署管理</span>
          <button type="button" :aria-current="mainPage === 'plugins' ? 'page' : undefined" :disabled="busy || routing"
            @click="changeTab('plugins')"><span class="i-lucide-puzzle" aria-hidden="true" />插件中心</button>
          <button type="button" :aria-current="mainPage === 'health' ? 'page' : undefined" :disabled="busy || routing"
            @click="changeTab('health')"><span class="i-lucide-server" aria-hidden="true" />系统运行状况</button>
        </template>
      </nav>
      <div class="workspace-content">
      <div class="workspace-header">
        <h2 id="review-heading" ref="pageHeading" tabindex="-1">
          {{ tab === 'home' && currentCharacter ? (currentCharacter.profile?.name || currentCharacter.slug) + '的工作台' : pageTitle[tab] }}
        </h2>
        <NTag v-if="tab === 'home' && currentCharacter" :type="currentCharacter.status === 'ACTIVE' ? 'success' : 'default'" size="small" :bordered="false">
          {{ currentCharacter.status === 'ACTIVE' ? '已启用' : '已暂停' }}
        </NTag>
      </div>
      <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <nav v-if="inRuns && characterId" class="run-navigation" aria-label="运行页面">
        <NButton v-for="page in runPages" :key="page"
          text :type="tab === page ? 'primary' : 'default'" :aria-current="tab === page ? 'page' : undefined"
          :disabled="busy || routing" @click="changeTab(page)">
          {{ page === 'runs' ? '运行记录' : page === 'metrics' ? '模拟指标' : '失败任务' }}
        </NButton>
      </nav>
      <nav v-if="inKnowledge && characterId && canReadRuns" class="run-navigation" aria-label="记忆与身份成长分区">
        <NButton v-for="page in knowledgePages" :key="page" text :type="tab === page ? 'primary' : 'default'"
          :aria-current="tab === page ? 'page' : undefined" :disabled="busy || routing" @click="changeTab(page)">
          {{ page === 'knowledge' ? '记忆与授权' : '身份成长' }}
        </NButton>
      </nav>
      <nav v-if="inAccess && characterId && canReadRuns" class="run-navigation" aria-label="成员与审计分区">
        <NButton v-for="page in accessPages" :key="page" text :type="tab === page ? 'primary' : 'default'"
          :aria-current="tab === page ? 'page' : undefined" :disabled="busy || routing" @click="changeTab(page)">
          {{ page === 'members' ? '成员权限' : '审计记录' }}
        </NButton>
      </nav>

      <nav v-if="canReviewSimulation && (tab === 'connector' || (tab === 'review' && newbiInstalled))" class="account-actions" aria-label="审批类型">
        <NButton size="small" :type="tab === 'review' ? 'primary' : 'default'" :aria-current="tab === 'review' ? 'page' : undefined" :disabled="busy || routing"
          @click="changeTab('review')">模拟提案</NButton>
        <NButton v-if="newbiInstalled || tab === 'connector'" size="small" :type="tab === 'connector' ? 'primary' : 'default'"
          :aria-current="tab === 'connector' ? 'page' : undefined" :disabled="busy || routing"
          @click="changeTab('connector')">Newbi 平台提案</NButton>
      </nav>
      <NSpin v-if="routing && !characterId" />
      <ConsoleHome v-else-if="tab === 'home' && currentCharacter && canReadRuns" :key="characterId" :character="currentCharacter"
        :simulation-platforms="simulationPlatforms"
        :can-review="canReviewSimulation" :can-start="roles.includes('ADMIN')" @expired="resetSession" @navigate="changeTab"
        @run="openRun" @start="navigate({ characterId, page: 'runs', startSimulation: true })"
        @reconcile="navigate({ characterId, page: 'runs', runQuery: 'state=RECONCILING' })" />
      <CharacterWorkspace v-else-if="tab === 'character' || tab === 'accounts'" :key="characterId + '/' + tab" :character-id="characterId"
        :can-create="canCreate && tab === 'character'" :accounts-only="tab === 'accounts'" :account-detail="detailId"
        :characters="characters" :more-characters="!!characterCursor"
        @created="characterCreated" @updated="characterUpdated" @expired="resetSession" @roles="roles = $event"
        @select-character="changeCharacter" @load-characters="run(() => fetchCharacters(characterCursor ?? undefined))"
        @account="navigate({ characterId, page: 'accounts', detail: $event })"
        @proposals="navigate({ characterId, page: 'connector', connectorAccountId: $event })" />
      <template v-else-if="tab === 'runs' && characterId && canReadRuns">
        <SimulationWorkspace :key="characterId" :character-id="characterId" :can-start="roles.includes('ADMIN')" :can-review="canReviewSimulation"
          :detail-id="detailId" :run-query="runQuery" :show-form="startSimulation" @expired="resetSession" @open="openRun" @audit="openRunAudit"
          @review="navigate({ characterId, page: 'review', detail: $event })"
          @commitment="navigate({ characterId, page: 'planning', detail: $event })"
          @form="navigate({ characterId, page: 'runs', runQuery, startSimulation: $event })"
          @filter="navigate({ characterId, page: 'runs', detail: detailId, runQuery: $event, startSimulation })" />
        <RunOperations v-if="!detailId" :key="characterId" :character-id="characterId" mode="backlog"
          @expired="resetSession" @open-outbox="changeTab('outbox')"
          @open-reconciliation="navigate({ characterId, page: 'runs', runQuery: 'state=RECONCILING' })" />
      </template>
      <RunOperations v-else-if="tab === 'outbox' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" mode="outbox" :can-retry="roles.includes('ADMIN')"
        @expired="resetSession" @open-runs="changeTab('runs')" @open-run="openRun" />
      <AuditWorkspace v-else-if="tab === 'audit' && characterId && canReadRuns" :key="characterId + '/' + (detailId ?? '')"
        :character-id="characterId" :run-id="detailId" @expired="resetSession" @all="changeTab('audit')" @open-run="openRun" />
      <PluginWorkspace v-else-if="tab === 'plugins' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" :can-configure-model="canCreate" @expired="resetSession"
        @newbi="newbiInstalled = $event"
        @accounts="changeTab('accounts')" />
      <SystemHealth v-else-if="tab === 'health' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" @expired="resetSession" @plugins="changeTab('plugins')"
        :readiness="readiness" :checked-at="checkedAt" :checking="checkingReadiness" @check="emit('checkReadiness')"
        @accounts="changeTab('accounts')" @runs="changeTab('runs')" />
      <MembershipWorkspace v-else-if="tab === 'members' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" :username="username" :can-edit="roles.includes('ADMIN')"
        @expired="resetSession" @permissions="refreshMembership" />
      <KnowledgeWorkspace v-else-if="tab === 'knowledge' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" :detail-id="detailId" :can-edit="roles.includes('ADMIN')"
        @expired="resetSession" @open="navigate({ characterId, page: 'knowledge', detail: $event })" />
      <GrowthWorkspace v-else-if="tab === 'growth' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" :detail-id="detailId" :can-edit="roles.includes('ADMIN')"
        @expired="resetSession" @open="navigate({ characterId, page: 'growth', detail: $event })" />
      <PlanningWorkspace v-else-if="tab === 'planning' && characterId && roles.includes('ADMIN')" :key="characterId + '/' + (detailId ?? '')"
        :character-id="characterId" :run-id="detailId" @expired="resetSession" @clear="closePlanning" @run="openRun" />
      <MetricsWorkspace v-else-if="tab === 'metrics' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" @expired="resetSession" />
      <ConnectorReview v-else-if="tab === 'connector' && characterId && canReadConnector" :key="characterId"
        :character-id="characterId" :detail-id="detailId" :account-id="connectorAccountId" :can-review="canReviewSimulation" :can-close="roles.includes('ADMIN')"
        @expired="resetSession" @open="navigate({ characterId, page: 'connector', detail: $event, connectorAccountId })"
        @all="changeTab('connector')" />
      <div v-else-if="tab === 'review' && characterId && canReviewSimulation" class="console-split console-record-workspace" :class="{ 'console-split--detail': detailId }">
        <section class="console-split-list" aria-labelledby="review-list-heading">
          <div class="console-section-heading">
            <h3 id="review-list-heading" ref="reviewListHeading" tabindex="-1">待审批的模拟提案</h3>
            <NButton size="small" quaternary :disabled="busy || routing" @click="loadQueue()">刷新待办</NButton>
          </div>
          <NSpin v-if="routing && !actions.length" aria-label="正在加载待办" />
          <NEmpty v-else-if="!actions.length && !busy && !error" description="暂无待审批提案。" />
          <ul v-if="actions.length" class="console-select-list">
            <li v-for="item in actions" :key="item.id">
              <button :id="'review-row-' + item.id" type="button" class="console-record" :disabled="busy"
                :aria-current="detailId === item.id ? 'true' : undefined" @click="openAction(item.id)">
                <span class="console-record-main">
                  <strong>{{ item.target.identity }}</strong>
                  <span>{{ item.target.platform }} · {{ item.target.account }}</span>
                  <span class="console-record-meta">{{ item.target.audience === 'PUBLIC' ? '公开' : '私聊' }} · {{ item.target.conversation }}</span>
                </span>
                <NTag size="small" :bordered="false" :type="statusTone(item.state)">{{ statusText[item.state] }}</NTag>
              </button>
            </li>
          </ul>
          <NButton v-if="nextCursor" size="small" quaternary :disabled="busy" @click="loadQueue(true)">加载更多</NButton>
        </section>

        <section v-if="detailId" class="console-split-detail proposal" aria-labelledby="review-detail-heading">
          <div class="console-section-heading">
            <h3 id="review-detail-heading" ref="reviewDetailHeading" tabindex="-1">模拟回复</h3>
            <NButton size="small" quaternary :disabled="busy" @click="openAction()">返回待办</NButton>
          </div>
          <NSpin v-if="routing && !selected" aria-label="正在加载提案" />
          <div v-if="selected" class="console-actions proposal-actions">
            <NTag size="small" :bordered="false">模拟执行</NTag>
            <NTag size="small" :bordered="false" :type="statusTone(selected.state)">{{ statusText[selected.state] }}</NTag>
            <NButton size="small" quaternary :disabled="busy" @click="openAction(selected.id)">重新核对</NButton>
            <NButton v-if="canReadRuns" size="small" quaternary :disabled="busy" @click="openRun(selected.runId)">查看运行记录</NButton>
          </div>
          <NButton v-else-if="error" size="small" :disabled="busy" @click="openAction(detailId)">重新加载提案</NButton>
          <template v-if="selected">
            <dl class="metadata">
              <div><dt>平台</dt><dd>{{ selected.target.platform }} / {{ selected.target.instance }}</dd></div>
              <div><dt>身份与账号</dt><dd>{{ selected.target.identity }} / {{ selected.target.account }}</dd></div>
              <div><dt>目标</dt><dd>{{ selected.target.conversation }} / {{ selected.target.message }}</dd></div>
              <div><dt>受众</dt><dd>{{ selected.target.audience === 'PUBLIC' ? '公开' : '私聊' }}<template v-if="selected.target.contact"> · {{ selected.target.contact }}</template></dd></div>
            </dl>
            <NAlert v-if="selected.riskCodes.includes('CROSS_PLATFORM_NEAR_DUPLICATE')" type="warning">
              此回复与其他平台的内容相似，请核对后再审批。
            </NAlert>
            <template v-if="selected.content">
              <h4>拟回复内容</h4>
              <p class="console-payload">{{ selected.content }}</p>
              <NAlert v-if="selected.followUp" type="info">
                <strong>{{ selected.followUp.kind === 'PLAN' ? 'AI 拟定计划' : 'AI 拟登记承诺' }} · {{ selected.followUp.title }}</strong>
                <p>{{ selected.followUp.task }}</p>
                <p v-if="selected.followUp.dailyAt">每日 {{ selected.followUp.dailyAt }} · {{ selected.followUp.zone }}</p>
                <p v-else-if="selected.followUp.dueAt">截止 {{ new Date(selected.followUp.dueAt).toLocaleString() }}</p>
                <ul v-if="selected.followUp.participants?.length" class="follow-up-participants">
                  <li v-for="participant in selected.followUp.participants" :key="participant.accountId">
                    <strong>{{ participant.identity }} · {{ participant.platform }} / {{ participant.account }}</strong>
                    <span v-if="participant.task">{{ participant.task }}</span>
                  </li>
                </ul>
                <p>批准后，模拟回执确认且参与账号仍有效时自动登记。</p>
              </NAlert>
            </template>
            <p v-else-if="selected.state === 'WAITING_APPROVAL'">当前无法预览正文，暂不能审批。</p>
            <NForm v-if="selected.state === 'WAITING_APPROVAL' && selected.content" :show-feedback="false"
              @submit.prevent="decide('APPROVE')">
              <NFormItem label="审批理由" :label-props="{ for: 'review-reason' }">
                <NInput v-model:value="reason" type="textarea" :rows="3" :maxlength="240"
                  :input-props="{ id: 'review-reason', required: true }" :disabled="busy" placeholder="例如：已核对目标和拟发送内容" />
              </NFormItem>
              <div class="decision-buttons">
                <NButton type="primary" attr-type="submit" :disabled="busy || !reason.trim()">
                  {{ selected.followUp ? '批准回复及后续事项' : '批准模拟回复' }}
                </NButton>
                <NButton type="error" :disabled="busy || !reason.trim()" @click="decide('REJECT')">拒绝</NButton>
              </div>
            </NForm>
          </template>
        </section>
      </div>

      </div>
      </div>
    </template>
    <span v-if="busy" class="sr-only" role="status">处理中…</span>
  </section>
</template>

<style scoped>
.review-desk { display: grid; }
.login-card { width: min(calc(100% - 2rem), 25rem); margin: clamp(1rem, 8vh, 5rem) auto 2rem; }
.login-card h2, .workspace-header h2, h3 { margin: 0; }
.login-card h2 { font-size: 1.25rem; margin-block-end: 1rem; }
.login-card :deep(.n-form-item + .n-form-item) { margin-block-start: .625rem; }
.login-actions { display: grid; gap: .625rem; margin-block-start: .625rem; }
.login-alert { margin-block: .5rem; }
.workspace-header, .account-actions, .decision-buttons { display: flex; gap: .625rem; align-items: center; flex-wrap: wrap; }
.workspace-header { justify-content: space-between; }
.workspace-account { display: flex; align-items: center; gap: .5rem; }
.account-menu { display: grid; gap: .5rem; min-width: 10rem; justify-items: start; }
.workspace-shell { display: grid; min-height: calc(100vh - 3.75rem); }
.workspace-shell--with-nav { grid-template-columns: 10.25rem minmax(0, 1fr); }
.workspace-content { display: grid; align-content: start; gap: 1rem; min-width: 0; padding: 1.5rem clamp(1rem, 4vw, 2.5rem) 2rem; }
.console-navigation { display: flex; flex-direction: column; gap: .1875rem; padding: 1rem .625rem; min-width: 0;
  border-inline-end: 1px solid var(--console-line); background: var(--console-nav); }
.console-navigation button { display: flex; align-items: center; gap: .5rem; border: 0; border-radius: 3px; background: transparent;
  min-height: 2.25rem; padding: .4375rem .625rem; font: inherit; font-size: .8125rem;
  text-align: start; color: var(--console-muted); white-space: nowrap; cursor: pointer; }
.console-navigation button > span { flex: none; }
.console-navigation button:enabled:hover { background: var(--console-hover); }
.console-navigation button[aria-current] { color: var(--console-accent-text); background: var(--console-selected); font-weight: 650; }
.console-nav-label { color: var(--console-muted); padding: .625rem .625rem .125rem; font-size: .75rem; }
.console-navigation button:disabled { opacity: .65; cursor: default; }
.console-navigation button:focus-visible { outline-offset: -2px; }
.run-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1.125rem; }
.run-navigation [aria-current] { font-weight: 650; }
.workspace-header h2 { font-size: 1.5rem; line-height: 1.25; letter-spacing: -.025em; }
.account-name { max-width: 8rem; }
.account-name :deep(.n-button__content) { overflow: hidden; text-overflow: ellipsis; }
.role-picker { display: flex; align-items: center; gap: .5rem; min-width: 0; }
.role-picker > label { flex: none; color: var(--console-muted); }
.role-picker :deep(.n-select) { width: clamp(7rem, 15vw, 13rem); }
.proposal-actions { margin-bottom: .75rem; }
.metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem 1.25rem; margin: 0 0 1rem; }
.metadata dt { color: var(--console-muted); font-size: .8125rem; }
.metadata dd { margin: .125rem 0 0; overflow-wrap: anywhere; }
.proposal h4 { margin: 0 0 .375rem; font-size: .875rem; }
.follow-up-participants { margin-block: .5rem; padding-inline-start: 1rem; overflow-wrap: anywhere; }
.follow-up-participants span { display: block; }
.decision-buttons, .passkey-submit { margin-block-start: .75rem; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 46rem) {
  .workspace-shell--with-nav { grid-template-columns: minmax(0, 1fr); }
  .console-navigation { flex-direction: row; flex-wrap: wrap; border-inline-end: 0; border-bottom: 1px solid var(--console-line); padding: .5rem .625rem; }
  .console-nav-label { display: none; }
}
@media (max-width: 30rem) {
  .account-name { max-width: 7rem; }
  .metadata { grid-template-columns: minmax(0, 1fr); }
}
@media (pointer: coarse) {
  .console-navigation button { min-height: 2.75rem; }
}
</style>
