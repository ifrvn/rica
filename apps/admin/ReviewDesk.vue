<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NCollapse, NCollapseItem, NEmpty, NForm, NFormItem, NInput, NPopover, NSelect, NSpin, NTag } from 'naive-ui'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type { NewbiReplyView } from '../../packages/contracts/newbi-pilot.js'
import CharacterWorkspace from './CharacterWorkspace.vue'
import SimulationWorkspace from './SimulationWorkspace.vue'
import { request, RequestError } from './request.js'
import { consoleHash, readConsoleLocation, type ConsoleLocation, type ConsolePage } from './console-location.js'
import type { characterWorkspaceView } from '../../packages/contracts/management.js'
import type { z } from '@hono/zod-openapi'
import type { ActionView } from '../../packages/contracts/action-review.js'

type Character = { id: string; slug: string; profile: { name?: string } | null }
type Page<T> = { items: T[]; nextCursor: string | null }
type Decision = 'APPROVE' | 'REJECT'

const usernameInput = ref('')
const password = ref('')
const username = ref('')
const passkeyPassword = ref('')
const passkeysAvailable = typeof window.PublicKeyCredential === 'function' && window.isSecureContext
const characters = ref<Character[]>([])
const canCreate = ref(false)
const tab = ref<ConsolePage>('character')
const detailId = ref<string>()
const routing = ref(false)
let revision = 0
const characterCursor = ref<string | null>(null)
const roles = ref<string[]>([])
const canReadRuns = computed(() => roles.value.some((role) => role === 'ADMIN' || role === 'AUDITOR'))
const canReviewSimulation = computed(() => roles.value.includes('REVIEWER'))
const canReview = computed(() => canReviewSimulation.value || roles.value.includes('ADMIN'))
const characterId = ref('')
const characterOptions = computed(() => characters.value.map(({ id, profile, slug }) => ({ label: profile?.name || slug, value: id })))
const actions = ref<ActionView[]>([])
const nextCursor = ref<string | null>(null)
let queueLoaded = false
const selected = ref<ActionView>()
const reason = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
let pending: { signature: string; key: string } | undefined
const newbiId = ref('')
const newbiReply = ref<NewbiReplyView>()
const newbiReason = ref('')
let newbiPending: { signature: string; key: string } | undefined
const newbiPath = computed(() => '/v1/characters/' + encodeURIComponent(characterId.value) + '/newbi/replies')
const newbiStatus: Record<NewbiReplyView['status'], string> = {
  WAITING: '待审', READY: '已批准', REJECTED: '已拒绝', IN_FLIGHT: '发送中', UNKNOWN: '待核对', SENT: '已发送', CLOSED: '已结案',
}

const path = computed(() => '/v1/characters/' + encodeURIComponent(characterId.value) + '/actions')
const statusText: Record<ActionView['state'], string> = {
  WAITING_APPROVAL: '待审', READY: '已批准', REJECTED: '已拒绝', CANCELED: '已失效', EXPIRED: '已过期',
  EXECUTING: '模拟执行中', RECONCILING: '待对账', SIMULATED: '模拟完成', BLOCKED: '执行已拦截',
}

function statusTone(state: ActionView['state'] | NewbiReplyView['status']) {
  if (state === 'WAITING_APPROVAL' || state === 'WAITING' || state === 'RECONCILING' || state === 'UNKNOWN') return 'warning'
  if (state === 'READY' || state === 'SIMULATED' || state === 'SENT') return 'success'
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
    if ([401, 403, 404, 409, 412].includes(status)) newbiReply.value = undefined
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
  return applyLocation(location ?? (first && { characterId: first.id, page: 'character' }), !location)
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
    resetNewbi()
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
      if (!characters.value.some(({ id }) => id === target)) characters.value = [...characters.value, workspace]
    }
    characterId.value = target
    const denied = (location.page === 'runs' && !canReadRuns.value)
      || (location.page === 'review' && (!canReview.value || (!!location.detail && !canReviewSimulation.value)))
    tab.value = denied ? 'character' : location.page
    detailId.value = denied ? undefined : location.detail
    if (denied) error.value = '当前账号无权打开此链接。'
    if (replace || denied) {
      window.history.replaceState(null, '', consoleHash({ characterId: target, page: tab.value, detail: detailId.value }))
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
    notice.value = '已添加 Passkey。'
  })
}

function resetReview() {
  selected.value = undefined
  reason.value = ''
  pending = undefined
}

function resetNewbi() {
  newbiId.value = ''
  newbiReply.value = undefined
  newbiReason.value = ''
  newbiPending = undefined
}

async function disconnect() {
  await run(async () => {
    await authPost('logout')
    resetSession()
  })
}

function resetSession() {
  ++revision
  routing.value = false
  detailId.value = undefined
  resetNewbi()
  username.value = ''
  password.value = ''
  passkeyPassword.value = ''
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

function openAction(id: string) {
  if (detailId.value !== id) navigate({ characterId: characterId.value, page: 'review', detail: id })
  else {
    const current = revision
    void run(() => fetchAction(id, current), current)
  }
}

function openRun(id: string) {
  navigate({ characterId: characterId.value, page: 'runs', detail: id })
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
    notice.value = outcome.status === 'READY' ? '已批准模拟提案。' : '已拒绝模拟提案。'
  }, current)
}
async function openNewbiReply() {
  const id = newbiId.value.trim()
  if (!id) return
  const current = revision
  await run(async () => {
    newbiReply.value = undefined
    newbiReason.value = ''
    newbiPending = undefined
    const reply = await request<NewbiReplyView>(newbiPath.value + '/' + encodeURIComponent(id))
    if (current === revision) newbiReply.value = reply
  }, current)
}

async function decideNewbi(decision: Decision) {
  const reply = newbiReply.value
  const reason = newbiReason.value.trim()
  if (busy.value || !reply?.content || reply.status !== 'WAITING' || !reason) return
  const data = { decision, reviewDigest: reply.reviewDigest, reason }
  const signature = JSON.stringify([reply.id, data])
  if (newbiPending?.signature !== signature) newbiPending = { signature, key: crypto.randomUUID() }
  const { key } = newbiPending
  const current = revision
  await run(async () => {
    const result = await request<{ status: 'READY' | 'REJECTED' }>(
      newbiPath.value + '/' + encodeURIComponent(reply.id) + '/decision', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(data),
      },
    )
    if (current !== revision) return
    newbiReply.value = { ...reply, status: result.status }
    newbiReason.value = ''
    newbiPending = undefined
    notice.value = result.status === 'READY' ? '扭笔回复已批准，等待单次执行。' : '扭笔回复已拒绝。'
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
            :disabled="busy" placeholder="" />
        </NFormItem>
        <NFormItem label="密码" :label-props="{ for: 'review-password' }">
          <NInput v-model:value="password" type="password"
            :input-props="{ id: 'review-password', autocomplete: 'current-password', required: true }"
            :disabled="busy" placeholder="" />
        </NFormItem>
        <NAlert v-if="error" type="error" role="alert" class="login-alert">{{ error }}</NAlert>
        <div class="login-actions">
          <NButton type="primary" attr-type="submit" block :disabled="busy">登录</NButton>
          <NButton v-if="passkeysAvailable" block :disabled="busy" @click="passkeyLogin">使用 Passkey</NButton>
        </div>
      </NForm>
    </NCard>

    <template v-else>
      <div class="workspace-header">
        <h2 id="review-heading">{{ tab === 'character' ? '角色与身份' : tab === 'runs' ? '运行' : '人工审批' }}</h2>
        <div class="account-actions">
          <NTag size="small" :bordered="false" class="account-name">{{ username }}</NTag>
          <NPopover v-if="passkeysAvailable" trigger="click" placement="bottom-end" :width="248">
            <template #trigger>
              <NButton size="small" :disabled="busy">添加 Passkey</NButton>
            </template>
            <NForm :show-feedback="false" @submit.prevent="registerPasskey">
              <NFormItem label="确认密码" :label-props="{ for: 'review-passkey-password' }">
                <NInput v-model:value="passkeyPassword" type="password"
                  :input-props="{ id: 'review-passkey-password', autocomplete: 'current-password', required: true }"
                  :disabled="busy" placeholder="" />
              </NFormItem>
              <NButton attr-type="submit" type="primary" size="small" class="passkey-submit" :disabled="busy">确认添加</NButton>
            </NForm>
          </NPopover>
          <NButton size="small" :disabled="busy" @click="disconnect">退出登录</NButton>
        </div>
      </div>

      <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>

      <nav class="account-actions" aria-label="控制台导航">
        <NButton :type="tab === 'character' ? 'primary' : 'default'" :disabled="busy" @click="changeTab('character')">角色与身份</NButton>
        <NButton :type="tab === 'review' ? 'primary' : 'default'" :disabled="busy || routing || !canReview" @click="changeTab('review')">审批</NButton>
        <NButton :type="tab === 'runs' ? 'primary' : 'default'" :disabled="busy || routing || !canReadRuns" @click="changeTab('runs')">运行</NButton>
      </nav>
      <div v-if="characters.length" class="role-picker">
        <label for="review-character">角色</label>
        <NSelect :value="characterId || null" :options="characterOptions" :disabled="busy"
          :input-props="{ id: 'review-character' }" placeholder="选择角色" filterable @update:value="changeCharacter" />
        <NButton v-if="characterCursor" size="small" :disabled="busy"
          @click="run(() => fetchCharacters(characterCursor ?? undefined))">加载更多角色</NButton>
      </div>

      <NSpin v-if="routing && !characterId" />
      <CharacterWorkspace v-else-if="tab === 'character'" :key="characterId" :character-id="characterId"
        :can-create="canCreate" @created="characterCreated" @expired="resetSession" @roles="roles = $event" />
      <SimulationWorkspace v-else-if="tab === 'runs' && characterId && canReadRuns" :key="characterId"
        :character-id="characterId" :can-start="roles.includes('ADMIN')" :detail-id="detailId" @expired="resetSession" @open="openRun" />
      <div v-else-if="tab === 'review' && characterId && canReviewSimulation" class="review-layout" :class="{ 'review-layout--single': !actions.length && !selected }">
        <NCard class="queue" size="small">
          <div class="card-heading">
            <h3>待办</h3>
            <NButton size="small" quaternary :disabled="busy" @click="loadQueue()">刷新</NButton>
          </div>
          <NEmpty v-if="!actions.length && !busy && !routing && !error" description="暂无待审提案。" />
          <ul v-if="actions.length" class="queue-items">
            <li v-for="item in actions" :key="item.id">
              <NButton block :type="selected?.id === item.id ? 'primary' : 'default'" secondary
                class="queue-button" :disabled="busy" :aria-pressed="selected?.id === item.id" @click="openAction(item.id)">
                <span class="queue-item">
                  <span class="queue-identity">{{ item.target.identity }}</span>
                  <span class="queue-account">{{ item.target.account }}</span>
                  <NTag size="tiny" :bordered="false" :type="statusTone(item.state)" class="queue-status">{{ statusText[item.state] }}</NTag>
                </span>
              </NButton>
            </li>
          </ul>
          <NButton v-if="nextCursor" block size="small" quaternary :disabled="busy" @click="loadQueue(true)">加载更多</NButton>
        </NCard>

        <NCard v-if="selected" class="proposal" size="small">
          <div class="card-heading">
            <div class="proposal-title">
              <h3>模拟回复</h3>
              <NTag size="small" :bordered="false" :type="statusTone(selected.state)">{{ statusText[selected.state] }}</NTag>
            </div>
            <NButton size="small" quaternary :disabled="busy" @click="openAction(selected.id)">重新核对</NButton>
          </div>
          <dl class="metadata">
            <div><dt>平台</dt><dd>{{ selected.target.platform }} / {{ selected.target.instance }}</dd></div>
            <div><dt>身份与账号</dt><dd>{{ selected.target.identity }} / {{ selected.target.account }}</dd></div>
            <div><dt>目标</dt><dd>{{ selected.target.conversation }} / {{ selected.target.message }}</dd></div>
            <div><dt>受众</dt><dd>{{ selected.target.audience === 'PUBLIC' ? '公开' : '私聊' }}<template v-if="selected.target.contact"> · {{ selected.target.contact }}</template></dd></div>
            <div v-if="selected.riskCodes.length"><dt>风险码</dt><dd>{{ selected.riskCodes.join(' · ') }}</dd></div>
          </dl>
          <template v-if="selected.content">
            <h4>拟发送内容</h4>
            <p class="payload">{{ selected.content }}</p>
          </template>
          <NForm v-if="selected.state === 'WAITING_APPROVAL' && selected.content" :show-feedback="false"
            @submit.prevent="decide('APPROVE')">
            <NFormItem label="审批理由" :label-props="{ for: 'review-reason' }">
              <NInput v-model:value="reason" type="textarea" :rows="3" :maxlength="240"
                :input-props="{ id: 'review-reason', required: true }" :disabled="busy" placeholder="" />
            </NFormItem>
            <div class="decision-buttons">
              <NButton type="primary" attr-type="submit" :disabled="busy || !reason.trim()">批准模拟回复</NButton>
              <NButton :disabled="busy || !reason.trim()" @click="decide('REJECT')">拒绝</NButton>
            </div>
          </NForm>
        </NCard>
        <NCard v-else-if="actions.length" class="blank-card">
          <NEmpty description="选择一条待审提案。" />
        </NCard>
      </div>

      <NCard v-if="tab === 'review' && characterId && canReview" size="small">
        <NCollapse>
          <NCollapseItem name="pilot" title="扭笔本地试点">
            <NForm class="lookup" :show-feedback="false" @submit.prevent="openNewbiReply">
              <NFormItem label="提案 ID" :label-props="{ for: 'newbi-reply-id' }">
                <NInput v-model:value="newbiId" :input-props="{ id: 'newbi-reply-id', required: true }"
                  :disabled="busy" placeholder="" />
              </NFormItem>
              <NButton attr-type="submit" :disabled="busy || !newbiId.trim()">查看扭笔提案</NButton>
            </NForm>
            <section v-if="newbiReply" class="pilot-proposal" aria-labelledby="pilot-proposal-heading">
              <div class="proposal-title">
                <h3 id="pilot-proposal-heading">扭笔回复</h3>
                <NTag size="small" :bordered="false" :type="statusTone(newbiReply.status)">{{ newbiStatus[newbiReply.status] }}</NTag>
              </div>
              <dl class="metadata">
                <div><dt>本机平台</dt><dd>{{ newbiReply.endpoint }}</dd></div>
                <div><dt>身份与账号</dt><dd>{{ newbiReply.identityId }} / {{ newbiReply.accountId }}</dd></div>
                <div><dt>扭笔 Agent</dt><dd>{{ newbiReply.agentId }}</dd></div>
                <div><dt>目标帖子</dt><dd>{{ newbiReply.postId }} · 公开回复</dd></div>
                <div v-if="newbiReply.remoteCommentId"><dt>评论回执</dt><dd>{{ newbiReply.remoteCommentId }}</dd></div>
              </dl>
              <p v-if="newbiReply.content" class="payload">{{ newbiReply.content }}</p>
              <NForm v-if="newbiReply.status === 'WAITING' && newbiReply.content" :show-feedback="false"
                @submit.prevent="decideNewbi('APPROVE')">
                <NFormItem label="审批理由" :label-props="{ for: 'newbi-reason' }">
                  <NInput v-model:value="newbiReason" type="textarea" :rows="3" :maxlength="240"
                    :input-props="{ id: 'newbi-reason', required: true }" :disabled="busy" placeholder="" />
                </NFormItem>
                <div class="decision-buttons">
                  <NButton type="primary" attr-type="submit" :disabled="busy || !newbiReason.trim()">批准扭笔回复</NButton>
                  <NButton :disabled="busy || !newbiReason.trim()" @click="decideNewbi('REJECT')">拒绝</NButton>
                </div>
              </NForm>
            </section>
          </NCollapseItem>
        </NCollapse>
      </NCard>
    </template>
    <span v-if="busy" class="sr-only" role="status">处理中…</span>
  </section>
</template>

<style scoped>
.review-desk { display: grid; gap: 1rem; }
.login-card { width: min(100%, 25rem); margin: clamp(1rem, 8vh, 5rem) auto 0; }
.login-card h2, .workspace-header h2, h3 { margin: 0; }
.login-card h2 { font-size: 1.25rem; margin-block-end: 1rem; }
.login-card :deep(.n-form-item + .n-form-item) { margin-block-start: .625rem; }
.login-actions { display: grid; gap: .625rem; margin-block-start: .625rem; }
.login-alert { margin-block: .5rem; }
.workspace-header, .account-actions, .decision-buttons, .proposal-title { display: flex; gap: .625rem; align-items: center; flex-wrap: wrap; }
.workspace-header { justify-content: space-between; margin-block-end: .375rem; }
.workspace-header h2 { font-size: 1.5rem; line-height: 1.25; letter-spacing: -.025em; }
.account-name { max-width: 12rem; }
.account-name :deep(.n-tag__content) { overflow: hidden; text-overflow: ellipsis; }
.role-picker { display: flex; align-items: center; gap: .75rem; width: min(100%, 20rem); }
.role-picker > label { flex: none; color: #485c5b; }
.review-layout { display: grid; grid-template-columns: minmax(13rem, 19rem) minmax(0, 1fr); gap: 1rem; align-items: start; }
.review-layout--single { grid-template-columns: minmax(0, 1fr); }
.review-layout > * { min-width: 0; }
.card-heading { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin-block-end: .625rem; }
.queue h3, .proposal-title h3 { font-size: 1rem; font-weight: 650; }
.queue-items { display: grid; gap: .5rem; margin: 0; padding: 0; list-style: none; }
.queue-items + .n-button { margin-block-start: .5rem; }
.queue-button { min-height: 3.25rem; height: auto; padding-block: .5rem; }
.queue-button :deep(.n-button__content) { width: 100%; text-align: left; }
.queue-item { line-height: 1.3; display: grid; grid-template-columns: minmax(0, 1fr) auto; width: 100%; column-gap: .5rem; align-items: center; }
.queue-identity, .queue-account { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-identity { font-weight: 650; }
.queue-account { grid-column: 1; color: #536866; font-size: .75rem; }
.queue-status { grid-area: 1 / 2 / span 2 / 3; }
.blank-card :deep(.n-card__content) { padding-block: 2rem; }
.metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem 1.25rem; margin: 0 0 1rem; }
.metadata dt { color: #536866; font-size: .8125rem; }
.metadata dd { margin: .125rem 0 0; overflow-wrap: anywhere; }
.proposal h4 { margin: 0 0 .375rem; font-size: .875rem; }
.payload { margin: 0 0 1rem; padding: .875rem 1rem; border-radius: .5rem; background: #f3f7f6; white-space: pre-wrap; overflow-wrap: anywhere; }
.lookup { display: flex; gap: .625rem; align-items: flex-end; max-width: 33rem; }
.lookup :deep(.n-form-item) { flex: 1; min-width: 0; }
.decision-buttons, .passkey-submit { margin-block-start: .75rem; }
.pilot-proposal { margin-block-start: 1rem; }
.pilot-proposal .proposal-title { margin-block-end: .75rem; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 46rem) { .review-layout { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 30rem) {
  .metadata { grid-template-columns: minmax(0, 1fr); }
  .lookup { align-items: stretch; flex-direction: column; }
}
</style>
