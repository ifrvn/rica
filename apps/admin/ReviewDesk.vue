<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type { NewbiReplyView } from '../../packages/contracts/newbi-pilot.js'
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
const characterId = ref('')
const actions = ref<ActionView[]>([])
const nextCursor = ref<string | null>(null)
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

class RequestError extends Error {
  constructor(readonly status: number) { super() }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new RequestError(response.status)
  return response.json()
}

function authPost<T>(path: string, data: object = {}) {
  return request<T>('/v1/auth/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
}

type Session = { username: string }
type AuthenticationOptions = { challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }
type RegistrationOptions = { challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }

async function run(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await task()
  } catch (cause) {
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
  characters.value = (await request<Page<Character>>('/v1/characters?limit=100')).items
}

onMounted(() => run(async () => {
  const session = await request<Session>('/v1/auth/session').catch((cause: unknown) => {
    if (cause instanceof RequestError && (cause.status === 401 || cause.status === 404)) return null
    throw cause
  })
  if (session) await openSession(session)
}))

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
  resetNewbi()
  username.value = ''
  password.value = ''
  passkeyPassword.value = ''
  characters.value = []
  characterId.value = ''
  actions.value = []
  nextCursor.value = null
  error.value = ''
  notice.value = ''
  resetReview()
}

async function loadQueue(append = false) {
  if (!characterId.value) return
  await run(async () => {
    const cursor = append && nextCursor.value ? '?cursor=' + encodeURIComponent(nextCursor.value) : ''
    const result = await request<Page<ActionView>>(path.value + cursor)
    actions.value = append ? [...actions.value, ...result.items] : result.items
    nextCursor.value = result.nextCursor
    const preview = selected.value
    if (!append && preview?.state === 'WAITING_APPROVAL' && !result.items.some(({ id }) => id === preview.id)) {
      selected.value = { ...preview, content: null }
    }
  })
}

function changeCharacter() {
  resetNewbi()
  actions.value = []
  nextCursor.value = null
  resetReview()
  void loadQueue()
}

async function openAction(id: string) {
  await run(async () => {
    if (selected.value?.id !== id) resetReview()
    selected.value = await request<ActionView>(path.value + '/' + id)
  })
}

async function decide(decision: Decision) {
  const proposal = selected.value
  const note = reason.value.trim()
  if (busy.value || !proposal?.content || proposal.state !== 'WAITING_APPROVAL' || !note) return
  const data = { decision, reviewDigest: proposal.reviewDigest, reason: note }
  const signature = JSON.stringify([proposal.id, proposal.version, data])
  if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
  const { key } = pending
  await run(async () => {
    const outcome = await request<{ status: 'READY' | 'REJECTED'; version: number }>(
      path.value + '/' + proposal.id + '/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"run-v' + proposal.version + '"',
          'Idempotency-Key': key },
        body: JSON.stringify(data),
      },
    )
    actions.value = actions.value.filter(({ id }) => id !== proposal.id)
    selected.value = { ...proposal, content: null, state: outcome.status, version: outcome.version }
    reason.value = ''
    pending = undefined
    notice.value = outcome.status === 'READY' ? '已批准模拟提案。' : '已拒绝模拟提案。'
  })
}
async function openNewbiReply() {
  const id = newbiId.value.trim()
  if (!id) return
  await run(async () => {
    newbiReply.value = undefined
    newbiReason.value = ''
    newbiPending = undefined
    newbiReply.value = await request<NewbiReplyView>(newbiPath.value + '/' + encodeURIComponent(id))
  })
}

async function decideNewbi(decision: Decision) {
  const reply = newbiReply.value
  const reason = newbiReason.value.trim()
  if (busy.value || !reply?.content || reply.status !== 'WAITING' || !reason) return
  const data = { decision, reviewDigest: reply.reviewDigest, reason }
  const signature = JSON.stringify([reply.id, data])
  if (newbiPending?.signature !== signature) newbiPending = { signature, key: crypto.randomUUID() }
  const { key } = newbiPending
  await run(async () => {
    const result = await request<{ status: 'READY' | 'REJECTED' }>(
      newbiPath.value + '/' + encodeURIComponent(reply.id) + '/decision', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(data),
      },
    )
    newbiReply.value = { ...reply, status: result.status }
    newbiReason.value = ''
    newbiPending = undefined
    notice.value = result.status === 'READY' ? '扭笔回复已批准，等待单次执行。' : '扭笔回复已拒绝。'
  })
}
</script>

<template>
  <section class="review-desk" aria-labelledby="review-heading">
    <div class="review-header">
      <h2 id="review-heading">人工审批</h2>
      <button v-if="username" type="button" :disabled="busy" @click="disconnect">退出登录</button>
    </div>

    <form v-if="!username" class="connect" @submit.prevent="connect">
      <label for="review-username">用户名</label>
      <input id="review-username" v-model="usernameInput" autocomplete="username" required :disabled="busy" />
      <label for="review-password">密码</label>
      <input id="review-password" v-model="password" type="password" autocomplete="current-password" required :disabled="busy" />
      <div class="review-buttons">
        <button type="submit" :disabled="busy">登录</button>
        <button v-if="passkeysAvailable" type="button" :disabled="busy" @click="passkeyLogin">使用 Passkey</button>
      </div>
    </form>

    <template v-else>
      <details v-if="passkeysAvailable">
        <summary>添加 Passkey</summary>
        <form class="connect" @submit.prevent="registerPasskey">
          <label for="review-passkey-password">确认密码</label>
          <input id="review-passkey-password" v-model="passkeyPassword" type="password"
            autocomplete="current-password" required :disabled="busy" />
          <button type="submit" :disabled="busy">添加 Passkey</button>
        </form>
      </details>
      <div class="role-picker">
        <label for="review-character">角色</label>
        <select id="review-character" v-model="characterId" :disabled="busy" @change="changeCharacter">
          <option value="" disabled>选择角色</option>
          <option v-for="character in characters" :key="character.id" :value="character.id">
            {{ character.profile?.name || character.slug }}
          </option>
        </select>
      </div>
      <p v-if="!characters.length">当前账号没有可访问的角色。</p>
      <div v-if="characterId" class="review-layout">
        <div class="queue">
          <div class="review-header">
            <h3>待办</h3>
            <button type="button" :disabled="busy" @click="loadQueue()">刷新</button>
          </div>
          <p v-if="!actions.length && !busy && !error">暂无待审提案。</p>
          <ul v-if="actions.length">
            <li v-for="item in actions" :key="item.id">
              <button type="button" :disabled="busy" :aria-pressed="selected?.id === item.id" @click="openAction(item.id)">
                {{ item.target.identity }} · {{ item.target.account }} · {{ statusText[item.state] }}
              </button>
            </li>
          </ul>
          <button v-if="nextCursor" type="button" :disabled="busy" @click="loadQueue(true)">加载更多</button>
        </div>
        <section v-if="selected" class="proposal" aria-labelledby="proposal-heading">
          <div class="review-header">
            <h3 id="proposal-heading">模拟回复 · {{ statusText[selected.state] }}</h3>
            <button type="button" :disabled="busy" @click="openAction(selected.id)">重新核对</button>
          </div>
          <dl>
            <dt>平台</dt><dd>{{ selected.target.platform }} / {{ selected.target.instance }}</dd>
            <dt>身份与账号</dt><dd>{{ selected.target.identity }} / {{ selected.target.account }}</dd>
            <dt>目标</dt><dd>{{ selected.target.conversation }} / {{ selected.target.message }}</dd>
            <dt>受众</dt><dd>{{ selected.target.audience === 'PUBLIC' ? '公开' : '私聊' }}<template v-if="selected.target.contact"> · {{ selected.target.contact }}</template></dd>
            <dt>风险码</dt><dd>{{ selected.riskCodes.join(' · ') }}</dd>
          </dl>
          <template v-if="selected.content">
            <h4>拟发送内容</h4>
            <p class="payload">{{ selected.content }}</p>
          </template>
          <form v-if="selected.state === 'WAITING_APPROVAL' && selected.content" @submit.prevent="decide('APPROVE')">
            <label for="review-reason">审批理由</label>
            <textarea id="review-reason" v-model="reason" required maxlength="240" :disabled="busy" rows="3" />
            <div class="decision-buttons">
              <button class="primary" type="submit" :disabled="busy || !reason.trim()">批准模拟回复</button>
              <button type="button" :disabled="busy || !reason.trim()" @click="decide('REJECT')">拒绝</button>
            </div>
          </form>
        </section>
      </div>
      <details v-if="characterId" class="proposal newbi-review">
        <summary>扭笔本地试点</summary>
        <form @submit.prevent="openNewbiReply">
          <label for="newbi-reply-id">提案 ID</label>
          <input id="newbi-reply-id" v-model="newbiId" required :disabled="busy" />
          <button type="submit" :disabled="busy || !newbiId.trim()">查看扭笔提案</button>
        </form>
        <template v-if="newbiReply">
          <h3>扭笔回复 · {{ newbiStatus[newbiReply.status] }}</h3>
          <dl>
            <dt>本机平台</dt><dd>{{ newbiReply.endpoint }}</dd>
            <dt>身份与账号</dt><dd>{{ newbiReply.identityId }} / {{ newbiReply.accountId }}</dd>
            <dt>扭笔 Agent</dt><dd>{{ newbiReply.agentId }}</dd>
            <dt>目标帖子</dt><dd>{{ newbiReply.postId }} · 公开回复</dd>
            <template v-if="newbiReply.remoteCommentId">
              <dt>评论回执</dt><dd>{{ newbiReply.remoteCommentId }}</dd>
            </template>
          </dl>
          <p v-if="newbiReply.content" class="payload">{{ newbiReply.content }}</p>
          <form v-if="newbiReply.status === 'WAITING' && newbiReply.content" @submit.prevent="decideNewbi('APPROVE')">
            <label for="newbi-reason">审批理由</label>
            <textarea id="newbi-reason" v-model="newbiReason" maxlength="240" rows="3" required :disabled="busy" />
            <div class="decision-buttons">
              <button class="primary" type="submit" :disabled="busy || !newbiReason.trim()">批准扭笔回复</button>
              <button type="button" :disabled="busy || !newbiReason.trim()" @click="decideNewbi('REJECT')">拒绝</button>
            </div>
          </form>
        </template>
      </details>
    </template>
    <p v-if="busy" role="status">处理中…</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.review-desk { margin-block-start: 1.5rem; }
.newbi-review { margin-block-start: 1rem; }
.review-header, .decision-buttons { display: flex; gap: .6rem; justify-content: space-between; align-items: center; flex-wrap: wrap; }
.review-header :is(h2, h3) { margin: 0; }
.connect, .proposal form { display: grid; gap: .5rem; margin-block-start: .9rem; }
.review-buttons { display: flex; flex-wrap: wrap; gap: .5rem; }
.role-picker { display: flex; gap: .6rem; align-items: center; margin-block: .9rem; }
.review-layout { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(0, 2fr); gap: 1rem; align-items: start; }
.queue, .proposal { min-width: 0; padding: .9rem; border: 1px solid #d9e0e8; border-radius: .5rem; }
.queue ul { list-style: none; padding: 0; display: grid; gap: .35rem; }
.queue li button { width: 100%; text-align: left; overflow-wrap: anywhere; }
.queue button[aria-pressed="true"] { border-color: #2760a8; background: #e9f2ff; }
input, select, textarea { font: inherit; min-width: 0; max-width: 100%; padding: .5rem; border: 1px solid #68788a; border-radius: .35rem; }
textarea { resize: vertical; }
.proposal dl { grid-template-columns: minmax(4.5rem, auto) minmax(0, 1fr); }
.proposal dd, .payload { overflow-wrap: anywhere; white-space: pre-wrap; }
.payload { padding: .75rem; background: #f2f5f9; border-radius: .4rem; }
.decision-buttons { justify-content: flex-start; }
.primary { color: white; background: #225790; border: 1px solid #225790; }
button:disabled { cursor: default; opacity: .65; }
:is(input, select, textarea, button):focus-visible { outline: 2px solid #2760a8; outline-offset: 2px; }
.error { color: #a32727; }
@media (max-width: 42rem) { .review-layout { grid-template-columns: minmax(0, 1fr); } }
</style>
