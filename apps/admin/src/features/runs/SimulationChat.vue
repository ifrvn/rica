<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { formatTime } from '@ricajs/console-shared/console-data'
import { request, RequestError } from '@ricajs/console-shared/request'
import type { z } from '@hono/zod-openapi'
import type { simulationChatSummary, simulationChatView } from '@ricajs/simulation/contracts/observability'

type Chat = z.infer<typeof simulationChatView>
type Room = z.infer<typeof simulationChatSummary>
const props = defineProps<{
  base: string; accounts: { value: string; label: string }[]; canStart: boolean
  selected?: string; requestedChat?: string | null; requestedAccount?: string; focusComposer: boolean
  identity: (accountId: string) => string; stateName: (state: string) => string
}>()
const emit = defineEmits<{ expired: []; open: [id?: string]; latest: [id?: string]; browse: []; sent: []; identities: [] }>()
const account = ref('')
const room = ref('')
const rooms = ref<Room[]>([])
const chat = ref<Chat>()
const speaker = ref('')
const newSpeaker = ref('')
const addingSpeaker = ref(true)
const message = ref('')
const sending = ref(false)
const loading = ref(false)
const error = ref('')
const transcript = ref<HTMLElement>()
const composer = ref<HTMLTextAreaElement>()
const author = computed(() => (addingSpeaker.value ? newSpeaker.value : speaker.value).trim())
const activeAccount = computed(() => props.accounts.some(({ value }) => value === account.value))
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
  return turn.repliedAt ? [inbound, { key: turn.id + '-reply', run: turn.id, text: turn.reply, at: turn.repliedAt,
    sender: props.identity(chat.value!.accountId), state: '', isReply: true }] : [inbound]
}).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)))

function scrollToEnd() {
  void nextTick(() => {
    if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
  })
}

function handle(cause: unknown, fallback: string) {
  const status = cause instanceof RequestError ? cause.status : 0
  if (status === 401) emit('expired')
  else error.value = ({
    403: '当前账号无权访问此模拟会话。', 404: '找不到此模拟会话。',
    409: '模拟账号或群员当前不可用，请核对角色和账号状态。', 422: '请核对群员昵称和消息内容。',
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
  emit('latest', undefined)
  if (user) {
    emit('browse')
    emit('open')
  }
  if (id) await fetchRoom(id, token)
}

async function selectAccount(id: string, preferred = '', user = false) {
  account.value = id
  rooms.value = []
  await selectRoom('', user)
  if (!id) return
  const token = revision
  loading.value = true
  try {
    const page = await request<{ items: Room[] }>(props.base + '/simulation-chats?accountId=' + encodeURIComponent(id))
    if (!active || revision !== token) return
    rooms.value = page.items
    await selectRoom(preferred || page.items[0]?.id || '')
  } catch (cause) {
    if (active && revision === token) handle(cause, '无法读取群聊，请刷新后重试。')
  } finally {
    if (revision === token) loading.value = false
  }
}

watch(() => [props.requestedAccount, props.requestedChat, props.accounts] as const, ([targetAccount, targetChat, options]) => {
  if (targetChat && targetAccount) {
    if (account.value !== targetAccount) void selectAccount(targetAccount, targetChat)
    else if (room.value !== targetChat) void selectRoom(targetChat)
  } else if (!account.value && options.length) void selectAccount(options[0].value)
}, { immediate: true })
watch(() => props.focusComposer, value => { if (value) void nextTick(() => composer.value?.focus()) }, { immediate: true })

function refresh() {
  if (room.value) void fetchRoom(room.value)
  else void selectAccount(account.value)
}

async function send() {
  if (!props.canStart || sending.value || loading.value || !author.value || !message.value.trim()
    || !activeAccount.value) return
  const id = room.value || (draftRoom ||= crypto.randomUUID())
  const body = JSON.stringify({ accountId: account.value, chatId: id, speaker: author.value, message: message.value.trim() })
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
    speaker.value = author.value
    newSpeaker.value = ''
    addingSpeaker.value = false
    if (!room.value) {
      room.value = id
      rooms.value = [{ id, createdAt: new Date().toISOString() }, ...rooms.value]
    }
    emit('latest', result.id)
    emit('browse')
    emit('open')
    emit('sent')
    await fetchRoom(id, token)
    void nextTick(() => composer.value?.focus())
  } catch (cause) {
    if (active && revision === token) {
      handle(cause, '发送模拟消息失败，请重试。')
      if (room.value) timer = setTimeout(() => { void fetchRoom(room.value, token, true) }, 2500)
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
      <h3 id="simulation-chat-heading" tabindex="-1">模拟群聊</h3>
      <UiButton size="small" variant="quiet" :disabled="!account || loading || sending" @click="refresh">刷新会话</UiButton>
    </div>
    <div class="chat-controls" v-if="accounts.length">
      <UiField label="接收账号" for="chat-account">
        <select id="chat-account" :value="account" class="ui-control" :disabled="sending"
          @change="selectAccount(($event.target as HTMLSelectElement).value, '', true)">
          <option v-if="account && !activeAccount" :value="account" disabled>已停用的模拟账号</option>
          <option v-for="choice in accounts" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
        </select>
      </UiField>
      <UiField label="会话" for="chat-room">
        <select id="chat-room" :value="room" class="ui-control" :disabled="loading || sending"
          @change="selectRoom(($event.target as HTMLSelectElement).value, true)">
          <option value="">新群聊</option>
          <option v-for="item in rooms" :key="item.id" :value="item.id">群聊 · {{ formatTime(item.createdAt) }}</option>
        </select>
      </UiField>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <div ref="transcript" class="chat-transcript" tabindex="0" role="region" aria-label="群聊消息">
      <UiSpinner v-if="loading && !chat" aria-label="正在读取群聊" />
      <div v-else-if="!bubbles.length" class="chat-empty">
        <UiEmpty :description="accounts.length ? '发送第一条消息，开始模拟群聊。' : '启用并关联模拟账号后即可发起群聊。'" />
        <UiButton v-if="!accounts.length && canStart" size="small" variant="soft" @click="emit('identities')">前往角色与身份</UiButton>
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
    <form v-if="canStart && activeAccount" class="chat-composer" @submit.prevent="send">
      <div class="chat-controls">
        <UiField v-if="!addingSpeaker" label="发言群员" for="chat-speaker">
          <select id="chat-speaker" v-model="speaker" class="ui-control" :disabled="sending || loading">
            <option v-for="name in chat?.speakers" :key="name">{{ name }}</option>
          </select>
        </UiField>
        <UiField v-else label="新群员昵称" for="chat-new-speaker">
          <input id="chat-new-speaker" v-model="newSpeaker" class="ui-control" maxlength="40" placeholder="例如：小林" :disabled="sending || loading" />
        </UiField>
        <UiButton v-if="chat?.speakers.length" size="small" variant="soft" :disabled="sending || loading"
          @click="addingSpeaker = !addingSpeaker">{{ addingSpeaker ? '选择已有群员' : '新建群员' }}</UiButton>
      </div>
      <UiField label="消息" for="chat-message">
        <textarea id="chat-message" ref="composer" v-model="message" class="ui-control" rows="2" maxlength="4000"
          placeholder="输入这位群员要说的话" :disabled="sending" @keydown.ctrl.enter.prevent="send" />
      </UiField>
      <UiButton class="chat-send" type="submit" tone="primary" :loading="sending"
        :disabled="sending || loading || !author || !message.trim()">发送模拟消息</UiButton>
    </form>
  </section>
</template>

<style scoped>
.simulation-chat { display: grid; gap: .75rem; min-width: 0; }
.chat-controls { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .5rem .75rem; align-items: end; }
.chat-controls select { width: 100%; padding-inline: .5rem; text-overflow: ellipsis; }
.chat-controls :deep(.ui-button) { justify-self: start; }
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
@media (max-width: 30rem) {
  .chat-controls { grid-template-columns: minmax(0,1fr); }
}
</style>
