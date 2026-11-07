<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ActionView } from '../../packages/contracts/action-review.js'

type Character = { id: string; slug: string; profile: { name?: string } | null }
type Page<T> = { items: T[]; nextCursor: string | null }
type Decision = 'APPROVE' | 'REJECT'

const tokenInput = ref('')
const token = ref('')
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

const path = computed(() => '/v1/characters/' + encodeURIComponent(characterId.value) + '/actions')
const statusText: Record<ActionView['state'], string> = {
  WAITING_APPROVAL: '待审', READY: '已批准', REJECTED: '已拒绝', CANCELED: '已失效', EXPIRED: '已过期',
}

class RequestError extends Error {
  constructor(readonly status: number) { super() }
}

async function request<T>(url: string, accessToken = token.value, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer ' + accessToken)
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new RequestError(response.status)
  return response.json()
}

async function run(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await task()
  } catch (cause) {
    const status = cause instanceof RequestError ? cause.status : 0
    error.value = ({
      401: '令牌无效或已过期。', 403: '你没有此角色的审批权限。', 404: '找不到该提案或审批服务。',
      409: '提案已失效，请重新打开后核对。', 412: '提案已更新，请重新打开后核对。',
    } as Record<number, string>)[status] ?? '请求失败，请重试。'
    if ([401, 403, 404, 409, 412].includes(status) && selected.value) {
      selected.value = { ...selected.value, content: null }
    }
  } finally {
    busy.value = false
  }
}

async function connect() {
  const candidate = tokenInput.value.trim()
  if (!candidate) return
  await run(async () => {
    const result = await request<Page<Character>>('/v1/characters?limit=100', candidate)
    token.value = candidate
    tokenInput.value = ''
    characters.value = result.items
  })
}

function resetReview() {
  selected.value = undefined
  reason.value = ''
  pending = undefined
}

function disconnect() {
  token.value = ''
  tokenInput.value = ''
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
      path.value + '/' + proposal.id + '/decisions', token.value, {
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
</script>

<template>
  <section class="review-desk" aria-labelledby="review-heading">
    <div class="review-header">
      <h2 id="review-heading">人工审批</h2>
      <button v-if="token" type="button" :disabled="busy" @click="disconnect">退出审批</button>
    </div>

    <form v-if="!token" class="connect" @submit.prevent="connect">
      <label for="review-token">身份提供方访问令牌</label>
      <input id="review-token" v-model="tokenInput" type="password" autocomplete="off" required :disabled="busy" />
      <button type="submit" :disabled="busy">打开待办</button>
    </form>

    <template v-else>
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
    </template>
    <p v-if="busy" role="status">处理中…</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.review-desk { margin-block-start: 1.5rem; }
.review-header, .decision-buttons { display: flex; gap: .6rem; justify-content: space-between; align-items: center; flex-wrap: wrap; }
.review-header :is(h2, h3) { margin: 0; }
.connect, .proposal form { display: grid; gap: .5rem; margin-block-start: .9rem; }
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
