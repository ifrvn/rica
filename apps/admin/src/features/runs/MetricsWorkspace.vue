<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiSpinner } from '@rica/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { simulationDailyMetricsView } from '../../../../../packages/contracts/simulation-observability.js'
import { characterPath, queryPath, useConsoleTask } from '@rica/console-shared/console-data'
import { request, RequestError } from '@rica/console-shared/request'

type Metrics = z.infer<typeof simulationDailyMetricsView>
const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: [] }>()
const { busy, error, active, run } = useConsoleTask(() => emit('expired'))
const dayMs = 86_400_000
const utcDay = (daysAgo: number) => new Date(Date.now() - daysAgo * dayMs).toISOString().slice(0, 10)
const form = reactive({ from: utcDay(14), through: utcDay(1) })
const applied = ref({ ...form })
const metrics = ref<Metrics>()
const valid = computed(() => {
  const days = (Date.parse(form.through) - Date.parse(form.from)) / dayMs
  return days >= 0 && days <= 30
})
const alerts: Record<Metrics['alerts'][number], string> = {
  FLAGGED_RECEIPTS: '有回执涉及跨平台重复标记',
  UNAPPROVED_RECEIPTS: '发现缺少批准记录的模拟回执',
  MODEL_BUDGET_EXHAUSTED: '存在模型预算拒绝',
  RECEIPT_VOLUME_DRIFT: '模拟回执量发生漂移',
  REVIEW_RATE_DRIFT: '审批率发生漂移',
}
const totals = computed(() => (metrics.value?.days ?? []).reduce((result, item) => ({
  reserved: result.reserved + item.reservedUnits, calls: result.calls + item.modelCalls,
  denials: result.denials + item.budgetDenials, proposed: result.proposed + item.proposals,
  reviewed: result.reviewed + item.approvals + item.rejections, receipts: result.receipts + item.receipts,
}), { reserved: 0, calls: 0, denials: 0, proposed: 0, reviewed: 0, receipts: 0 }))

function load() {
  if (!valid.value) return
  void run(async () => {
    const range = { ...form }
    try {
      const result = await request<Metrics>(queryPath(characterPath(props.characterId) + '/monitoring/daily', range))
      if (active()) { metrics.value = result; applied.value = range }
    } catch (cause) {
      if (active() && cause instanceof RequestError && [403, 404].includes(cause.status)) metrics.value = undefined
      throw cause
    }
  })
}

onMounted(load)
</script>

<template>
  <div class="console-stack metrics-workspace">
    <section class="console-card console-stack" aria-labelledby="metrics-query-heading">
      <div class="console-section-heading"><h3 id="metrics-query-heading">查询范围</h3></div>
      <form class="metrics-query" @submit.prevent="load">
        <UiField label="起始日期（UTC）" for="metrics-from">
          <input id="metrics-from" v-model="form.from" type="date" :disabled="busy" />
        </UiField>
        <UiField label="截止日期（UTC）" for="metrics-through">
          <input id="metrics-through" v-model="form.through" type="date" :disabled="busy" />
        </UiField>
        <UiButton tone="primary" type="submit" :loading="busy" :disabled="busy || !valid">查询指标</UiButton>
      </form>
      <UiAlert v-if="!valid" tone="warning" role="status">请选择不超过 31 天的 UTC 日期范围。</UiAlert>
      <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
      <UiSpinner v-if="busy && !metrics" aria-label="正在查询模拟指标" />
    </section>

    <section v-if="metrics" class="console-card console-stack" aria-labelledby="metrics-overview-heading">
      <div class="console-section-heading">
        <h3 id="metrics-overview-heading">模拟概览</h3>
        <span class="console-group-meta">{{ applied.from }} 至 {{ applied.through }}（UTC）</span>
      </div>
      <dl class="metric-totals">
        <div><dt>模拟回执</dt><dd>{{ totals.receipts }}</dd></div>
        <div><dt>已审批 / 提案</dt><dd>{{ totals.reviewed }} / {{ totals.proposed }}</dd></div>
        <div><dt>模型调用</dt><dd>{{ totals.calls }}</dd></div>
        <div><dt>预算预留</dt><dd>{{ totals.reserved }}</dd></div>
        <div><dt>预算拒绝</dt><dd>{{ totals.denials }}</dd></div>
      </dl>
      <UiAlert v-if="metrics.alerts.length" tone="warning" title="评测告警">
        <ul class="metric-alerts"><li v-for="alert in metrics.alerts" :key="alert">{{ alerts[alert] }}</li></ul>
      </UiAlert>
    </section>

    <section v-if="metrics" class="console-card console-stack" aria-labelledby="metrics-daily-heading">
      <div class="console-section-heading"><h3 id="metrics-daily-heading">每日明细</h3></div>
      <UiEmpty v-if="!metrics.days.length" description="所选日期内暂无指标数据。" />
      <div v-else class="metrics-table-scroll" tabindex="0" role="region" aria-label="每日模拟指标表">
        <table class="metrics-table">
          <thead><tr><th scope="col">UTC 日期</th><th scope="col">提案</th><th scope="col">批准</th><th scope="col">拒绝</th>
            <th scope="col">重复标记</th><th scope="col">回执</th><th scope="col">草稿耗时（ms）</th><th scope="col">预算拒绝</th></tr></thead>
          <tbody><tr v-for="row in metrics.days" :key="row.utcDay">
            <th scope="row">{{ row.utcDay }}</th><td>{{ row.proposals }}</td><td>{{ row.approvals }}</td><td>{{ row.rejections }}</td>
            <td>{{ row.duplicateFlags }}</td><td>{{ row.receipts }}</td><td>{{ row.draftLatencyMs ?? '—' }}</td><td>{{ row.budgetDenials }}</td>
          </tr></tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.metrics-query { display: flex; flex-wrap: wrap; align-items: start; gap: .75rem; }
.metrics-query :deep(.ui-field) { min-width: min(100%, 10rem); }
.metrics-query input { box-sizing: border-box; width: 100%; height: 34px; font: inherit; color: inherit;
  border: 1px solid var(--console-field); border-radius: 5px; background: var(--console-surface); padding-inline: .5rem; }
.metrics-query .ui-button { margin-top: 1.5rem; }
.metric-totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
  gap: 1rem; margin: 0; padding-block: .25rem; }
.metric-totals dt { color: var(--console-muted); font-size: .875rem; }
.metric-totals dd { margin: .2rem 0 0; font-size: 1.45rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.metric-alerts { margin-block: 0; padding-inline-start: 1.25rem; }
.metrics-table-scroll { max-width: 100%; overflow-x: auto; }
.metrics-table { border-collapse: collapse; width: 100%; min-width: 38rem; font-variant-numeric: tabular-nums; }
.metrics-table th, .metrics-table td { text-align: end; padding: .75rem .625rem; border-bottom: 1px solid var(--console-line); }
.metrics-table th:first-child { text-align: start; white-space: nowrap; }
.metrics-table thead { background: var(--console-hover); }
.metrics-table thead th, .metrics-table tbody th { font-weight: 600; }
.metrics-table tbody tr:hover { background: var(--console-hover); }
.metrics-table tbody tr:last-child :is(th, td) { border-bottom: 0; }
@media (max-width: 28rem) {
  .metrics-query { display: grid; gap: 0; justify-items: start; }
  .metrics-query :deep(.ui-field) { width: 100%; }
  .metrics-query .ui-button { margin-top: 0; }
}
</style>
