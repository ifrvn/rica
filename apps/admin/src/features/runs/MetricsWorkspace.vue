<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { simulationDailyMetricsView } from '../../../../../packages/contracts/simulation-observability.js'
import { characterPath, queryPath, useConsoleTask } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'

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
    const result = await request<Metrics>(queryPath(characterPath(props.characterId) + '/monitoring/daily', range))
    if (active()) { metrics.value = result; applied.value = range }
  })
}

onMounted(load)
</script>

<template>
  <section class="console-workspace console-stack" aria-label="指标查询">
    <NForm @submit.prevent="load">
      <div class="console-form-grid">
        <NFormItem label="起始日期（UTC）" :label-props="{ for: 'metrics-from' }">
          <input id="metrics-from" v-model="form.from" type="date" :disabled="busy" />
        </NFormItem>
        <NFormItem label="截止日期（UTC）" :label-props="{ for: 'metrics-through' }">
          <input id="metrics-through" v-model="form.through" type="date" :disabled="busy" />
        </NFormItem>
      </div>
      <NButton size="small" attr-type="submit" :loading="busy" :disabled="!valid">查询指标</NButton>
    </NForm>
    <NAlert v-if="!valid" type="warning" role="status">请选择不超过 31 天的 UTC 日期范围。</NAlert>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin v-if="busy && !metrics" />
    <template v-if="metrics">
      <div>{{ applied.from }} 至 {{ applied.through }}（UTC）</div>
      <div class="console-actions">
        <NTag>预算预留 {{ totals.reserved }}</NTag><NTag>模型调用 {{ totals.calls }}</NTag>
        <NTag :type="totals.denials ? 'warning' : 'default'">预算拒绝 {{ totals.denials }}</NTag>
        <NTag>审批 {{ totals.reviewed }} / {{ totals.proposed }}</NTag><NTag>模拟回执 {{ totals.receipts }}</NTag>
      </div>
      <ul v-if="metrics.alerts.length" class="console-record-list" aria-label="模拟评测告警">
        <li v-for="alert in metrics.alerts" :key="alert"><NTag type="warning">{{ alerts[alert] }}</NTag></li>
      </ul>
      <p v-else>此范围内无评测告警。</p>
      <details>
        <summary>查看每日评测</summary>
        <div class="metrics-table-scroll" tabindex="0" role="region" aria-label="每日模拟指标表">
          <table class="metrics-table">
            <thead><tr><th scope="col">UTC 日期</th><th scope="col">提案</th><th scope="col">批准</th><th scope="col">拒绝</th>
              <th scope="col">重复标记</th><th scope="col">回执</th><th scope="col">草稿耗时（ms）</th><th scope="col">预算拒绝</th></tr></thead>
            <tbody><tr v-for="row in metrics.days" :key="row.utcDay">
              <th scope="row">{{ row.utcDay }}</th><td>{{ row.proposals }}</td><td>{{ row.approvals }}</td><td>{{ row.rejections }}</td>
              <td>{{ row.duplicateFlags }}</td><td>{{ row.receipts }}</td><td>{{ row.draftLatencyMs ?? '—' }}</td><td>{{ row.budgetDenials }}</td>
            </tr></tbody>
          </table>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.metrics-table-scroll { max-width: 100%; overflow-x: auto; }
.metrics-table { border-collapse: collapse; width: 100%; }
.metrics-table th, .metrics-table td { text-align: start; padding: .4rem .5rem; border-bottom: 1px solid var(--console-line); }
</style>
