<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { UiAlert, UiButton, UiDialog, UiEmpty, UiField, UiSpinner } from '@rica/console-shared/ui'
import { formatTime, useConsoleTask } from '@rica/console-shared/console-data'
import { request, RequestError } from '@rica/console-shared/request'

type Passkey = { id: string; createdAt: string | null }
const emit = defineEmits<{ close: []; expired: [] }>()
const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = '/v1/auth/passkeys'
const keys = ref<Passkey[]>()
const selected = ref<Passkey>()
const password = ref('')
const passwordInput = ref<HTMLInputElement>()
const heading = ref<HTMLElement>()
let trigger: HTMLElement | undefined

const identifier = (key: Passkey) => key.id.length > 12 ? '…' + key.id.slice(-12) : key.id

async function load() {
  const { items } = await request<{ items: Passkey[] }>(path)
  if (active()) keys.value = items
}

function select(key: Passkey, event: MouseEvent) {
  trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  selected.value = key
  password.value = ''
  error.value = ''
  notice.value = ''
  void nextTick(() => passwordInput.value?.focus())
}

function back(removed = false) {
  selected.value = undefined
  password.value = ''
  error.value = ''
  void nextTick(() => (removed || !trigger?.isConnected ? heading.value : trigger)?.focus())
}

function remove() {
  const key = selected.value
  if (!key || !password.value) return
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
      if (cause.code === 'INVALID_CREDENTIALS' || cause.status === 429) {
        error.value = cause.status === 429 ? '尝试次数过多，请稍后再试。' : '当前密码不正确，请重新输入。'
        return
      }
      throw cause
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
  <UiDialog :open="true" title="管理通行密钥" :busy="busy" @update:open="open => { if (!open) emit('close') }">
    <section class="console-stack" aria-labelledby="passkey-list-heading">
      <UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
      <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
      <form v-if="selected" class="console-stack" @submit.prevent="remove">
        <p>移除通行密钥 <strong>{{ identifier(selected) }}</strong> 后，这把密钥将无法登录 Rica。</p>
        <UiField label="当前密码" for="passkey-remove-password">
          <input id="passkey-remove-password" ref="passwordInput" v-model="password" class="ui-control"
            type="password" autocomplete="current-password" required :disabled="busy" />
        </UiField>
        <div class="console-actions passkey-actions">
          <UiButton variant="quiet" :disabled="busy" @click="back()">返回列表</UiButton>
          <UiButton type="submit" tone="error" :disabled="!password" :loading="busy">确认移除</UiButton>
        </div>
      </form>
      <template v-else>
        <div class="console-section-heading">
          <h3 id="passkey-list-heading" ref="heading" tabindex="-1">已登记的通行密钥</h3>
          <UiButton variant="quiet" size="small" :disabled="busy" @click="run(load)">刷新列表</UiButton>
        </div>
        <UiSpinner v-if="busy && !keys" />
        <UiEmpty v-else-if="keys && !keys.length" description="尚未登记通行密钥。" />
        <ul v-else-if="keys?.length" class="console-group-list">
          <li v-for="key in keys" :key="key.id" class="console-group-row">
            <div class="passkey-record">
              <strong>{{ identifier(key) }}</strong>
              <span class="console-group-meta">{{ key.createdAt ? '登记于 ' + formatTime(key.createdAt) : '登记时间未知' }}</span>
            </div>
            <UiButton size="small" variant="quiet" tone="error" :disabled="busy"
              :aria-label="'移除通行密钥 ' + identifier(key)" @click="select(key, $event)">移除</UiButton>
          </li>
        </ul>
      </template>
    </section>
  </UiDialog>
</template>

<style scoped>
.passkey-record { display: grid; gap: .25rem; overflow-wrap: anywhere; }
.passkey-actions { justify-content: flex-end; }
form p { margin: 0; }
</style>
