<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NModal, NSpin, NTag } from 'naive-ui'
import { queryPath, useConsoleTask } from '@rica/console-shared/console-data'
import { request, RequestError } from '@rica/console-shared/request'
import { localUserCreate, localUserPassword, type LocalUser } from '../../../../../packages/contracts/local-users.js'

const emit = defineEmits<{ expired: []; close: [] }>()
const { busy, error, notice, active, run } = useConsoleTask(() => emit('expired'))
const rows = ref<LocalUser[]>([])
const cursor = ref<string | null>(null)
const action = ref<'create' | 'reset'>()
const username = ref('')
const password = ref('')
const currentPassword = ref('')
const editorHeading = ref<HTMLElement>()
const listHeading = ref<HTMLElement>()
let editorTrigger: HTMLElement | undefined
const path = '/v1/auth/users'
const valid = computed(() => action.value === 'create'
  ? localUserCreate.safeParse({ username: username.value, password: password.value, currentPassword: currentPassword.value }).success
  : localUserPassword.safeParse({ password: password.value, currentPassword: currentPassword.value }).success)

async function load(append = false) {
  const page = await request<{ items: LocalUser[]; nextCursor: string | null }>(
    queryPath(path, { after: append ? cursor.value : null }),
  )
  if (!active()) return
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

function edit(kind: 'create' | 'reset', name = '') {
  editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  action.value = kind
  username.value = name
  error.value = ''
  notice.value = ''
  void nextTick(() => editorHeading.value?.focus())
}

function clearEditor() {
  action.value = undefined
  username.value = ''
  password.value = ''
  currentPassword.value = ''
  void nextTick(() => {
    const target = editorTrigger?.isConnected && !editorTrigger.matches(':disabled') ? editorTrigger : listHeading.value
    target?.focus()
  })
}

function save() {
  const kind = action.value
  if (!valid.value || !kind) return
  const input = { password: password.value, currentPassword: currentPassword.value }
  const name = username.value.trim().toLowerCase()
  void run(async () => {
    try {
      await request(kind === 'create' ? path : path + '/' + encodeURIComponent(name) + '/password', {
        method: kind === 'create' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'create' ? { ...input, username: name } : input),
      })
    } catch (cause) {
      if (!active()) return
      currentPassword.value = ''
      const message = cause instanceof RequestError && ({
        INVALID_CREDENTIALS: '当前密码不正确，请重新输入。',
        RATE_LIMITED: '验证次数已达上限，请稍后再试。',
        ACCOUNT_EXISTS: '此用户名已存在。',
        ACCOUNT_PROTECTED: '部署管理员账号请通过命令行重置。',
        ACCOUNT_NOT_FOUND: '找不到此账号，请刷新账号列表。',
      } as Record<string, string>)[cause.code ?? '']
      if (!message) throw cause
      error.value = message
      return
    }
    if (!active()) return
    clearEditor()
    notice.value = kind === 'create' ? '已创建 ' + name + '。可在角色管理员列表中添加该账号。' : '已重置 ' + name + ' 的密码。'
    if (kind === 'create') await load()
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <NModal :show="true" preset="card" title="本地登录账号" aria-label="本地登录账号"
    :style="{ width: 'min(36rem, calc(100vw - 2rem))', maxHeight: 'calc(100dvh - 2rem)', overflow: 'auto' }"
    :mask-closable="false" :close-on-esc="!busy" :closable="!busy"
    @update:show="show => { if (!show) emit('close') }">
    <div class="console-stack">
      <NAlert v-if="error" role="alert" type="error">{{ error }}</NAlert>
      <NAlert v-if="notice" role="status" type="success">{{ notice }}</NAlert>
      <NForm v-if="action" @submit.prevent="save" aria-labelledby="local-user-editor-heading">
        <h3 id="local-user-editor-heading" ref="editorHeading" tabindex="-1">
          {{ action === 'create' ? '创建本地账号' : '重置 ' + username + ' 的密码' }}
        </h3>
        <p v-if="action === 'reset'">重置后，此账号的所有会话和已登记的通行密钥都会失效。</p>
        <NFormItem v-if="action === 'create'" label="用户名" :label-props="{ for: 'local-user-name' }">
          <NInput v-model:value="username" maxlength="64" :disabled="busy" placeholder="3–64 个字母、数字及 . _ -"
            :input-props="{ id: 'local-user-name', autocomplete: 'off' }" />
        </NFormItem>
        <NFormItem label="新密码" :label-props="{ for: 'local-user-new-password' }">
          <NInput v-model:value="password" type="password" maxlength="128" :disabled="busy" placeholder="12–128 个字符"
            :input-props="{ id: 'local-user-new-password', autocomplete: 'new-password' }" />
        </NFormItem>
        <NFormItem label="你的当前密码" :label-props="{ for: 'local-user-current-password' }">
          <NInput v-model:value="currentPassword" type="password" maxlength="128" :disabled="busy"
            :input-props="{ id: 'local-user-current-password', autocomplete: 'current-password' }" />
        </NFormItem>
        <div class="console-actions">
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !valid">
            {{ action === 'create' ? '创建账号' : '确认重置' }}
          </NButton>
          <NButton :disabled="busy" @click="clearEditor">取消</NButton>
        </div>
      </NForm>
      <template v-else>
        <div class="console-section-heading">
          <h3 ref="listHeading" tabindex="-1">账号列表</h3>
          <div class="console-actions">
            <NButton size="small" quaternary :disabled="busy" @click="run(() => load())">刷新账号</NButton>
            <NButton size="small" type="primary" :disabled="busy" @click="edit('create')">创建本地账号</NButton>
          </div>
        </div>
        <NSpin v-if="busy && !rows.length" aria-label="正在读取账号" />
        <NEmpty v-else-if="!rows.length && !error" description="暂无本地账号。" />
        <ul v-if="rows.length" class="console-record-list">
          <li v-for="row in rows" :key="row.username">
            <div class="console-actions">
              <strong>{{ row.username }}</strong>
              <NTag v-if="row.canCreate" size="small">部署管理员</NTag>
              <NButton v-else size="small" quaternary :aria-label="'重置 ' + row.username + ' 的密码'" :disabled="busy"
                @click="edit('reset', row.username)">重置密码</NButton>
            </div>
          </li>
        </ul>
        <NButton v-if="cursor" size="small" :disabled="busy" @click="run(() => load(true))">加载更多</NButton>
      </template>
    </div>
  </NModal>
</template>
