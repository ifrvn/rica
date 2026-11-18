<script setup lang="ts">
import { computed, ref } from 'vue'
import { UiAlert, UiButton, UiDialog, UiField } from '@ricajs/console-shared/ui'
import { localUserCreate } from '@ricajs/contracts/local-users'
import { useConsoleTask } from '@ricajs/console-shared/console-data'
import { request, RequestError } from '@ricajs/console-shared/request'

const emit = defineEmits<{ close: []; expired: []; created: [username: string] }>()
const { busy, error, run } = useConsoleTask(() => emit('expired'))
const username = ref('')
const password = ref('')
const currentPassword = ref('')
const input = computed(() => localUserCreate.safeParse({
  username: username.value, password: password.value, currentPassword: currentPassword.value,
}))

function save() {
  const result = input.value
  if (busy.value || !result.success) return
  currentPassword.value = ''
  void run(async () => {
    const created = await request<{ username: string }>('/v1/auth/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result.data),
    }).catch((cause: unknown) => {
      const message = cause instanceof RequestError && ({
        INVALID_CREDENTIALS: '当前密码不正确，请重新输入。',
        RATE_LIMITED: '验证次数已达上限，请稍后再试。',
        ACCOUNT_EXISTS: '此用户名已存在，请换一个用户名。',
      } as Record<string, string>)[cause.code ?? '']
      if (!message) throw cause
      error.value = message
    })
    if (created) emit('created', created.username)
  })
}
</script>

<template>
  <UiDialog :open="true" title="新建账号" :busy="busy" @update:open="open => { if (!open) emit('close') }">
    <form class="console-stack" @submit.prevent="save">
      <UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
      <UiField label="用户名" for="new-account-name" feedback="3–64 个字母、数字及 . _ -">
        <input id="new-account-name" v-model="username" class="ui-control" autocomplete="off" required maxlength="64" :disabled="busy" />
      </UiField>
      <UiField label="初始密码" for="new-account-password" feedback="12–128 个字符">
        <input id="new-account-password" v-model="password" class="ui-control" type="password" autocomplete="new-password"
          required minlength="12" maxlength="128" :disabled="busy" />
      </UiField>
      <UiField label="你的当前密码" for="new-account-current-password">
        <input id="new-account-current-password" v-model="currentPassword" class="ui-control" type="password"
          autocomplete="current-password" required maxlength="128" :disabled="busy" />
      </UiField>
      <UiAlert tone="info">新账号将获得系统管理员权限。</UiAlert>
      <div class="console-actions create-actions">
        <UiButton variant="quiet" :disabled="busy" @click="emit('close')">取消</UiButton>
        <UiButton type="submit" tone="primary" :loading="busy" :disabled="!input.success">创建账号</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.create-actions { justify-content: flex-end; }
</style>
