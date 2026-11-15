<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { startRegistration } from '@simplewebauthn/browser'
import { UiAlert, UiButton, UiDialog, UiEmpty, UiField, UiSpinner } from '@rica/console-shared/ui'
import { formatTime, useConsoleTask } from '@rica/console-shared/console-data'
import { request, RequestError } from '@rica/console-shared/request'

type Passkey = { id: string; createdAt: string | null }
type RegistrationOptions = { challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }
type Action = 'password' | 'add' | 'remove'
defineProps<{ passkeysAvailable: boolean }>()
const emit = defineEmits<{ close: []; expired: []; passwordChanged: [] }>()
const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = '/v1/auth/passkeys'
const keys = ref<Passkey[]>()
const action = ref<Action>()
const selected = ref<Passkey>()
const password = ref('')
const newPassword = ref('')
const confirmation = ref('')
const passwordInput = ref<HTMLInputElement>()
const heading = ref<HTMLElement>()
let trigger: HTMLElement | undefined

const identifier = (key: Passkey) => key.id.length > 12 ? '…' + key.id.slice(-12) : key.id

async function load() {
  const { items } = await request<{ items: Passkey[] }>(path)
  if (active()) keys.value = items
}

function open(nextAction: Action, event: MouseEvent, key?: Passkey) {
  trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  action.value = nextAction
  selected.value = key
  clearPasswords()
  error.value = ''
  notice.value = ''
  void nextTick(() => passwordInput.value?.focus())
}

function clearPasswords() {
  password.value = ''
  newPassword.value = ''
  confirmation.value = ''
}

function back(removed = false) {
  action.value = undefined
  selected.value = undefined
  clearPasswords()
  error.value = ''
  void nextTick(() => (removed || !trigger?.isConnected ? heading.value : trigger)?.focus())
}

function submit() {
  if (action.value === 'remove') {
    remove()
    return
  }
  const currentAction = action.value
  const currentPassword = password.value
  if (busy.value || !currentPassword) return
  if (currentAction === 'password' && (!newPassword.value || newPassword.value !== confirmation.value)) return
  password.value = ''
  const headers = { 'Content-Type': 'application/json' }
  void run(async () => {
    try {
      if (currentAction === 'password') {
        await request('/v1/auth/password', {
          method: 'PUT', headers, body: JSON.stringify({ currentPassword, password: newPassword.value }),
        })
        if (active()) {
          clearPasswords()
          emit('passwordChanged')
        }
      } else if (currentAction === 'add') {
        const { options, challengeId } = await request<RegistrationOptions>(path + '/register/options', {
          method: 'POST', headers, body: JSON.stringify({ password: currentPassword }),
        })
        if (!active()) return
        const response = await startRegistration({ optionsJSON: options }).catch(() => undefined)
        if (!active()) return
        if (!response) {
          error.value = '未完成通行密钥登记，请输入当前密码后重试。'
          return
        }
        await request(path + '/register/verify', { method: 'POST', headers, body: JSON.stringify({ challengeId, response }) })
        if (!active()) return
        back()
        notice.value = '已添加通行密钥。'
        await load()
      }
    } catch (cause) {
      if (!showActionError(cause)) throw cause
    }
  }).finally(() => {
    if (active() && action.value === currentAction) void nextTick(() => passwordInput.value?.focus())
  })
}

function showActionError(cause: unknown) {
  if (!(cause instanceof RequestError) || !active()) return false
  if (cause.code === 'INVALID_CREDENTIALS') error.value = '当前密码不正确，请重新输入。'
  else if (cause.code === 'PASSWORD_UNCHANGED') error.value = '新密码需要与当前密码不同。'
  else if (cause.code === 'PASSKEY_LIMIT') error.value = '通行密钥已达上限，请移除一条后再添加。'
  else if (cause.code === 'INVALID_PASSKEY' || cause.code === 'PASSKEY_CONFLICT') {
    error.value = '登记未完成，请返回列表查看，或重新输入当前密码再试。'
  }
  else if (cause.status === 429) error.value = '尝试次数过多，请稍后再试。'
  else return false
  return true
}

function remove() {
  const key = selected.value
  if (busy.value || !key || !password.value) return
  const body = JSON.stringify({ password: password.value })
  password.value = ''
  void run(async () => {
    try {
      await request(path + '/' + encodeURIComponent(key.id), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body,
      })
    } catch (cause) {
      if (!(cause instanceof RequestError) || !active()) throw cause
      if (cause.code === 'PASSKEY_NOT_FOUND') {
        await load()
        if (!active()) return
        back(true)
        error.value = '此通行密钥已不在列表中。'
        return
      }
      if (!showActionError(cause)) throw cause
      return
    }
    if (!active()) return
    keys.value = keys.value?.filter(({ id }) => id !== key.id)
    back(true)
    notice.value = '已移除此通行密钥。'
  }).finally(() => {
    if (active() && selected.value?.id === key.id) void nextTick(() => passwordInput.value?.focus())
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <UiDialog :open="true" title="安全设置" :busy="busy" @update:open="open => { if (!open) emit('close') }">
    <div class="console-stack">
      <UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
      <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
      <form v-if="action" class="console-stack" @submit.prevent="submit">
        <p v-if="selected">移除通行密钥 <strong>{{ identifier(selected) }}</strong> 后，这把密钥将无法登录 Rica。</p>
        <p v-else-if="action === 'password'">修改密码后，所有已登录的会话都会退出。</p>
        <p v-else>验证当前密码后，按浏览器提示添加通行密钥。</p>
        <UiField label="当前密码" for="security-current-password">
          <input id="security-current-password" ref="passwordInput" v-model="password" class="ui-control"
            type="password" autocomplete="current-password" required :disabled="busy" />
        </UiField>
        <template v-if="action === 'password'">
          <UiField label="新密码" for="security-new-password" feedback="12–128 个字符">
            <input id="security-new-password" v-model="newPassword" class="ui-control" type="password"
              autocomplete="new-password" required minlength="12" maxlength="128" :disabled="busy" />
          </UiField>
          <UiField label="确认新密码" for="security-confirm-password"
            :feedback="confirmation && confirmation !== newPassword ? '两次输入的新密码不一致。' : undefined"
            :invalid="Boolean(confirmation && confirmation !== newPassword)">
            <input id="security-confirm-password" v-model="confirmation" class="ui-control" type="password"
              autocomplete="new-password" required :disabled="busy" />
          </UiField>
        </template>
        <div class="console-actions security-actions">
          <UiButton variant="quiet" :disabled="busy" @click="back()">返回</UiButton>
          <UiButton v-if="action === 'remove'" type="submit" tone="error" :disabled="!password" :loading="busy">确认移除</UiButton>
          <UiButton v-else-if="action === 'add'" type="submit" tone="primary" :disabled="!password" :loading="busy">继续添加</UiButton>
          <UiButton v-else type="submit" tone="primary" :disabled="!password || newPassword.length < 12 || newPassword !== confirmation"
            :loading="busy">保存新密码</UiButton>
        </div>
      </form>
      <template v-else>
        <section class="console-stack" aria-labelledby="security-password-heading">
          <div class="console-section-heading">
            <h3 id="security-password-heading">密码</h3>
            <UiButton size="small" :disabled="busy" @click="open('password', $event)">修改密码</UiButton>
          </div>
        </section>
        <section class="console-stack" aria-labelledby="passkey-list-heading">
          <div class="console-section-heading">
            <h3 id="passkey-list-heading" ref="heading" tabindex="-1">通行密钥</h3>
            <UiButton v-if="passkeysAvailable" size="small" :disabled="busy"
              @click="open('add', $event)">添加通行密钥</UiButton>
          </div>
          <p v-if="!passkeysAvailable">当前浏览器环境不支持添加通行密钥。</p>
          <UiButton v-if="error && !keys" variant="quiet" size="small" :disabled="busy" @click="run(load)">重试加载</UiButton>
          <UiSpinner v-if="busy && !keys" />
          <UiEmpty v-else-if="keys && !keys.length" description="尚未登记通行密钥。" />
          <ul v-else-if="keys?.length" class="console-group-list">
            <li v-for="key in keys" :key="key.id" class="console-group-row">
              <div class="passkey-record">
                <strong>{{ identifier(key) }}</strong>
                <span class="console-group-meta">{{ key.createdAt ? '登记于 ' + formatTime(key.createdAt) : '登记时间未知' }}</span>
              </div>
              <UiButton size="small" variant="quiet" tone="error" :disabled="busy"
                :aria-label="'移除通行密钥 ' + identifier(key)" @click="open('remove', $event, key)">移除</UiButton>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </UiDialog>
</template>

<style scoped>
.passkey-record { display: grid; gap: .25rem; overflow-wrap: anywhere; }
.security-actions { justify-content: flex-end; }
form p { margin: 0; }
</style>
