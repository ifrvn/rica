<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiDialog, UiSpinner, UiBadge } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { outboxQuarantineView, quarantinedOutboxEvent, simulationBacklogView } from '@ricajs/simulation/contracts/observability'
import { request, RequestError } from '@ricajs/console-shared/request'

type Backlog = z.infer<typeof simulationBacklogView>
type Event = z.infer<typeof quarantinedOutboxEvent>
type Quarantine = z.infer<typeof outboxQuarantineView>

const props = defineProps<{ characterId: string; mode: 'backlog' | 'outbox'; canRetry?: boolean }>()
const emit = defineEmits<{ expired: []; openOutbox: []; openReconciliation: []; openRun: [id: string] }>()
const base = '/v1/characters/' + encodeURIComponent(props.characterId)
const backlog = ref<Backlog>()
const events = ref<Event[]>([])
const cursor = ref<string | null>(null)
const selected = ref<Event>()
const stale = ref(false)
const reason = ref('')
const listHeading = ref<HTMLElement>()
let retryTrigger: HTMLElement | undefined
const busy = ref(false)
const error = ref('')
const notice = ref('')
let active = true
onBeforeUnmount(() => { active = false })

const metrics = computed(() => {
  const data = backlog.value
  if (!data) return []
  return [
    { label: '后台任务', ...data.outbox },
    { label: '待审批', ...data.approvals },
    { label: '待对账', ...data.reconciliation },
    { label: '到期定时任务', ...data.schedules },
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
  if (!selected.value) retryTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  if (selected.value?.id !== event.id) reason.value = ''
  selected.value = event
  stale.value = false
  error.value = ''
  notice.value = ''
}

function closeRetry() {
  selected.value = undefined
  reason.value = ''
  error.value = ''
}

function restoreFocus() {
  void nextTick(() => (retryTrigger?.isConnected && !retryTrigger.matches(':disabled') ? retryTrigger : listHeading.value)?.focus())
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
    closeRetry()
    events.value = events.value.filter(({ id }) => id !== event.id)
    notice.value = '事件已重新排队。'
    await load()
  })
}

onMounted(() => { void act(load) })
</script>

<template>
  <section v-if="mode === 'backlog'" class="console-card console-stack run-summary" aria-labelledby="run-summary-heading">
    <div class="console-section-heading">
      <h3 id="run-summary-heading">待处理</h3>
      <UiButton size="small" variant="quiet" :disabled="busy" @click="act(load)">刷新待处理</UiButton>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiSpinner v-if="busy && !backlog" />
    <dl v-if="backlog" class="metrics">
      <div v-for="item in metrics" :key="item.label">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.count }}</dd>
        <small v-if="item.oldestAt">最早 {{ time(item.oldestAt) }}</small>
      </div>
    </dl>
    <div class="operations-actions">
      <UiButton size="small" @click="emit('openOutbox')">
        查看失败任务<template v-if="backlog">（{{ backlog.outbox.quarantined }}）</template>
      </UiButton>
      <UiButton v-if="backlog?.reconciliation.count" size="small" @click="emit('openReconciliation')">查看待对账</UiButton>
    </div>
  </section>
  <section v-else class="console-card console-stack" aria-labelledby="outbox-list-heading">
    <div class="console-section-heading">
      <h3 id="outbox-list-heading" ref="listHeading" tabindex="-1">待恢复任务</h3>
      <UiButton size="small" variant="quiet" :disabled="busy" @click="act(load)">刷新任务</UiButton>
    </div>
    <UiAlert v-if="error && !selected" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
    <UiSpinner v-if="busy && !events.length" aria-label="正在加载失败任务" />
    <UiEmpty v-else-if="!events.length && !error" description="暂无失败任务。" />
    <ul v-if="events.length" class="console-group-list">
      <li v-for="event in events" :key="event.id" class="console-group-row">
        <div class="event-info">
          <strong>{{ eventType[event.type] }}</strong>
          <div class="operations-actions console-group-meta">
            <time :datetime="event.quarantinedAt">隔离于 {{ time(event.quarantinedAt) }}</time>
            <span>已尝试 {{ event.attempts }} 次</span>
          </div>
        </div>
        <div class="operations-actions">
          <UiButton size="small" variant="quiet" @click="emit('openRun', event.runId)">查看运行</UiButton>
          <UiButton v-if="canRetry" size="small" variant="soft" tone="primary" :disabled="busy || !!selected"
            @click="select(event)">恢复任务</UiButton>
        </div>
      </li>
    </ul>
    <UiButton v-if="cursor" class="load-more" size="small" :disabled="busy" @click="act(() => load(true))">加载更多</UiButton>

    <UiDialog :open="!!selected" title="恢复失败任务"
      class="recovery-dialog" :busy="busy"
      @update:open="show => { if (!show) closeRetry() }" @closed="restoreFocus">
      <form v-if="selected" class="console-stack" @submit.prevent="retry">
        <div class="event-info">
          <strong>{{ eventType[selected.type] }}</strong>
          <span class="console-group-meta">第 {{ selected.generation }} 代 · 已尝试 {{ selected.attempts }} 次</span>
        </div>
        <p>确认后，Worker 会重新处理此任务。</p>
        <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
        <p v-if="stale && !currentEvent">此任务已离开失败列表。</p>
        <UiField label="恢复理由" for="outbox-reason">
          <input class="ui-control" v-model="reason" placeholder="例如：已排除故障，可以重新处理"
            v-bind="{ id: 'outbox-reason' }" :maxlength="240" :disabled="busy" />
        </UiField>
        <div class="operations-actions recovery-actions">
          <UiButton :disabled="busy" @click="closeRetry">取消</UiButton>
          <UiButton v-if="stale && currentEvent" tone="primary" :disabled="busy" @click="select(currentEvent)">重新核对</UiButton>
          <UiButton v-else-if="!stale" tone="primary" type="submit" :loading="busy"
            :disabled="busy || !reason.trim()">确认恢复</UiButton>
        </div>
      </form>
    </UiDialog>
  </section>
</template>

<style scoped>
.run-summary .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 7.75rem), 1fr));
  gap: .75rem; margin: 0; }
.run-summary .metrics div { min-width: 0; }
.run-summary small { color: var(--console-muted); }
.metrics dd { margin: .25rem 0; font-size: 1.3rem; font-weight: 650; }
.operations-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.event-info { display: grid; gap: .25rem; overflow-wrap: anywhere; }
.load-more { justify-self: start; }
.recovery-dialog { width: min(32rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); overflow: auto; }
.recovery-dialog p { margin: 0; }
.recovery-actions { justify-content: flex-end; }
</style>
