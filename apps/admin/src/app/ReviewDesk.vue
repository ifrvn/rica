<script setup lang="ts">
import { platformReviews, type ConsoleWorkspace } from './plugin-integrations.js'
import type { DeploymentPluginsView } from '../../../deployment-plugin-contracts.js'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiCombobox, UiSpinner, UiBadge } from '@rica/console-shared/ui'
import {
  DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger,
  PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger,
} from 'reka-ui'
import ConsoleNavigation from './ConsoleNavigation.vue'
import { startAuthentication } from '@simplewebauthn/browser'
import SimulationWorkspace from '../features/runs/SimulationWorkspace.vue'
import RunOperations from '../features/runs/RunOperations.vue'
import AutoReviewSettings from '../features/review/AutoReviewSettings.vue'
import AuditWorkspace from '../features/access/AuditWorkspace.vue'
import { focusRecord } from '@rica/console-shared/console-data'
import { request, RequestError } from '@rica/console-shared/request'
import { consoleHash, readConsoleLocation, type ConsoleLocation, type ConsolePage } from './console-location.js'
import type { characterView } from '../../../../packages/contracts/management.js'
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
const CreateAccount = defineAsyncComponent(() => import('../features/access/CreateAccount.vue'))
const SecuritySettings = defineAsyncComponent(() => import('../features/access/SecuritySettings.vue'))
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
const accountMenuOpen = ref(false)
const createAccountOpen = ref(false)
const accountListRevision = ref(0)
const securitySettingsOpen = ref(false)
let createAccountTriggerId = 'console-account-menu'
const navigationBreakpoint = window.matchMedia('(max-width: 46rem)')
const narrowNavigation = ref(navigationBreakpoint.matches)
const navigationOpen = ref(false)
let focusPageAfterNavigation = false
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
  character: '角色与身份', review: '审批', runs: '模拟运行', outbox: '失败任务', audit: '成员与审计', plugins: '插件中心',
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
const healthNode = ref<ConsoleLocation['healthNode']>()
const routing = ref(false)
let revision = 0
const characterCursor = ref<string | null>(null)
const installedReviews = ref<string[]>([])
const reviewPlugin = ref<string>()
const reviewStatus = ref<string>()
const auditTarget = ref<string>()
const activePlatformReview = computed(() => platformReviews.find(({ id }) => id === reviewPlugin.value)
  ?? (reviewPlugin.value ? undefined : platformReviews.find(({ id }) => installedReviews.value.includes(id)) ?? platformReviews[0]))
const reviewTabs = computed(() => platformReviews.filter(({ id }) => installedReviews.value.includes(id)
  || (tab.value === 'connector' && activePlatformReview.value?.id === id)))

function refreshReviewTabs(deployment: DeploymentPluginsView) {
  installedReviews.value = platformReviews.filter((review) => review.deployed(deployment)).map(({ id }) => id)
}
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
  return applyLocation(location ?? (first && { characterId: first.id, page: 'home' }), !location)
}

async function applyLocation(location?: ConsoleLocation, replace = false) {
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
  }
  routing.value = true
  try {
    if (!location) {
      tab.value = 'character'
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
      return
    }
    if (changedCharacter) {
      const workspace = await request<ConsoleWorkspace>('/v1/characters/' + target)
      if (current !== revision) return
      installedReviews.value = platformReviews.filter((review) => review.installed(workspace)).map(({ id }) => id)
      if (!characters.value.some(({ id }) => id === target)) characters.value = [...characters.value, workspace]
      else characterUpdated(workspace)
    }
    characterId.value = target
    tab.value = location.page
    detailId.value = location.detail
    runQuery.value = tab.value === 'runs' ? location.runQuery ?? '' : ''
    startSimulation.value = tab.value === 'runs' && !!location.startSimulation
    connectorAccountId.value = tab.value === 'connector' ? location.connectorAccountId : undefined
    reviewPlugin.value = tab.value === 'connector' ? location.reviewPlugin : undefined
    reviewStatus.value = tab.value === 'connector' ? location.reviewStatus : undefined
    auditTarget.value = tab.value === 'audit' && !detailId.value ? location.auditTarget : undefined
    healthNode.value = tab.value === 'health' ? location.healthNode : undefined
    if (replace || (location.startSimulation && !startSimulation.value)) {
      window.history.replaceState(null, '', consoleHash({ characterId: target, page: tab.value, detail: detailId.value,
        runQuery: runQuery.value, startSimulation: startSimulation.value, connectorAccountId: connectorAccountId.value,
        reviewPlugin: reviewPlugin.value, reviewStatus: reviewStatus.value, auditTarget: auditTarget.value, healthNode: healthNode.value }))
    }
    if (tab.value === 'review') {
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

function closePlanning(feedback?: string) {
  changeTab('planning')
  if (feedback) notice.value = feedback
}

function changeTab(page: ConsolePage) {
  if (characterId.value) navigate({ characterId: characterId.value, page })
}

function selectDrawerPage(page: ConsolePage) {
  focusPageAfterNavigation = page !== tab.value && !!characterId.value
  navigationOpen.value = false
  changeTab(page)
}

function restoreNavigationFocus(event: Event) {
  if (!focusPageAfterNavigation) return
  event.preventDefault()
  focusPageAfterNavigation = false
  pageHeading.value?.focus()
}

function syncNavigation(event: MediaQueryListEvent) {
  narrowNavigation.value = event.matches
  if (event.matches || !navigationOpen.value) return
  navigationOpen.value = false
  void nextTick(() => pageHeading.value?.focus())
}

onBeforeUnmount(() => {
  navigationBreakpoint.removeEventListener('change', syncNavigation)
  ++revision
  window.removeEventListener('hashchange', restoreLocation)
})
onMounted(() => {
  navigationBreakpoint.addEventListener('change', syncNavigation)
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
  securitySettingsOpen.value = false
  navigationOpen.value = false
  focusPageAfterNavigation = false
  ++revision
  routing.value = false
  detailId.value = undefined
  username.value = ''
  password.value = ''
  accountMenuOpen.value = false
  createAccountOpen.value = false
  canCreate.value = false
  tab.value = 'character'
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

function openCreateAccount(triggerId = 'console-account-menu') {
  createAccountTriggerId = triggerId
  accountMenuOpen.value = false
  notice.value = ''
  createAccountOpen.value = true
}

function closeCreateAccount() {
  createAccountOpen.value = false
  void nextTick(() => (document.getElementById(createAccountTriggerId) ?? document.getElementById('console-account-menu'))?.focus())
}

function accountCreated(username: string) {
  accountListRevision.value++
  closeCreateAccount()
  notice.value = '已创建系统管理员账号 ' + username + '。'
}

function passwordChanged() {
  resetSession()
  notice.value = '密码已修改，请重新登录。'
}

function closeSecuritySettings() {
  securitySettingsOpen.value = false
  void nextTick(() => document.getElementById('console-account-menu')?.focus())
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
    <div v-if="!username" class="login-card console-card">
      <h2 id="review-heading">登录控制台</h2>
      <form @submit.prevent="connect">
        <UiField label="用户名" for="review-username">
          <input class="ui-control" v-model="usernameInput" v-bind="{ id: 'review-username', autocomplete: 'username', required: true }"
            :disabled="busy" placeholder="输入本地用户名" />
        </UiField>
        <UiField label="密码" for="review-password">
          <input class="ui-control" v-model="password" type="password"
            v-bind="{ id: 'review-password', autocomplete: 'current-password', required: true }"
            :disabled="busy" placeholder="输入账号密码" />
        </UiField>
        <UiAlert v-if="error" tone="error" role="alert" class="login-alert">{{ error }}</UiAlert>
        <UiAlert v-if="notice" tone="success" role="status" class="login-alert">{{ notice }}</UiAlert>
        <div class="login-actions">
          <UiButton tone="primary" type="submit" block :disabled="busy">登录</UiButton>
          <UiButton v-if="passkeysAvailable" block :disabled="busy" @click="passkeyLogin">使用 Passkey</UiButton>
        </div>
      </form>
    </div>

    <template v-else>
      <DialogRoot v-if="characters.length && narrowNavigation" v-model:open="navigationOpen">
        <Teleport to="#masthead-navigation">
          <DialogTrigger type="button" class="navigation-icon" aria-label="打开导航">
            <span class="i-lucide-menu" aria-hidden="true" />
          </DialogTrigger>
        </Teleport>
        <DialogPortal>
          <DialogOverlay class="navigation-overlay" />
          <DialogContent class="navigation-drawer" :aria-describedby="undefined" @close-auto-focus="restoreNavigationFocus">
            <div class="navigation-drawer-heading">
              <DialogTitle>导航</DialogTitle>
              <DialogClose type="button" class="navigation-icon" aria-label="关闭导航">
                <span class="i-lucide-x" aria-hidden="true" />
              </DialogClose>
            </div>
            <ConsoleNavigation :has-character="!!characterId" :main-page="mainPage" :disabled="busy || routing"
              @select="selectDrawerPage" />
          </DialogContent>
        </DialogPortal>
      </DialogRoot>
      <Teleport v-if="characters.length" to="#masthead-role">
        <div class="role-picker">
          <label for="review-character">角色</label>
          <UiCombobox :model-value="characterId" :options="characterOptions" :disabled="busy"
            :input-attrs="{ id: 'review-character' }" placeholder="选择角色" @update:model-value="changeCharacter" />
          <UiButton v-if="characterCursor" size="small" :disabled="busy"
            @click="run(() => fetchCharacters(characterCursor ?? undefined))">更多角色</UiButton>
        </div>
      </Teleport>
      <Teleport to="#masthead-account">
        <PopoverRoot v-model:open="accountMenuOpen">
          <PopoverTrigger as-child>
            <button id="console-account-menu" type="button" class="ui-button account-name" data-variant="quiet"
              :aria-label="'账号设置 · ' + username">
              <span class="account-label">{{ username }}</span>
              <span class="i-lucide-chevron-down account-chevron" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent as-child align="end" :side-offset="8" :collision-padding="12">
              <div class="account-menu" aria-label="账号设置">
                <UiButton v-if="canCreate" class="account-action" variant="quiet" :disabled="busy" @click="openCreateAccount()">
                  <span class="i-lucide-user-plus" aria-hidden="true" />新建账号
                </UiButton>
                <UiButton class="account-action" variant="quiet" :disabled="busy"
                  @click="accountMenuOpen = false; securitySettingsOpen = true">
                  <span class="i-lucide-shield-check" aria-hidden="true" />安全设置
                </UiButton>
                <UiButton class="account-action" variant="quiet" tone="error" :disabled="busy" @click="disconnect">
                  <span class="i-lucide-log-out" aria-hidden="true" />退出登录
                </UiButton>
              </div>
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
      </Teleport>

      <CreateAccount v-if="canCreate && createAccountOpen" @close="closeCreateAccount" @created="accountCreated" @expired="resetSession" />
      <SecuritySettings v-if="securitySettingsOpen" :passkeys-available="passkeysAvailable"
        @close="closeSecuritySettings" @expired="resetSession" @password-changed="passwordChanged" />

      <div class="workspace-shell" :class="{ 'workspace-shell--with-nav': characters.length }">
      <ConsoleNavigation v-if="characters.length && !narrowNavigation" :has-character="!!characterId" :main-page="mainPage"
        :disabled="busy || routing" @select="changeTab" />
      <div class="workspace-content">
      <div class="workspace-header">
        <h2 id="review-heading" ref="pageHeading" tabindex="-1">
          {{ tab === 'home' && currentCharacter ? (currentCharacter.profile?.name || currentCharacter.slug) + '的工作台' : pageTitle[tab] }}
        </h2>
        <span v-if="(tab === 'audit' || inKnowledge) && currentCharacter" class="access-scope">{{ currentCharacter.profile?.name || currentCharacter.slug }}</span>
        <UiBadge v-if="tab === 'home' && currentCharacter" :tone="currentCharacter.status === 'ACTIVE' ? 'success' : 'default'">
          {{ currentCharacter.status === 'ACTIVE' ? '已启用' : '已暂停' }}
        </UiBadge>
      </div>
      <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
      <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
      <nav v-if="inRuns && characterId" class="run-navigation" aria-label="运行页面">
        <UiButton v-for="page in runPages" :key="page"
          variant="text" :tone="tab === page ? 'primary' : 'default'" :aria-current="tab === page ? 'page' : undefined"
          :disabled="busy || routing" @click="changeTab(page)">
          {{ page === 'runs' ? '模拟运行' : page === 'metrics' ? '模拟指标' : '失败任务' }}
        </UiButton>
      </nav>
      <nav v-if="inKnowledge && characterId" class="run-navigation access-navigation" aria-label="记忆与身份成长分区">
        <UiButton v-for="page in knowledgePages" :key="page" size="small" variant="soft" :tone="tab === page ? 'primary' : 'default'"
          :aria-current="tab === page ? 'page' : undefined" :disabled="busy || routing" @click="changeTab(page)">
          {{ page === 'knowledge' ? '记忆与授权' : '身份成长' }}
        </UiButton>
      </nav>
      <nav v-if="inAccess && characterId" class="run-navigation access-navigation" aria-label="成员与审计分区">
        <UiButton v-for="page in accessPages" :key="page" size="small" variant="soft" :tone="tab === page ? 'primary' : 'default'"
          :aria-current="tab === page ? 'page' : undefined" :disabled="busy || routing" @click="changeTab(page)">
          {{ page === 'members' ? '管理员' : '审计记录' }}
        </UiButton>
      </nav>

      <nav v-if="characterId && (tab === 'connector' || tab === 'review')" class="account-actions" aria-label="审批类型">
        <UiButton v-if="reviewTabs.length" size="small" :tone="tab === 'review' ? 'primary' : 'default'" :aria-current="tab === 'review' ? 'page' : undefined" :disabled="busy || routing"
          @click="changeTab('review')">模拟提案</UiButton>
        <UiButton v-for="review in reviewTabs" :key="review.id" size="small"
          :tone="tab === 'connector' && activePlatformReview?.id === review.id ? 'primary' : 'default'"
          :aria-current="tab === 'connector' && activePlatformReview?.id === review.id ? 'page' : undefined" :disabled="busy || routing"
          @click="navigate({ characterId, page: 'connector', reviewPlugin: review.id })">{{ review.title }}</UiButton>
        <AutoReviewSettings :key="characterId" :character-id="characterId" @expired="resetSession" />
      </nav>
      <UiSpinner v-if="routing && !characterId" />
      <ConsoleHome v-else-if="tab === 'home' && currentCharacter" :key="characterId" :character="currentCharacter"
        can-review can-read-runs can-start :installed-reviews="installedReviews"
        @expired="resetSession" @navigate="changeTab"
        @updated="characterUpdated"
        @run="openRun" @start="navigate({ characterId, page: 'runs', startSimulation: true })"
        @reconcile="navigate({ characterId, page: 'runs', runQuery: 'state=RECONCILING' })" />
      <CharacterWorkspace v-else-if="tab === 'character' || tab === 'accounts'" :key="characterId + '/' + tab" :character-id="characterId"
        :can-create="canCreate && tab === 'character'" :accounts-only="tab === 'accounts'" :account-detail="detailId"
        :characters="characters" :more-characters="!!characterCursor"
        @created="characterCreated" @updated="characterUpdated" @expired="resetSession"
        @select-character="changeCharacter" @load-characters="run(() => fetchCharacters(characterCursor ?? undefined))"
        @account="navigate({ characterId, page: 'accounts', detail: $event })"
        @proposals="(platform, accountId, proposalId) => navigate({ characterId, page: 'connector', reviewPlugin: platform, connectorAccountId: accountId, detail: proposalId })" />
      <template v-else-if="tab === 'runs' && characterId">
        <SimulationWorkspace :key="characterId" :character-id="characterId" can-start can-review
          :detail-id="detailId" :run-query="runQuery" :show-form="startSimulation" @expired="resetSession" @open="openRun" @audit="openRunAudit"
          @review="navigate({ characterId, page: 'review', detail: $event })"
          @executor-health="navigate({ characterId, page: 'health', healthNode: 'simulation-executor' })"
          @identities="changeTab('character')"
          @commitment="navigate({ characterId, page: 'planning', detail: $event })"
          @form="navigate({ characterId, page: 'runs', runQuery, startSimulation: $event })"
          @filter="navigate({ characterId, page: 'runs', runQuery: $event })" />
        <RunOperations v-if="!detailId && !startSimulation" :key="characterId" :character-id="characterId" mode="backlog"
          @expired="resetSession" @open-outbox="changeTab('outbox')"
          @open-reconciliation="navigate({ characterId, page: 'runs', runQuery: 'state=RECONCILING' })" />
      </template>
      <RunOperations v-else-if="tab === 'outbox' && characterId" :key="characterId"
        :character-id="characterId" mode="outbox" can-retry
        @expired="resetSession" @open-run="openRun" />
      <AuditWorkspace v-else-if="tab === 'audit' && characterId" :key="characterId + '/' + (detailId ?? '') + '/' + (auditTarget ?? '')"
        :character-id="characterId" :run-id="detailId" :target-id="auditTarget" can-review
        @expired="resetSession" @all="changeTab('audit')" @open-run="openRun"
        @proposal="(plugin, proposalId) => navigate({ characterId, page: 'connector', reviewPlugin: plugin, detail: proposalId })" />
      <PluginWorkspace v-else-if="tab === 'plugins' && characterId" :key="characterId"
        :character-id="characterId" :can-configure-model="canCreate" can-start-simulation can-review @expired="resetSession"
        @deployment-changed="refreshReviewTabs"
        @review="(plugin, status) => navigate({ characterId, page: 'connector', reviewPlugin: plugin, reviewStatus: status })"
        @simulate="navigate({ characterId, page: 'runs', startSimulation: true })"
        @accounts="changeTab('accounts')" @health="changeTab('health')" />
      <SystemHealth v-else-if="tab === 'health' && characterId" :key="characterId + '/' + (healthNode ?? '')"
        :character-id="characterId" @expired="resetSession" @plugins="changeTab('plugins')"
        :initial-node="healthNode"
        :readiness="readiness" :checked-at="checkedAt" :checking="checkingReadiness" @check="emit('checkReadiness')"
        @accounts="changeTab('accounts')" @runs="changeTab('runs')" />
      <MembershipWorkspace v-else-if="tab === 'members' && characterId"
        :revision="accountListRevision" :can-create="canCreate"
        @create-account="openCreateAccount('system-admin-create')" @expired="resetSession" />
      <KnowledgeWorkspace v-else-if="tab === 'knowledge' && characterId" :key="characterId"
        :character-id="characterId" :detail-id="detailId" can-edit
        @expired="resetSession" @open="navigate({ characterId, page: 'knowledge', detail: $event })" />
      <GrowthWorkspace v-else-if="tab === 'growth' && characterId" :key="characterId"
        :character-id="characterId" :detail-id="detailId" can-edit
        @expired="resetSession" @open="navigate({ characterId, page: 'growth', detail: $event })" />
      <PlanningWorkspace v-else-if="tab === 'planning' && characterId" :key="characterId + '/' + (detailId ?? '')"
        :character-id="characterId" :run-id="detailId" @expired="resetSession" @clear="closePlanning" @run="openRun" />
      <MetricsWorkspace v-else-if="tab === 'metrics' && characterId" :key="characterId"
        :character-id="characterId" @expired="resetSession" />
      <template v-else-if="tab === 'connector' && characterId">
        <component v-if="activePlatformReview" :is="activePlatformReview.component" :key="characterId + '/' + activePlatformReview.id"
          :character-id="characterId" :detail-id="detailId" :account-id="connectorAccountId" :status-filter="reviewStatus"
          can-review can-manage can-inspect
          @expired="resetSession" @open="navigate({ characterId, page: 'connector', detail: $event, connectorAccountId, reviewPlugin: activePlatformReview?.id, reviewStatus })"
          @account="navigate({ characterId, page: 'accounts', detail: $event })"
          @audit="navigate({ characterId, page: 'audit', auditTarget: $event })"
          @filter="navigate({ characterId, page: 'connector', detail: detailId, connectorAccountId, reviewPlugin: activePlatformReview?.id, reviewStatus: $event })"
          @all="navigate({ characterId, page: 'connector', reviewPlugin: activePlatformReview?.id, reviewStatus })" />
        <UiEmpty v-else description="此插件未注册审批页面。" />
      </template>
      <div v-else-if="tab === 'review' && characterId" class="console-split console-record-workspace" :class="{ 'console-split--detail': detailId }">
        <section class="console-split-list" aria-labelledby="review-list-heading">
          <div class="console-section-heading">
            <h3 id="review-list-heading" ref="reviewListHeading" tabindex="-1">待审批的模拟提案</h3>
            <UiButton size="small" variant="quiet" :disabled="busy || routing" @click="loadQueue()">刷新待办</UiButton>
          </div>
          <UiSpinner v-if="routing && !actions.length" aria-label="正在加载待办" />
          <UiEmpty v-else-if="!actions.length && !busy && !error" description="暂无待审批提案。" />
          <ul v-if="actions.length" class="console-select-list">
            <li v-for="item in actions" :key="item.id">
              <button :id="'review-row-' + item.id" type="button" class="console-record" :disabled="busy"
                :aria-current="detailId === item.id ? 'true' : undefined" @click="openAction(item.id)">
                <span class="console-record-main">
                  <strong>{{ item.target.identity }}</strong>
                  <span>{{ item.target.platform }} · {{ item.target.account }}</span>
                  <span class="console-record-meta">{{ item.target.audience === 'PUBLIC' ? '公开' : '私聊' }} · {{ item.target.conversation }}</span>
                </span>
                <UiBadge :tone="statusTone(item.state)">{{ statusText[item.state] }}</UiBadge>
              </button>
            </li>
          </ul>
          <UiButton v-if="nextCursor" size="small" variant="quiet" :disabled="busy" @click="loadQueue(true)">加载更多</UiButton>
        </section>

        <section v-if="detailId" class="console-split-detail proposal" aria-labelledby="review-detail-heading">
          <div class="console-section-heading">
            <h3 id="review-detail-heading" ref="reviewDetailHeading" tabindex="-1">模拟回复</h3>
            <UiButton size="small" variant="quiet" :disabled="busy" @click="openAction()">返回待办</UiButton>
          </div>
          <UiSpinner v-if="routing && !selected" aria-label="正在加载提案" />
          <div v-if="selected" class="console-actions proposal-actions">
            <UiBadge>模拟执行</UiBadge>
            <UiBadge :tone="statusTone(selected.state)">{{ statusText[selected.state] }}</UiBadge>
            <UiBadge v-if="selected.autoApproved" tone="success">AI 自动批准</UiBadge>
            <UiButton size="small" variant="quiet" :disabled="busy" @click="openAction(selected.id)">重新核对</UiButton>
            <UiButton size="small" variant="quiet" :disabled="busy" @click="openRun(selected.runId)">查看模拟运行</UiButton>
          </div>
          <UiButton v-else-if="error" size="small" :disabled="busy" @click="openAction(detailId)">重新加载提案</UiButton>
          <template v-if="selected">
            <dl class="metadata">
              <div><dt>平台</dt><dd>{{ selected.target.platform }} / {{ selected.target.instance }}</dd></div>
              <div><dt>身份与账号</dt><dd>{{ selected.target.identity }} / {{ selected.target.account }}</dd></div>
              <div><dt>目标</dt><dd>{{ selected.target.conversation }} / {{ selected.target.message }}</dd></div>
              <div><dt>受众</dt><dd>{{ selected.target.audience === 'PUBLIC' ? '公开' : '私聊' }}<template v-if="selected.target.contact"> · {{ selected.target.contact }}</template></dd></div>
            </dl>
            <UiAlert v-if="selected.riskCodes.includes('CROSS_PLATFORM_NEAR_DUPLICATE')" tone="warning">
              此回复与其他平台的内容相似，请核对后再审批。
            </UiAlert>
            <template v-if="selected.content">
              <h4>拟回复内容</h4>
              <p class="console-payload">{{ selected.content }}</p>
              <UiAlert v-if="selected.followUp" tone="info">
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
              </UiAlert>
            </template>
            <p v-else-if="selected.state === 'WAITING_APPROVAL'">当前无法预览正文，暂不能审批。</p>
            <form v-if="selected.state === 'WAITING_APPROVAL' && selected.content"
              @submit.prevent="decide('APPROVE')">
              <UiField label="审批理由" for="review-reason">
                <textarea class="ui-control" v-model="reason" :rows="3" :maxlength="240"
                  v-bind="{ id: 'review-reason', required: true }" :disabled="busy" placeholder="例如：已核对目标和拟发送内容"></textarea>
              </UiField>
              <div class="decision-buttons">
                <UiButton tone="primary" type="submit" :disabled="busy || !reason.trim()">
                  {{ selected.followUp ? '批准回复及后续事项' : '批准模拟回复' }}
                </UiButton>
                <UiButton tone="error" :disabled="busy || !reason.trim()" @click="decide('REJECT')">拒绝</UiButton>
              </div>
            </form>
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
.login-card :deep(.ui-field + .ui-field) { margin-block-start: .625rem; }
.login-actions { display: grid; gap: .625rem; margin-block-start: .625rem; }
.login-alert { margin-block: .5rem; }
.workspace-header, .account-actions, .decision-buttons { display: flex; gap: .625rem; align-items: center; flex-wrap: wrap; }
.workspace-header { justify-content: space-between; }
.account-menu { z-index: 20; box-sizing: border-box; width: min(12rem, var(--reka-popper-available-width, calc(100vw - 1.5rem)));
  display: grid; gap: .125rem; padding: .25rem; background: var(--console-surface); color: var(--console-text);
  border: 1px solid var(--console-line); border-radius: 6px; box-shadow: 0 .5rem 1.5rem #0002; }
.account-menu .account-action { justify-content: flex-start; gap: .625rem; min-height: 2.5rem; text-align: start; }
.account-action > span { flex: none; }
.workspace-shell { display: grid; min-height: calc(100vh - 3.75rem); }
.workspace-shell--with-nav { grid-template-columns: 10.25rem minmax(0, 1fr); }
.workspace-content { display: grid; align-content: start; gap: 1rem; min-width: 0; padding: 1.5rem clamp(1rem, 4vw, 2.5rem) 2rem; }

.navigation-icon { display: grid; place-items: center; inline-size: 2.75rem; block-size: 2.75rem; padding: 0;
  border: 0; border-radius: 5px; background: transparent; color: var(--console-text); font-size: 1.25rem; cursor: pointer; }
.navigation-icon:hover, .navigation-icon[data-state="open"] { background: var(--console-hover); }
.navigation-overlay { position: fixed; inset: 0; z-index: 40; background: rgb(0 0 0 / .38); }
.navigation-drawer { position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 41;
  width: min(18rem, calc(100vw - 2rem)); box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain;
  padding-bottom: env(safe-area-inset-bottom); background: var(--console-nav); color: var(--console-text);
  border-inline-end: 1px solid var(--console-line); box-shadow: 0 .5rem 2rem rgb(0 0 0 / .2); }
.navigation-drawer-heading { display: flex; align-items: center; justify-content: space-between; padding: .5rem .75rem;
  border-bottom: 1px solid var(--console-line); }
.navigation-drawer-heading h2 { margin: 0; font-size: 1rem; font-weight: 650; }
.navigation-drawer :deep(.console-navigation) { border: 0; padding-block: .625rem; }
.navigation-drawer :deep(.console-navigation button) { min-height: 2.75rem; }
.run-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1.125rem; }
.run-navigation [aria-current] { font-weight: 650; }
.access-navigation { gap: .5rem; }
.access-scope { color: var(--console-muted); font-size: .875rem; overflow-wrap: anywhere; }
.workspace-header h2 { font-size: 1.5rem; line-height: 1.25; letter-spacing: -.025em; }
.account-name { max-width: 8rem; }
.account-name[data-state="open"] { background: var(--console-selected); }
.account-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-chevron { flex: none; font-size: .875rem; color: var(--console-muted); }
.account-name[data-state="open"] .account-chevron { transform: rotate(180deg); }
.role-picker { display: flex; align-items: center; gap: .5rem; min-width: 0; }
.role-picker > label { flex: none; color: var(--console-muted); }
.role-picker :deep(.ui-combobox) { width: clamp(7rem, 15vw, 13rem); }
.proposal-actions { margin-bottom: .75rem; }
.metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem 1.25rem; margin: 0 0 1rem; }
.metadata dt { color: var(--console-muted); font-size: .8125rem; }
.metadata dd { margin: .125rem 0 0; overflow-wrap: anywhere; }
.proposal h4 { margin: 0 0 .375rem; font-size: .875rem; }
.follow-up-participants { margin-block: .5rem; padding-inline-start: 1rem; overflow-wrap: anywhere; }
.follow-up-participants span { display: block; }
.decision-buttons { margin-block-start: .75rem; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 46rem) {
  .workspace-shell--with-nav { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 30rem) {
  .account-name { max-width: 7rem; }
  .metadata { grid-template-columns: minmax(0, 1fr); }
}
</style>
