<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { memberPage } from '../../packages/contracts/management.js'
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
const roleOptions = [
  { value: 'ADMIN', label: '管理员 · ADMIN' },
  { value: 'REVIEWER', label: '审批员 · REVIEWER' },
  { value: 'AUDITOR', label: '审计员 · AUDITOR' },
  { value: 'OPERATOR', label: '操作员 · OPERATOR' },
]

async function load(append = false) {
  const page = await request<Members>(queryPath(path, { after: append ? cursor.value : null }))
  if (!active()) return
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

function edit(kind: 'GRANT' | 'REVOKE', name = '', value: Role = 'REVIEWER') {
  action.value = kind
  subject.value = name
  role.value = value
  reason.value = ''
  error.value = ''
  notice.value = ''
}

function save() {
  const name = subject.value.trim().toLowerCase()
  if (!props.canEdit || !action.value || !name || !reason.value.trim()) return
  void run(async () => {
    await command(path, { action: action.value, subject: name, role: role.value, reason: reason.value.trim() })
    if (!active()) return
    action.value = undefined
    notice.value = '角色权限已更新。'
    if (name === props.username) emit('permissions')
    else await load()
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <NCard title="角色成员" size="small" class="console-workspace">
    <template #header-extra>
      <NButton v-if="canEdit" size="small" :disabled="busy" @click="edit('GRANT')">授予角色权限</NButton>
    </template>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NForm v-if="action" @submit.prevent="save">
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
      <div class="console-actions">
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!subject.trim() || !reason.trim()">
          {{ action === 'GRANT' ? '授予权限' : '撤销权限' }}
        </NButton>
        <NButton :disabled="busy" @click="action = undefined">取消</NButton>
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
              :aria-label="'撤销 ' + member.subject + ' 的 ' + value" @click="edit('REVOKE', member.subject, value)">撤销</NButton>
          </template>
        </div>
      </li>
    </ul>
    <div class="console-actions">
      <NButton size="small" :disabled="busy" @click="run(() => load())">刷新成员</NButton>
      <NButton v-if="cursor" size="small" :disabled="busy" @click="run(() => load(true))">加载更多</NButton>
    </div>
  </NCard>
</template>
