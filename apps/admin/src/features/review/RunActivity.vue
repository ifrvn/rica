<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { UiAlert, UiBadge, UiButton, UiEmpty, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { characterPath, formatTime, queryPath, type Page } from '@ricajs/console-shared/console-data'
import { request, RequestError } from '@ricajs/console-shared/request'
import { runStateLabels } from '@ricajs/simulation/console/run-filters'
import type { runActivityItem } from '@ricajs/contracts/management'
import type { z } from '@hono/zod-openapi'
import { platformReviews } from '../../app/plugin-integrations.js'

type Entry = z.infer<typeof runActivityItem>
const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: []; open: [entry: Entry] }>()
const kindLabels = { SIMULATION: '模拟运行', ASSESSMENT: '仅评估', PROPOSAL: '真实提案' }
const simulationStates: Readonly<Record<string, string>> = runStateLabels
const platform = (id: string) => platformReviews.find((plugin) => plugin.id === id)?.activity
function stateLabel(entry: Entry) {
  const labels = entry.kind === 'SIMULATION' ? simulationStates : platform(entry.platform)?.states[entry.kind]
  return labels?.[entry.state] ?? entry.state
}

const kind = ref('')
const rows = ref<Entry[]>([])
const cursor = ref<string | null>(null)
const error = ref('')
const busy = ref(false)
let active = true
onBeforeUnmount(() => { active = false })

async function load(append = false) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  if (!append) {
    rows.value = []
    cursor.value = null
  }
  try {
    const page = await request<Page<Entry>>(queryPath(characterPath(props.characterId) + '/run-activity', {
      kind: kind.value, cursor: append ? cursor.value : null,
    }))
    if (!active) return
    rows.value = append ? [...rows.value, ...page.items] : page.items
    cursor.value = page.nextCursor
  } catch (cause) {
    if (!active) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) {
      emit('expired')
      return
    }
    if (status === 403 || status === 404) {
      rows.value = []
      cursor.value = null
    }
    error.value = status === 403 ? '当前账号无权查看运行记录。'
      : status === 404 ? '当前角色不可访问。' : '无法读取运行记录，请重试。'
  } finally {
    busy.value = false
  }
}

onMounted(() => load())
</script>

<template>
  <section class="console-card run-activity">
    <div class="activity-controls">
      <UiField label="记录类型" for="run-activity-kind">
        <select id="run-activity-kind" v-model="kind" :disabled="busy" @change="load()">
          <option value="">全部记录</option>
          <option v-for="(label, value) in kindLabels" :key="value" :value="value">{{ label }}</option>
        </select>
      </UiField>
      <UiButton size="small" variant="soft" :disabled="busy" @click="load()">刷新</UiButton>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiSpinner v-if="busy" aria-label="正在读取运行记录" />
    <UiEmpty v-if="!busy && !error && !rows.length" description="暂无符合条件的运行记录。" />
    <ul v-if="rows.length" class="activity-list">
      <li v-for="row in rows" :key="row.kind + '/' + row.platform + '/' + row.id">
        <div class="activity-entry">
          <div class="activity-heading"><strong>{{ row.identity }}</strong><UiBadge>{{ kindLabels[row.kind] }}</UiBadge></div>
          <span>{{ platform(row.platform)?.title ?? row.platform }} · {{ row.account }}</span>
          <div class="activity-meta"><span>{{ stateLabel(row) }}</span><time :datetime="row.createdAt">{{ formatTime(row.createdAt) }}</time></div>
        </div>
        <UiButton size="small" variant="soft" @click="emit('open', row)">查看详情</UiButton>
      </li>
    </ul>
    <UiButton v-if="cursor" size="small" variant="quiet" :disabled="busy" @click="load(true)">加载更多</UiButton>
  </section>
</template>

<style scoped>
.run-activity, .activity-entry { display: grid; gap: .5rem; min-width: 0; }
.activity-controls { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem; }
.activity-list { list-style: none; padding: 0; margin: .25rem 0; }
.activity-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; padding: .85rem 0; border-top: 1px solid var(--console-line); }
.activity-heading, .activity-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .75rem; }
.activity-entry { overflow-wrap: anywhere; }
</style>
