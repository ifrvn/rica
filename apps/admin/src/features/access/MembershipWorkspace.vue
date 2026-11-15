<script setup lang="ts">
import { ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiSpinner } from '@rica/console-shared/ui'
import type { LocalUser } from '../../../../../packages/contracts/local-users.js'
import { formatTime, queryPath, useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'

const props = defineProps<{ revision: number; canCreate: boolean }>()
const emit = defineEmits<{ expired: []; createAccount: [] }>()
const { busy, error, active, run } = useConsoleTask(() => emit('expired'))
const rows = ref<LocalUser[]>([])
const cursor = ref<string | null>(null)

async function load(append = false): Promise<void> {
  const revision = props.revision
  const page = await request<{ items: LocalUser[]; nextCursor: string | null }>(
    queryPath('/v1/auth/users', { after: append ? cursor.value : null }),
  )
  if (!active()) return
  if (revision !== props.revision) return load()
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

watch(() => props.revision, () => {
  if (props.canCreate) void run(load)
}, { immediate: true })
</script>

<template>
  <section class="console-card console-stack" aria-labelledby="member-list-heading">
    <div class="console-section-heading">
      <h3 id="member-list-heading">系统管理员</h3>
      <UiButton v-if="canCreate" id="system-admin-create" tone="primary" size="small"
        @click="emit('createAccount')">新建账号</UiButton>
    </div>
    <UiEmpty v-if="!canCreate" description="只有系统管理员可以查看账号列表。" />
    <template v-else>
      <UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
      <UiButton v-if="error" size="small" variant="quiet" :disabled="busy" @click="run(load)">重新加载</UiButton>
      <UiSpinner v-if="busy && !rows.length" aria-label="正在读取账号" />
      <UiEmpty v-else-if="!rows.length && !error" description="暂无系统管理员。" />
      <ul v-if="rows.length" class="console-group-list">
        <li v-for="row in rows" :key="row.username" class="console-group-row">
          <strong>{{ row.username }}</strong>
          <span class="console-group-meta">
            创建时间 <time v-if="row.createdAt" :datetime="row.createdAt">{{ formatTime(row.createdAt) }}</time><template v-else>未知</template>
          </span>
        </li>
      </ul>
      <UiButton v-if="cursor" size="small" :disabled="busy" @click="run(() => load(true))">加载更多</UiButton>
    </template>
  </section>
</template>
