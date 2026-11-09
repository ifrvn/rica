<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { outboxQuarantineView, quarantinedOutboxEvent, simulationBacklogView } from '../../packages/contracts/simulation-observability.js'
import { request, RequestError } from './request.js'

type Backlog = z.infer<typeof simulationBacklogView>
type Event = z.infer<typeof quarantinedOutboxEvent>
type Quarantine = z.infer<typeof outboxQuarantineView>

const props = defineProps<{ characterId: string; mode: 'backlog' | 'outbox'; canRetry?: boolean }>()
const emit = defineEmits<{ expired: []; openOutbox: []; openReconciliation: []; openRuns: []; openRun: [id: string] }>()
const base = '/v1/characters/' + encodeURIComponent(props.characterId)
const backlog = ref<Backlog>()
const events = ref<Event[]>([])
const cursor = ref<string | null>(null)
const selected = ref<Event>()
const stale = ref(false)
const reason = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
let active = true
onBeforeUnmount(() => { active = false })

const metrics = computed(() => {
  const data = backlog.value
  if (!data) return []
  return [
    { label: '待处理出箱', ...data.outbox },
    { label: '待审批', ...data.approvals },
    { label: '待对账', ...data.reconciliation },
    { label: '到期计划', ...data.schedules },
  ]
})
const eventType: Record<Event['type'], string> = {
  'RunQueued.v1': '准备运行', 'SimulatedDraftQueued.v1': '生成模拟草稿',
}
const currentEvent = computed(() => events.value.find(({ id }) => id === selected.value?.id))

function time(value: string) {
  return new Date(value).toLocaleString()
}

async function load(append = false) {
  if (props.mode === 'backlog') {
    const current = await request<Backlog>(base + '/monitoring')
    if (active) backlog.value = current
    return
  }
  const query = append && cursor.value ? '?after=' + encodeURIComponent(cursor.value) : ''
  const page = await request<Quarantine>(base + '/outbox/quarantined' + query)
  if (!active) return
  events.value = append ? [...events.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

async function act(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await task()
  } catch (cause) {
    if (!active) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) {
      emit('expired')
      return
    }
    if (status === 403 || status === 404) {
      backlog.value = undefined
      events.value = []
      cursor.value = null
      selected.value = undefined
      reason.value = ''
    }
    error.value = status === 403 ? '当前账号无权执行此操作。'
      : status === 404 ? '当前角色或事件不可访问。' : '操作未完成，请重试。'
  } finally {
    busy.value = false
  }
}

function select(event: Event) {
  if (selected.value?.id !== event.id) reason.value = ''
  selected.value = event
  stale.value = false
  error.value = ''
  notice.value = ''
}

function retry() {
  const event = selected.value
  const note = reason.value.trim()
  if (!props.canRetry || !event || !note || stale.value) return
  void act(async () => {
    try {
      await request(base + '/outbox/' + encodeURIComponent(event.id) + '/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"' + event.generation + '"' },
        body: JSON.stringify({ reason: note }),
      })
    } catch (cause) {
      if (!(cause instanceof RequestError) || ![409, 412].includes(cause.status)) throw cause
      if (!active) return
      stale.value = true
      await load()
      if (active) error.value = '事件状态已变化。请重新核对后再提交。'
      return
    }
    if (!active) return
    selected.value = undefined
    reason.value = ''
    events.value = events.value.filter(({ id }) => id !== event.id)
    notice.value = '事件已重新排队。'
    await load()
  })
}

onMounted(() => { void act(load) })
</script>

<template>
  <NCard v-if="mode === 'backlog'" title="角色积压" size="small" class="operations">
    <template #header-extra>
      <NButton size="small" :disabled="busy" @click="act(load)">刷新积压</NButton>
    </template>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin v-if="busy && !backlog" />
    <dl v-if="backlog" class="metrics">
      <div v-for="item in metrics" :key="item.label">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.count }}</dd>
        <small v-if="item.oldestAt">最早 {{ time(item.oldestAt) }}</small>
      </div>
    </dl>
    <div class="operations-actions">
      <NButton size="small" @click="emit('openOutbox')">
        查看隔离出箱<template v-if="backlog">（{{ backlog.outbox.quarantined }}）</template>
      </NButton>
      <NButton v-if="backlog?.reconciliation.count" size="small" @click="emit('openReconciliation')">查看待对账</NButton>
    </div>
  </NCard>
  <section v-else class="operations outbox" aria-label="隔离出箱">
    <div class="operations-actions">
      <NButton size="small" @click="emit('openRuns')">返回运行</NButton>
      <NButton size="small" :disabled="busy || !!selected" @click="act(load)">刷新出箱</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NCard v-if="selected" title="恢复隔离事件" size="small">
      <p>{{ eventType[selected.type] }} · 第 {{ selected.generation }} 代</p>
      <p>恢复后由 Worker 重新处理此事件。</p>
      <NForm @submit.prevent="retry">
        <NFormItem label="恢复理由" :label-props="{ for: 'outbox-reason' }">
          <NInput v-model:value="reason" :input-props="{ id: 'outbox-reason' }" :maxlength="240" :disabled="busy" />
        </NFormItem>
        <div class="operations-actions">
          <NButton v-if="stale && currentEvent" :disabled="busy" @click="select(currentEvent)">重新核对</NButton>
          <NButton v-else type="primary" attr-type="submit" :loading="busy"
            :disabled="busy || stale || !reason.trim()">恢复事件</NButton>
          <NButton :disabled="busy" @click="selected = undefined; reason = ''">取消</NButton>
        </div>
      </NForm>
    </NCard>
    <NCard title="隔离事件" size="small">
      <NSpin v-if="busy && !events.length" />
      <NEmpty v-else-if="!events.length && !error" description="暂无隔离事件。" />
      <ul v-if="events.length" class="events">
        <li v-for="event in events" :key="event.id">
          <div class="event-info">
            <div class="operations-actions">
              <strong>{{ eventType[event.type] }}</strong>
              <NTag size="small">第 {{ event.generation }} 代 · 尝试 {{ event.attempts }} 次</NTag>
            </div>
            <span>{{ time(event.quarantinedAt) }}</span>
          </div>
          <div class="operations-actions">
            <NButton size="small" quaternary @click="emit('openRun', event.runId)">查看运行</NButton>
            <NButton v-if="canRetry" size="small" :disabled="busy || !!selected" @click="select(event)">恢复</NButton>
          </div>
        </li>
      </ul>
      <NButton v-if="cursor" size="small" :disabled="busy" @click="act(() => load(true))">加载更多</NButton>
    </NCard>
  </section>
</template>

<style scoped>
.operations { margin-top: 1rem; }
.outbox { display: grid; gap: 1rem; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .75rem; }
.metrics dd { margin: .25rem 0; font-size: 1.3rem; font-weight: 650; }
.operations-actions, .events li { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.events { list-style: none; padding: 0; margin: 0; }
.events li { justify-content: space-between; padding-block: .6rem; }
.events li + li { border-top: 1px solid #e0e8e7; }
.event-info { display: grid; gap: .2rem; overflow-wrap: anywhere; }
</style>
