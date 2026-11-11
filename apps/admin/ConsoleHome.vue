<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NSpin } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { simulationBacklogView, simulationRunSummary } from '../../packages/contracts/simulation-observability.js'
import { characterPath, formatTime, useConsoleTask, type Page } from './console-data.js'
import type { ConsolePage } from './console-location.js'
import { request } from './request.js'

type Backlog = z.infer<typeof simulationBacklogView>
type Run = z.infer<typeof simulationRunSummary>
const props = defineProps<{ characterId: string; canReview: boolean; canStart: boolean }>()
const emit = defineEmits<{ expired: []; navigate: [page: ConsolePage]; run: [id: string]; reconcile: [] }>()
const { busy, error, active, run } = useConsoleTask(() => emit('expired'))
const backlog = ref<Backlog>()
const recent = ref<Run[]>([])
const labels: Record<string, string> = {
  QUEUED: '排队中', CONTEXT_READY: '上下文已就绪', DRAFTED: '已生成草稿', WAITING_APPROVAL: '待审批',
  READY: '已批准', EXECUTING: '执行中', RECONCILING: '待对账', SIMULATED: '已获得模拟回执',
  REJECTED: '已拒绝', CANCELED: '已失效', EXPIRED: '已过期', BLOCKED: '执行已拦截',
}
const priority = computed(() => {
  const summary = backlog.value
  if (!summary) return
  if (props.canReview && summary.approvals.count) return {
    title: summary.approvals.count + ' 条模拟提案待审批', label: '查看待审批', action: () => emit('navigate', 'review'),
  }
  if (summary.reconciliation.count) return {
    title: summary.reconciliation.count + ' 条模拟运行待对账', label: '查看待对账', action: () => emit('reconcile'),
  }
  if (summary.outbox.quarantined) return {
    title: summary.outbox.quarantined + ' 项失败任务待处理', label: '查看失败任务', action: () => emit('navigate', 'outbox'),
  }
  return props.canStart
    ? { title: '试跑一次角色回复', label: '前往运行记录', action: () => emit('navigate', 'runs') }
    : undefined
})
const tools = [
  { page: 'character', icon: 'i-lucide-users', title: '角色与身份', hint: '查看角色和身份' },
  { page: 'accounts', icon: 'i-lucide-contact', title: '平台账号池', hint: '查看账号及其关联身份' },
  { page: 'plugins', icon: 'i-lucide-puzzle', title: '插件', hint: '查看插件与进程报告' },
] as const

function refresh() {
  return run(async () => {
    const path = characterPath(props.characterId)
    const [summary, page] = await Promise.all([
      request<Backlog>(path + '/monitoring'),
      request<Page<Run>>(path + '/runs?limit=3'),
    ])
    if (!active()) return
    backlog.value = summary
    recent.value = page.items
  })
}

onMounted(refresh)
</script>

<template>
  <div class="console-stack home">
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <section v-if="priority" class="home-card home-priority" aria-label="优先处理">
      <div class="home-action-copy">
        <span class="i-lucide-message-circle" aria-hidden="true" />
        <h3>{{ priority.title }}</h3>
      </div>
      <NButton type="primary" @click="priority.action">{{ priority.label }}</NButton>
    </section>
    <section class="home-card" aria-labelledby="home-recent">
      <div class="console-section-heading">
        <h3 id="home-recent">最近动态</h3>
        <NButton v-if="error" size="small" :loading="busy" @click="refresh">重新加载</NButton>
        <NButton v-else-if="recent.length" size="small" quaternary @click="emit('navigate', 'runs')">查看运行记录</NButton>
      </div>
      <NSpin v-if="busy && !backlog" aria-label="正在加载工作台" />
      <ol v-else-if="recent.length" class="home-timeline">
        <li v-for="item in recent" :key="item.id">
          <button type="button" class="home-row" @click="emit('run', item.id)">
            <span class="home-node" aria-hidden="true"><span class="i-lucide-flask-conical" /></span>
            <span class="home-row-copy"><strong>{{ labels[item.state] ?? item.state }}</strong><small>模拟运行 · {{ item.platform }}</small></span>
            <time :datetime="item.createdAt">{{ formatTime(item.createdAt) }}</time>
          </button>
        </li>
      </ol>
      <p v-else-if="!error" class="home-empty">当前角色暂无运行记录。</p>
    </section>
    <section class="home-card" aria-labelledby="home-tools">
      <div class="console-section-heading"><h3 id="home-tools">常用工具</h3></div>
      <div class="home-tools">
        <button v-for="tool in tools" :key="tool.page" type="button" class="home-row" @click="emit('navigate', tool.page)">
          <span :class="tool.icon" aria-hidden="true" />
          <span class="home-row-copy"><strong>{{ tool.title }}</strong><small>{{ tool.hint }}</small></span>
          <span class="i-lucide-chevron-right" aria-hidden="true" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home { gap: 1rem; }
.home-card { min-width: 0; padding: 1rem; background: var(--console-surface); border: 1px solid var(--console-line); border-radius: 5px; }
.home-priority { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .75rem; background: var(--console-selected); }
.home-action-copy { display: flex; align-items: center; gap: .625rem; }
.home-action-copy h3, .home-empty { margin: 0; }
.home-action-copy h3 { font-size: .9375rem; }
.home-timeline { position: relative; list-style: none; margin: 0; padding: 0; }
.home-timeline::before { content: ''; position: absolute; inset-block: 1.5rem; inset-inline-start: calc(.625rem + 15px); width: 1px; background: var(--console-line); }
.home-row { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center;
  gap: .625rem; width: 100%; min-height: 3.25rem; padding: .5rem .625rem; border: 0; border-radius: 3px;
  background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.home-row:hover { background: var(--console-hover); }
.home-row-copy { display: grid; gap: .125rem; }
.home-row small, .home-row time, .home-empty { color: var(--console-muted); font-size: .8125rem; }
.home-node { display: grid; place-items: center; width: 31px; aspect-ratio: 1; border-radius: 50%; background: var(--console-selected); }
.home-node, .home-tools .home-row > :is(:first-child, :last-child), .home-action-copy > span { color: var(--console-accent-text); }
.home-tools { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; }
@media (max-width: 48rem) {
  .home-tools { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .home-tools button + button { border-top: 1px solid var(--console-line); }
}
@media (max-width: 30rem) {
  .home-row time { grid-column: 2; }
}
</style>
