<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { UiAlert, UiBadge, UiButton, UiEmpty, UiSpinner } from '@ricajs/console-shared/ui'
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
const kindFilters = { '': '全部记录', ...kindLabels }
const simulationStates: Readonly<Record<string, string>> = runStateLabels
const platform = (id: string) => platformReviews.find((plugin) => plugin.id === id)?.activity
const platformLabel = (id: string) => platform(id)?.title ?? id.replace(/^plugin:/u, '')
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
    <div class="activity-controls" role="search" aria-label="运行记录筛选">
      <div class="activity-filter" role="group" aria-labelledby="run-activity-kind">
        <span id="run-activity-kind" class="activity-filter-label">记录类型</span>
        <div class="activity-options" @keydown="busy && $event.key.startsWith('Arrow') && $event.preventDefault()">
          <label v-for="(label, value) in kindFilters" :key="value" class="activity-option">
            <input v-model="kind" type="radio" name="run-activity-kind" :value="value" :aria-disabled="busy || undefined"
              @click="busy && $event.preventDefault()" @change="load()" />
            <span class="activity-option-label"><span class="i-lucide-check" aria-hidden="true" />{{ label }}</span>
          </label>
        </div>
      </div>
      <UiButton class="activity-refresh" variant="quiet" :disabled="busy" @click="load()">
        <span class="i-lucide-refresh-cw" aria-hidden="true" />刷新
      </UiButton>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiSpinner v-if="busy" aria-label="正在读取运行记录" />
    <UiEmpty v-if="!busy && !error && !rows.length" description="暂无符合条件的运行记录。" />
    <ul v-if="rows.length" class="activity-list">
      <li v-for="row in rows" :key="row.kind + '/' + row.platform + '/' + row.id">
        <div class="activity-entry">
          <div class="activity-heading"><strong>{{ row.identity }}</strong><UiBadge>{{ kindLabels[row.kind] }}</UiBadge></div>
          <span>{{ platformLabel(row.platform) }} · {{ row.account }}</span>
          <div class="activity-meta"><span>{{ stateLabel(row) }}</span><time :datetime="row.createdAt">{{ formatTime(row.createdAt) }}</time></div>
        </div>
        <UiButton v-if="row.kind === 'SIMULATION' || platform(row.platform)" size="small" variant="soft" @click="emit('open', row)">查看详情</UiButton>
      </li>
    </ul>
    <UiButton v-if="cursor" size="small" variant="quiet" :disabled="busy" @click="load(true)">加载更多</UiButton>
  </section>
</template>

<style scoped>
.run-activity, .activity-entry { display: grid; gap: .5rem; min-width: 0; }
.activity-controls, .activity-filter, .activity-options { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; }
.activity-controls { gap: .5rem 1rem; }
.activity-filter { gap: .375rem .75rem; }
.activity-filter-label { color: var(--console-muted); font-size: .875rem; font-weight: 600; }
.activity-options { gap: .25rem; }
.activity-option { position: relative; }
.activity-option input { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
.activity-option-label {
  display: flex; align-items: center; gap: .25rem; box-sizing: border-box;
  min-height: 2.125rem; min-inline-size: 5.75rem; padding: .25rem .5rem;
  border: 1px solid transparent; border-radius: 5px; color: var(--console-muted); white-space: nowrap; cursor: pointer;
}
.activity-option-label > span { visibility: hidden; }
.activity-option input:not([aria-disabled]):not(:checked) + .activity-option-label:hover { background: var(--console-hover); }
.activity-option input:checked + .activity-option-label {
  border-color: var(--console-field); background: var(--console-selected); color: var(--console-accent-text); font-weight: 600;
}
.activity-option input:checked + .activity-option-label > span { visibility: visible; }
.activity-option input:focus-visible + .activity-option-label { outline: 2px solid var(--console-accent-text); outline-offset: 1px; }
.activity-option input[aria-disabled] + .activity-option-label { cursor: default; }
.activity-refresh { margin-inline-start: auto; }
@media (pointer: coarse) {
  .activity-option-label, .activity-refresh { min-height: 3rem; }
}
.activity-list { list-style: none; padding: 0; margin: .25rem 0; }
.activity-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; padding: .85rem 0; border-top: 1px solid var(--console-line); }
.activity-heading, .activity-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .75rem; }
.activity-entry { overflow-wrap: anywhere; }
</style>
