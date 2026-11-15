<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSpin } from 'naive-ui'
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
const editorHeading = ref<HTMLElement>()
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
  void nextTick(() => editorHeading.value?.focus())
}

function closeEditor() {
  action.value = undefined
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
  <section class="console-workspace console-stack" aria-labelledby="member-list-heading">
    <div class="console-section-heading">
      <h3 id="member-list-heading" ref="memberHeading" tabindex="-1">角色管理员</h3>
      <div class="console-actions">
        <NButton size="small" quaternary :disabled="busy" @click="run(() => load())">刷新列表</NButton>
        <NButton v-if="canManageUsers" size="small" quaternary :disabled="busy" @click="emit('manageUsers')">管理本地账号</NButton>
        <NButton size="small" :disabled="busy || !!action" @click="edit('GRANT')">添加管理员</NButton>
      </div>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NForm v-if="action" class="console-panel" aria-labelledby="member-editor-heading" @submit.prevent="save">
      <h4 id="member-editor-heading" ref="editorHeading" tabindex="-1">{{ action === 'GRANT' ? '添加管理员' : '移除管理员' }}</h4>
      <p v-if="action === 'REVOKE'">移除后，该账号将失去此角色的访问权限。</p>
      <div class="console-form-grid">
        <NFormItem label="本地用户名" :label-props="{ for: 'member-subject' }">
          <NInput placeholder="例如：alice" v-model:value="subject" :disabled="busy || action === 'REVOKE'" maxlength="64" :input-props="{ id: 'member-subject' }" />
        </NFormItem>
        <NFormItem label="变更理由" :label-props="{ for: 'member-reason' }">
          <NInput placeholder="例如：负责管理该角色" v-model:value="reason" maxlength="240" :disabled="busy" :input-props="{ id: 'member-reason' }" />
        </NFormItem>
      </div>
      <div class="console-actions">
        <NButton :type="action === 'REVOKE' ? 'error' : 'primary'" attr-type="submit" :loading="busy" :disabled="busy || !payload.success">
          {{ action === 'GRANT' ? '添加管理员' : '移除管理员' }}
        </NButton>
        <NButton :disabled="busy" @click="closeEditor">取消</NButton>
      </div>
    </NForm>
    <NSpin v-if="busy && !rows.length && !action" />
    <NEmpty v-else-if="!rows.length && !error" description="暂无角色管理员。" />
    <ul v-if="rows.length" class="console-record-list">
      <li v-for="member in rows" :key="member.subject">
        <strong>{{ member.subject }}</strong>
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
</template>
