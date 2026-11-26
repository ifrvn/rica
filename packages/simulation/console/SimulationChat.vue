<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { formatTime, queryPath, type Page } from '@ricajs/console-shared/console-data'
import { request, RequestError } from '@ricajs/console-shared/request'
import type { z } from '@hono/zod-openapi'
import type { simulationChatSummary, simulationChatView } from '../contracts/observability.js'

type Chat = z.infer<typeof simulationChatView>
type Room = z.infer<typeof simulationChatSummary>
type Term = Chat['glossary'][number]
const props = defineProps<{
  base: string; accounts: { value: string; label: string; isIm: boolean }[]; canStart: boolean
  selected?: string; requestedChat?: string | null; requestedAccount?: string; focusComposer: boolean
  identity: (identityId: string) => string; stateName: (state: string) => string
}>()
const emit = defineEmits<{ expired: []; open: [id?: string]; latest: [id?: string]; browse: [following: boolean]; sent: []; identities: [] }>()
const account = ref('')
const room = ref('')
const rooms = ref<Room[]>([])
const roomCursor = ref<string | null>(null)
const loadingRooms = ref(false)
const chat = ref<Chat>()
const speaker = ref('')
const newSpeaker = ref('')
const addingSpeaker = ref(true)
const message = ref('')
const sending = ref(false)
const loading = ref(false)
const error = ref('')
const editedTerm = ref<Term>()
const editedMeaning = ref('')
const editedTone = ref<Term['tone']>('neutral')
const savingTerm = ref(false)
const glossaryError = ref('')
const tones = { neutral: '中性', playful: '玩笑', sarcastic: '反讽', sensitive: '敏感' }
const termStates = { LEARNED: '自动习得', CORRECTED: '已纠正', DISABLED: '已停用', UNAVAILABLE: '来源不可用' }
const transcript = ref<HTMLElement>()
const composer = ref<HTMLTextAreaElement>()
const author = computed(() => (addingSpeaker.value ? newSpeaker.value : speaker.value).trim())
const activeAccount = computed(() => props.accounts.find(({ value }) => value === account.value))
const isIm = computed(() => activeAccount.value?.isIm === true)
let active = true
let revision = 0
let loadGeneration = 0
let timer: ReturnType<typeof setTimeout> | undefined
let pending: { body: string; key: string } | undefined
let draftRoom = ''
const activeStates = new Set(['QUEUED', 'CONTEXT_READY', 'DRAFTED', 'WAITING_APPROVAL', 'READY', 'EXECUTING', 'RECONCILING'])

const bubbles = computed(() => (chat.value?.turns ?? []).flatMap(turn => {
  const inbound = { key: turn.id, run: turn.id, text: turn.message, at: turn.sentAt, sender: turn.speaker,
    state: turn.repliedAt ? '' : turn.state, isReply: false }
  if (!turn.repliedAt) return [inbound]
  const at = turn.repliedAt
  return [inbound, ...(turn.replies ?? [null]).map((text, index) => ({
    key: `${turn.id}-reply-${index}`, run: turn.id, text, at,
    sender: props.identity(turn.identityId), state: '', isReply: true,
  }))]
}).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)))

function scrollToEnd() {
  void nextTick(() => {
    if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
  })
}

function handle(cause: unknown, fallback: string) {
  const status = cause instanceof RequestError ? cause.status : 0
  if (status === 401) emit('expired')
  else if (cause instanceof RequestError && cause.code === 'SIMULATION_ACCOUNT_NOT_IM') error.value = '此账号用于发帖或评论，请选择 IM 账号发起群聊。'
  else error.value = ({
    403: '当前账号无权执行此操作。', 404: '找不到此模拟会话或账号。',
    409: '会话或模拟账号当前不可用。', 422: isIm.value ? '请核对群员昵称和消息内容。' : '请核对帖子或评论内容。',
  } as Record<number, string>)[status] ?? fallback
}

async function fetchRoom(id: string, token = revision, background = false) {
  clearTimeout(timer)
  if (!id) return
  const generation = ++loadGeneration
  if (!background) loading.value = true
  try {
    const current = await request<Chat>(props.base + '/simulation-chats/' + encodeURIComponent(id))
    if (!active || revision !== token || generation !== loadGeneration) return
    const nearEnd = !transcript.value || transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 65
    chat.value = current
    if (!speaker.value || !current.speakers.includes(speaker.value)) {
      speaker.value = current.speakers[0] ?? ''
      if (!newSpeaker.value && speaker.value) addingSpeaker.value = false
    }
    emit('latest', current.turns.at(-1)?.id)
    if (!background) error.value = ''
    if (!background || nearEnd) scrollToEnd()
  } catch (cause) {
    if (!active || revision !== token || generation !== loadGeneration) return
    if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) {
      chat.value = undefined
      emit('latest', undefined)
    }
    handle(cause, '无法读取会话，请刷新后重试。')
  } finally {
    if (active && revision === token && generation === loadGeneration) {
      loading.value = false
      if (chat.value?.turns.some(({ state }) => activeStates.has(state))) {
        timer = setTimeout(() => { void fetchRoom(id, token, true) }, 2500)
      }
    }
  }
}

async function selectRoom(id: string, user = false) {
  const token = ++revision
  clearTimeout(timer)
  room.value = id
  chat.value = undefined
  loading.value = false
  draftRoom = ''
  pending = undefined
  speaker.value = newSpeaker.value = ''
  addingSpeaker.value = true
  error.value = ''
  editedTerm.value = undefined
  glossaryError.value = ''
  emit('latest', undefined)
  if (user) {
    emit('browse', true)
    emit('open')
  }
  if (id) await fetchRoom(id, token)
}

async function loadRooms(append = false, selectLatest = false) {
  if (loadingRooms.value || (append && !roomCursor.value)) return
  const token = revision
  loadingRooms.value = true
  try {
    const page = await request<Page<Room>>(queryPath(props.base + '/simulation-chats', {
      limit: '50', cursor: append ? roomCursor.value : null,
    }))
    if (!active || !isIm.value) return
    if (append) {
      const known = new Set(rooms.value.map(({ id }) => id))
      rooms.value = [...rooms.value, ...page.items.filter(({ id }) => !known.has(id))]
    } else rooms.value = page.items
    roomCursor.value = page.nextCursor
    if (selectLatest && !room.value && token === revision && rooms.value[0]) await selectRoom(rooms.value[0].id)
  } catch (cause) {
    if (active && isIm.value) handle(cause, '无法读取会话列表，请刷新后重试。')
  } finally {
    if (active) loadingRooms.value = false
  }
}

watch([() => props.accounts, () => props.requestedAccount], ([options, requested]) => {
  if (requested && options.some(({ value }) => value === requested)) account.value = requested
  else if (!options.some(({ value }) => value === account.value)) account.value = options[0]?.value ?? ''
}, { immediate: true })
watch(isIm, (enabled) => {
  error.value = ''
  if (enabled) {
    void loadRooms(false, !props.requestedChat)
    if (room.value && (!props.requestedChat || props.requestedChat === room.value)) void fetchRoom(room.value)
  } else {
    revision++
    clearTimeout(timer)
    loading.value = false
    emit('browse', false)
  }
}, { immediate: true })
watch([isIm, () => props.requestedChat], ([enabled, chatId]) => {
  if (enabled && chatId && chatId !== room.value) void selectRoom(chatId)
}, { immediate: true })
watch(() => props.focusComposer, value => { if (value) void nextTick(() => composer.value?.focus()) }, { immediate: true })

function refresh() {
  error.value = ''
  void loadRooms()
  if (room.value) void fetchRoom(room.value)
}

function editTerm(term: Term) {
  editedTerm.value = term
  editedMeaning.value = term.meaning ?? ''
  editedTone.value = term.tone
  glossaryError.value = ''
}

async function saveTerm(operation: 'CORRECT' | 'DISABLE') {
  const term = editedTerm.value
  if (!term || savingTerm.value || (operation === 'CORRECT' && !editedMeaning.value.trim())) return
  const token = revision
  const id = room.value
  savingTerm.value = true
  glossaryError.value = ''
  try {
    await request(`${props.base}/simulation-chats/${id}/terms/${term.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': `"${term.version}"` },
      body: JSON.stringify(operation === 'CORRECT' ? { operation, meaning: editedMeaning.value.trim(), tone: editedTone.value } : { operation }),
    })
    if (active && token === revision) {
      editedTerm.value = undefined
      await fetchRoom(id, token)
    }
  } catch (cause) {
    if (!active || token !== revision) return
    if (cause instanceof RequestError && cause.status === 401) emit('expired')
    else glossaryError.value = cause instanceof RequestError && cause.status === 412
      ? '词条已变化。刷新会话后重新打开该词条。' : '无法保存词条，请核对释义后重试。'
  } finally {
    savingTerm.value = false
  }
}

async function send() {
  if (!props.canStart || sending.value || (isIm.value && (loading.value || !author.value)) || !message.value.trim()
    || !activeAccount.value) return
  const id = isIm.value ? room.value || (draftRoom ||= crypto.randomUUID()) : undefined
  const body = JSON.stringify({ accountId: account.value, message: message.value.trim(), ...(id && { chatId: id, speaker: author.value }) })
  if (pending?.body !== body) pending = { body, key: crypto.randomUUID() }
  const token = revision
  sending.value = true
  loadGeneration += 1
  error.value = ''
  clearTimeout(timer)
  try {
    const result = await request<{ id: string }>(props.base + '/runs', { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key } })
    if (!active || revision !== token) return
    message.value = ''
    pending = undefined
    if (!id) {
      emit('open', result.id)
      emit('sent')
      return
    }
    speaker.value = author.value
    newSpeaker.value = ''
    addingSpeaker.value = false
    if (!room.value) {
      room.value = id
      rooms.value = [{ id, createdAt: new Date().toISOString() }, ...rooms.value]
    }
    emit('latest', result.id)
    emit('browse', true)
    emit('open')
    emit('sent')
    await fetchRoom(id, token)
    void nextTick(() => composer.value?.focus())
  } catch (cause) {
    if (active && revision === token) {
      handle(cause, '发送模拟消息失败，请重试。')
      if (id && room.value) timer = setTimeout(() => { void fetchRoom(room.value, token, true) }, 2500)
    }
  } finally {
    sending.value = false
  }
}

onBeforeUnmount(() => { active = false; clearTimeout(timer) })
</script>

<template>
  <section class="console-card simulation-chat" aria-labelledby="simulation-chat-heading">
    <div class="console-section-heading">
      <h3 id="simulation-chat-heading" tabindex="-1">{{ isIm ? '模拟群聊' : activeAccount ? '模拟发帖／评论' : '发起模拟' }}</h3>
      <UiButton v-if="isIm" size="small" variant="quiet" :disabled="loadingRooms || loading || sending" @click="refresh">刷新会话</UiButton>
    </div>
    <div class="chat-controls">
      <UiField label="接收账号" for="chat-account">
        <select id="chat-account" v-model="account" class="ui-control" :disabled="sending || !accounts.length">
          <option v-if="!accounts.length" value="">暂无可用账号</option>
          <option v-for="choice in accounts" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
        </select>
      </UiField>
      <UiField v-if="isIm" label="会话" for="chat-room">
        <select id="chat-room" :value="room" class="ui-control" :disabled="loading || loadingRooms || sending"
          @change="selectRoom(($event.target as HTMLSelectElement).value, true)">
          <option value="">新群聊</option>
          <option v-if="room && !rooms.some(({ id }) => id === room)" :value="room">当前群聊</option>
          <option v-for="item in rooms" :key="item.id" :value="item.id">群聊 · {{ formatTime(item.createdAt) }}</option>
        </select>
      </UiField>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiEmpty v-if="!activeAccount" description="启用并关联模拟账号后即可发起模拟。">
      <UiButton v-if="canStart" size="small" variant="soft" @click="emit('identities')">前往角色与身份</UiButton>
    </UiEmpty>
    <template v-if="isIm">
    <UiButton v-if="roomCursor" class="chat-more" size="small" variant="quiet" :loading="loadingRooms"
      :disabled="sending" @click="loadRooms(true)">加载更早会话</UiButton>
    <div ref="transcript" class="chat-transcript" tabindex="0" role="region" aria-label="群聊消息">
      <UiSpinner v-if="loading && !chat" aria-label="正在读取群聊" />
      <div v-else-if="!bubbles.length" class="chat-empty">
        <UiEmpty description="发送第一条消息，开始模拟群聊。" />
      </div>
      <ol v-else class="chat-messages">
        <li v-for="item in bubbles" :key="item.key" class="chat-message" :class="{ 'chat-message--reply': item.isReply }">
          <span class="chat-meta">{{ item.sender }} · {{ formatTime(item.at) }}</span>
          <button type="button" class="chat-bubble" :class="{ 'chat-bubble--selected': item.run === selected }"
            :aria-current="item.run === selected ? 'true' : undefined" @click="emit('open', item.run)">
            {{ item.text ?? '正文已过期或不可用' }}
          </button>
          <span v-if="item.state" class="chat-meta">{{ stateName(item.state) }}</span>
        </li>
      </ol>
    </div>
    <details v-if="chat" class="chat-glossary">
      <summary>本群黑话词库 · {{ chat.glossary.length }} 条</summary>
      <p v-if="!chat.glossary.length">暂无词条。托管模型可从多位群员的重复用法中学习。</p>
      <UiAlert v-if="glossaryError" tone="error" role="alert">{{ glossaryError }}</UiAlert>
      <ul v-if="chat.glossary.length" class="glossary-list">
        <li v-for="term in chat.glossary" :key="term.id">
          <strong>{{ term.term }}</strong> · {{ tones[term.tone] }} · {{ termStates[term.status] }}
          <p v-if="term.meaning">{{ term.meaning }}</p>
          <div v-if="term.sourceRuns.length || canStart" class="console-actions">
            <UiButton v-for="(id, index) in term.sourceRuns" :key="id" size="small" variant="quiet"
              @click="emit('open', id)">用例 {{ index + 1 }}</UiButton>
            <UiButton v-if="canStart" size="small" variant="quiet" :disabled="savingTerm" @click="editTerm(term)">管理词条</UiButton>
          </div>
          <form v-if="editedTerm?.id === term.id" class="chat-term-form" @submit.prevent="saveTerm('CORRECT')">
            <UiField label="释义" for="chat-term-meaning">
              <input id="chat-term-meaning" v-model="editedMeaning" class="ui-control" maxlength="120" :disabled="savingTerm" />
            </UiField>
            <UiField label="语气" for="chat-term-tone">
              <select id="chat-term-tone" v-model="editedTone" class="ui-control" :disabled="savingTerm">
                <option v-for="(label, tone) in tones" :key="tone" :value="tone">{{ label }}</option>
              </select>
            </UiField>
            <div class="console-actions">
              <UiButton type="submit" size="small" tone="primary" :disabled="savingTerm || !editedMeaning.trim() || !term.sourceRuns.length">保存释义</UiButton>
              <UiButton type="button" size="small" variant="quiet" :disabled="savingTerm || term.status === 'DISABLED'" @click="saveTerm('DISABLE')">停用词条</UiButton>
              <UiButton type="button" size="small" variant="quiet" :disabled="savingTerm" @click="editedTerm = undefined">取消</UiButton>
            </div>
          </form>
        </li>
      </ul>
    </details>
    </template>
    <form v-if="canStart && activeAccount" class="chat-composer" @submit.prevent="send">
      <UiField v-if="isIm" :label="addingSpeaker ? '新群员昵称' : '发言群员'" :for="addingSpeaker ? 'chat-new-speaker' : 'chat-speaker'">
        <div class="chat-controls chat-speaker-controls">
          <select v-if="!addingSpeaker" id="chat-speaker" v-model="speaker" class="ui-control" :disabled="sending || loading">
            <option v-for="name in chat?.speakers" :key="name">{{ name }}</option>
          </select>
          <input v-else id="chat-new-speaker" v-model="newSpeaker" class="ui-control" maxlength="40"
            placeholder="例如：小林" :disabled="sending || loading" />
          <UiButton v-if="chat?.speakers.length" size="small" variant="soft" :disabled="sending || loading"
            @click="addingSpeaker = !addingSpeaker">{{ addingSpeaker ? '选择已有群员' : '新建群员' }}</UiButton>
        </div>
      </UiField>
      <UiField :label="isIm ? '消息' : '帖子或评论内容'" for="chat-message">
        <textarea id="chat-message" ref="composer" v-model="message" class="ui-control" rows="2" maxlength="4000"
          :placeholder="isIm ? '输入这位群员要说的话' : '输入角色要回应的帖子或评论'" :disabled="sending" @keydown.ctrl.enter.prevent="send" />
      </UiField>
      <UiButton class="chat-send" type="submit" tone="primary" :loading="sending"
        :disabled="sending || (isIm && (loading || !author)) || !message.trim()">{{ isIm ? '发送模拟消息' : '发起模拟' }}</UiButton>
    </form>
  </section>
</template>

<style scoped>
.simulation-chat { display: grid; gap: .75rem; min-width: 0; }
.chat-glossary { min-width: 0; overflow-wrap: anywhere; }
.chat-glossary summary { cursor: pointer; }
.glossary-list { list-style: none; padding: 0; display: grid; gap: .75rem; }
.glossary-list p { margin: .25rem 0; }
.chat-term-form { display: grid; gap: .5rem; padding-block: .5rem; }
.chat-controls { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .5rem .75rem; align-items: end; }
.chat-controls select { width: 100%; padding-inline: .5rem; text-overflow: ellipsis; }
.chat-speaker-controls { align-items: center; }
.chat-speaker-controls :deep(.ui-button) { justify-self: start; }
.chat-transcript { block-size: clamp(16rem, 45vh, 33rem); overflow: auto; border-radius: .5rem; border: 1px solid var(--console-line); background: var(--console-hover); }
.chat-empty { display: grid; place-content: center; justify-items: center; gap: .5rem; min-height: 100%; padding: 1rem; }
.chat-messages { list-style: none; margin: 0; padding: .875rem; display: grid; gap: .875rem; }
.chat-message { display: grid; justify-items: end; gap: .25rem; }
.chat-message--reply { justify-items: start; }
.chat-meta { color: var(--console-muted); font-size: .75rem; overflow-wrap: anywhere; }
.chat-bubble { max-width: min(92%, 34rem); text-align: start; white-space: pre-wrap; overflow-wrap: anywhere;
  padding: .625rem .75rem; border: 1px solid var(--console-line); border-radius: .75rem .25rem .75rem .75rem;
  color: inherit; background: color-mix(in srgb, var(--console-primary) 13%, var(--console-surface)); font: inherit; cursor: pointer; }
.chat-message--reply .chat-bubble { background: var(--console-surface); border-radius: .25rem .75rem .75rem .75rem; }
.chat-bubble--selected { border-color: var(--console-primary); }
.chat-composer { display: grid; gap: .625rem; }
.chat-send { justify-self: end; }
.chat-more { justify-self: end; }
@media (max-width: 30rem) {
  .chat-controls { grid-template-columns: minmax(0,1fr); }
}
</style>
