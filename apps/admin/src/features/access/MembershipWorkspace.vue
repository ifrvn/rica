<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NModal, NSpin } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import { membershipInput, type memberPage } from '../../../../../packages/contracts/management.js'
import { characterPath, queryPath, useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'

type Members = z.infer<typeof memberPage>
const props = defineProps<{ characterId: string; username: string; canManageUsers: boolean }>()
const emit = defineEmits<{ expired: []; permissions: []; manageUsers: [] }>()
const { busy, error, notice, active, run, command } = useConsoleTask(() => emit('expired'))
const path = characterPath(props.characterId) + '/memberships'
const rows = ref<Members['items']>([])
const cursor = ref<string | null>(null)
const subject = ref('')
const reason = ref('')
const action = ref<'GRANT' | 'REVOKE'>()
const memberHeading = ref<HTMLElement>()
const dialogTitle = computed(() => action.value === 'REVOKE' ? '移除管理员' : '添加管理员')
let trigger: HTMLElement | undefined
const payload = computed(() => membershipInput.safeParse({
  action: action.value, subject: subject.value.trim().toLowerCase(), reason: reason.value,
}))

async function load(append = false) {
  const page = await request<Members>(queryPath(path, { after: append ? cursor.value : null }))
  if (!active()) return
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

function edit(kind: 'GRANT' | 'REVOKE', name = '') {
  if (!action.value) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  action.value = kind
  subject.value = name
  reason.value = ''
  error.value = ''
  notice.value = ''
}

function closeEditor() {
  action.value = undefined
  error.value = ''
}

function restoreFocus() {
  void nextTick(() => (trigger?.isConnected && !trigger.matches(':disabled') ? trigger : memberHeading.value)?.focus())
}

function save() {
  const result = payload.value
  if (!result.success) return
  void run(async () => {
    await command(path, result.data)
    if (!active()) return
    closeEditor()
    notice.value = result.data.action === 'GRANT' ? '已添加管理员。' : '已移除管理员。'
    if (result.data.subject === props.username) emit('permissions')
    else await load()
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <section class="console-card console-stack" aria-labelledby="member-list-heading">
    <div class="console-section-heading">
      <h3 id="member-list-heading" ref="memberHeading" tabindex="-1">角色管理员</h3>
      <div class="console-actions">
        <NButton size="small" quaternary :disabled="busy" @click="run(() => load())">刷新列表</NButton>
        <NButton v-if="canManageUsers" size="small" quaternary :disabled="busy" @click="emit('manageUsers')">管理本地账号</NButton>
        <NButton size="small" type="primary" :disabled="busy || !!action" @click="edit('GRANT')">添加管理员</NButton>
      </div>
    </div>
    <NAlert v-if="error && !action" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NSpin v-if="busy && !rows.length && !action" />
    <NEmpty v-else-if="!rows.length && !error" description="暂无角色管理员。" />
    <ul v-if="rows.length" class="console-group-list">
      <li v-for="member in rows" :key="member.subject" class="console-group-row">
        <div class="console-actions">
          <strong>{{ member.subject }}</strong>
          <span v-if="member.subject === username" class="console-group-meta">当前账号</span>
        </div>
        <div class="console-actions">
          <NButton size="small" type="error" tertiary :disabled="busy || !!action"
            :aria-label="'移除管理员 ' + member.subject" @click="edit('REVOKE', member.subject)">移除</NButton>
        </div>
      </li>
    </ul>
    <div v-if="cursor">
      <NButton size="small" :disabled="busy" @click="run(() => load(true))">加载更多</NButton>
    </div>
  </section>

  <NModal :show="!!action" preset="card" :title="dialogTitle" :aria-label="dialogTitle"
    class="member-dialog" :mask-closable="false" :close-on-esc="!busy" :closable="!busy"
    @update:show="show => { if (!show) closeEditor() }" @after-leave="restoreFocus">
    <NForm @submit.prevent="save">
      <NAlert v-if="error" class="member-dialog-message" type="error" role="alert">{{ error }}</NAlert>
      <p v-if="action === 'REVOKE'" class="member-dialog-message">
        移除 <strong>{{ subject }}</strong> 后，该账号将失去此角色的访问权限。
      </p>
      <NFormItem v-else label="本地用户名" :label-props="{ for: 'member-subject' }">
        <NInput v-model:value="subject" placeholder="例如：alice" :disabled="busy" maxlength="64"
          :input-props="{ id: 'member-subject', autocomplete: 'off' }" />
      </NFormItem>
      <NFormItem label="变更理由" :label-props="{ for: 'member-reason' }">
        <NInput v-model:value="reason" placeholder="例如：调整角色分工" maxlength="240" :disabled="busy"
          :input-props="{ id: 'member-reason' }" />
      </NFormItem>
      <div class="console-actions member-dialog-actions">
        <NButton :disabled="busy" @click="closeEditor">取消</NButton>
        <NButton :type="action === 'REVOKE' ? 'error' : 'primary'" attr-type="submit"
          :loading="busy" :disabled="busy || !payload.success">{{ dialogTitle }}</NButton>
      </div>
    </NForm>
  </NModal>
</template>

<style scoped>
.member-dialog { width: min(32rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); overflow: auto; }
.member-dialog-message { margin: 0 0 1rem; overflow-wrap: anywhere; }
.member-dialog-actions { justify-content: flex-end; }
</style>
