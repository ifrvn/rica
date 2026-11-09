<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import { membershipInput, type memberPage } from '../../packages/contracts/management.js'
import { characterPath, queryPath, useConsoleTask } from './console-data.js'
import { request } from './request.js'

type Members = z.infer<typeof memberPage>
type Role = Members['items'][number]['roles'][number]
const props = defineProps<{ characterId: string; canEdit: boolean; username: string }>()
const emit = defineEmits<{ expired: []; permissions: [] }>()
const { busy, error, notice, active, run, command } = useConsoleTask(() => emit('expired'))
const path = characterPath(props.characterId) + '/memberships'
const rows = ref<Members['items']>([])
const cursor = ref<string | null>(null)
const subject = ref('')
const role = ref<Role>('REVIEWER')
const reason = ref('')
const action = ref<'GRANT' | 'REVOKE'>()
const memberHeading = ref<HTMLElement>()
const editorHeading = ref<HTMLElement>()
let trigger: HTMLElement | undefined
const payload = computed(() => membershipInput.safeParse({
  action: action.value, subject: subject.value.trim().toLowerCase(), role: role.value, reason: reason.value,
}))
const roleOptions = [
  { value: 'ADMIN', label: '管理员' },
  { value: 'REVIEWER', label: '审批员' },
  { value: 'AUDITOR', label: '审计员' },
  { value: 'OPERATOR', label: '操作员' },
]

async function load(append = false) {
  const page = await request<Members>(queryPath(path, { after: append ? cursor.value : null }))
  if (!active()) return
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

function edit(kind: 'GRANT' | 'REVOKE', name = '', value: Role = 'REVIEWER') {
  if (!action.value) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  action.value = kind
  subject.value = name
  role.value = value
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
  if (!props.canEdit || !result.success) return
  void run(async () => {
    await command(path, result.data)
    if (!active()) return
    closeEditor()
    notice.value = result.data.action === 'GRANT' ? '已授予权限。' : '已撤销权限。'
    if (result.data.subject === props.username) emit('permissions')
    else await load()
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <section class="console-workspace console-stack" aria-labelledby="member-list-heading">
    <div class="console-section-heading">
      <h3 id="member-list-heading" ref="memberHeading" tabindex="-1">成员列表</h3>
      <div class="console-actions">
        <NButton size="small" quaternary :disabled="busy" @click="run(() => load())">刷新成员</NButton>
        <NButton v-if="canEdit" size="small" :disabled="busy || !!action" @click="edit('GRANT')">授予角色权限</NButton>
      </div>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NForm v-if="action" class="console-panel" aria-labelledby="member-editor-heading" @submit.prevent="save">
      <h4 id="member-editor-heading" ref="editorHeading" tabindex="-1">{{ action === 'GRANT' ? '授予角色权限' : '撤销角色权限' }}</h4>
      <div class="console-form-grid">
        <NFormItem label="本地用户名" :label-props="{ for: 'member-subject' }">
          <NInput v-model:value="subject" :disabled="busy || action === 'REVOKE'" maxlength="64" :input-props="{ id: 'member-subject' }" />
        </NFormItem>
        <NFormItem label="权限" :label-props="{ for: 'member-role' }">
          <NSelect filterable v-model:value="role" :options="roleOptions" :disabled="busy || action === 'REVOKE'"
            :input-props="{ id: 'member-role' }" />
        </NFormItem>
        <NFormItem label="变更理由" :label-props="{ for: 'member-reason' }">
          <NInput v-model:value="reason" maxlength="240" :disabled="busy" :input-props="{ id: 'member-reason' }" />
        </NFormItem>
      </div>
      <div class="console-actions">
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !payload.success">
          {{ action === 'GRANT' ? '授予权限' : '撤销权限' }}
        </NButton>
        <NButton :disabled="busy" @click="closeEditor">取消</NButton>
      </div>
    </NForm>
    <NSpin v-if="busy && !rows.length && !action" />
    <NEmpty v-else-if="!rows.length && !error" description="暂无角色成员。" />
    <ul v-if="rows.length" class="console-record-list">
      <li v-for="member in rows" :key="member.subject">
        <strong>{{ member.subject }}</strong>
        <div class="console-actions">
          <template v-for="value in member.roles" :key="value">
            <NTag size="small">{{ roleOptions.find(item => item.value === value)?.label }}</NTag>
            <NButton v-if="canEdit" size="tiny" quaternary :disabled="busy"
              :aria-label="'撤销 ' + member.subject + ' 的 ' + roleOptions.find(item => item.value === value)?.label" @click="edit('REVOKE', member.subject, value)">撤销</NButton>
          </template>
        </div>
      </li>
    </ul>
    <div v-if="cursor">
      <NButton size="small" :disabled="busy" @click="run(() => load(true))">加载更多</NButton>
    </div>
  </section>
</template>
