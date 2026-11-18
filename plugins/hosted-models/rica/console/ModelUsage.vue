<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { queryPath, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request, RequestError } from '@ricajs/console-shared/request'
import { hostedModelCatalog } from '../../providers/catalog.js'
import { maxUsageDays, usageQuery, type UsageRow } from '../management/usage-contracts.js'

const emit = defineEmits<{ expired: [] }>()
const { active, busy, error, run } = useConsoleTask(() => emit('expired'))
const dayMs = 86_400_000
const utcDay = (daysAgo: number) => new Date(Date.now() - daysAgo * dayMs).toISOString().slice(0, 10)
const date = reactive({ from: utcDay(6), through: utcDay(0) })
const report = ref<{ rows: UsageRow[]; from: string; through: string }>()
const valid = computed(() => usageQuery.safeParse(date).success)

const dimensions = { character: '角色', identity: '身份', platform: '平台', model: '模型', purpose: '用途' } as const
type Dimension = keyof typeof dimensions
type Option = { value: string; label: string }
const filters = reactive<Record<Dimension, string>>({ character: '', identity: '', platform: '', model: '', purpose: '' })
const groupBy = ref<Dimension>('model')
const measures = { requests: '请求数', totalTokens: 'Token 用量', sentBytes: '发送量', receivedBytes: '接收量' } as const
const measure = ref<keyof typeof measures>('totalTokens')
const purposes = { DRAFT: '生成草稿', REVIEW: '自动审批', CHECK: '连接测试' } as const
const outcomes = { HTTP_ERROR: 'HTTP 错误', RATE_LIMITED: '服务商限流', TIMED_OUT: '超时或取消',
  CONNECTION_FAILED: '连接失败', INVALID_OUTPUT: '无有效回复' } as const
const providers = new Map<string, string>(hostedModelCatalog.map(({ id, name }) => [id, name]))
const platforms: Record<string, string> = { 'mock-a': '模拟平台 A', 'mock-b': '模拟平台 B', newbi: 'Newbi' }
const format = new Intl.NumberFormat('zh-CN')
const bytes = (value: number) => {
  const scale = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0
  return format.format(Number((value / 1024 ** scale).toFixed(scale ? 2 : 0))) + ' ' + ['B', 'KiB', 'MiB', 'GiB'][scale]
}

function dimension(row: UsageRow, key: Dimension): Option {
  switch (key) {
    case 'character': return { value: row.characterId || 'unassigned', label: row.character || '未归属角色' }
    case 'identity': return { value: row.identityId || 'unassigned',
      label: row.identity ? row.character + ' / ' + row.identity : '未归属身份' }
    case 'platform': return { value: row.platform || 'unassigned', label: (platforms[row.platform] ?? row.platform) || '未归属平台' }
    case 'model': return { value: row.provider + '/' + row.model, label: (providers.get(row.provider) ?? row.provider) + ' · ' + row.model }
    case 'purpose': return { value: row.purpose, label: purposes[row.purpose] }
  }
}

const keys = Object.keys(dimensions) as Dimension[]
const options = computed(() => Object.fromEntries(keys.map((key) => {
  const rows = report.value?.rows ?? []
  const candidates = key === 'identity' && filters.character
    ? rows.filter(row => dimension(row, 'character').value === filters.character) : rows
  const items = candidates.map(row => dimension(row, key))
  return [key, [...new Map(items.map(item => [item.value, item])).values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))]
})) as Record<Dimension, Option[]>)
watch(() => filters.character, () => { filters.identity = '' })

const totals = () => ({ requests: 0, failed: 0, tokenReports: 0, sentBytes: 0, receivedBytes: 0, elapsedMs: 0,
  inputTokens: 0, outputTokens: 0, totalTokens: 0 })
type Totals = ReturnType<typeof totals>
function add(target: Totals, row: UsageRow) {
  for (const key of Object.keys(target) as (keyof Totals)[]) {
    target[key] += key === 'failed' ? (row.outcome === 'OK' ? 0 : row.requests) : row[key]
  }
}
const filtered = computed(() => (report.value?.rows ?? []).filter(row =>
  keys.every(key => !filters[key] || dimension(row, key).value === filters[key])))
const aggregate = computed(() => {
  const summary = totals()
  const days = new Map<string, Totals>()
  const groups = new Map<string, { label: string; metrics: Totals }>()
  const errors = new Map<string, number>()
  if (report.value) {
    for (let day = Date.parse(report.value.from); day <= Date.parse(report.value.through); day += dayMs) {
      days.set(new Date(day).toISOString().slice(0, 10), totals())
    }
  }
  for (const row of filtered.value) {
    add(summary, row)
    const day = days.get(row.day)
    if (day) add(day, row)
    const item = dimension(row, groupBy.value)
    const group = groups.get(item.value) ?? { label: item.label, metrics: totals() }
    add(group.metrics, row)
    groups.set(item.value, group)
    if (row.outcome !== 'OK') errors.set(row.outcome, (errors.get(row.outcome) ?? 0) + row.requests)
  }
  return {
    summary, days: [...days],
    groups: [...groups].map(([key, item]) => ({ key, ...item })).sort((a, b) => b.metrics.requests - a.metrics.requests),
    errors: [...errors].map(([key, count]) => ({ label: outcomes[key as keyof typeof outcomes], count })),
  }
})
const maximum = computed(() => Math.max(1, ...aggregate.value.days.map(([, values]) => values[measure.value])))
const formatMetric = (value: number) => measure.value.endsWith('Bytes') ? bytes(value) : format.format(value)
const dailyValue = (values: Totals) => measure.value === 'totalTokens' && values.requests && !values.tokenReports
  ? '未报告' : formatMetric(values[measure.value])
const latency = (summary: Totals) => summary.requests ? format.format(Math.round(summary.elapsedMs / summary.requests)) + ' ms' : '—'

function load() {
  if (!valid.value) return
  void run(async () => {
    const query = { ...date }
    try {
      const result = await request<{ rows: UsageRow[] }>(queryPath('/v1/model-usage', query))
      if (active()) {
        report.value = { ...result, ...query }
        for (const key of keys) {
          if (filters[key] && !options.value[key].some(item => item.value === filters[key])) filters[key] = ''
        }
      }
    } catch (cause) {
      if (active() && cause instanceof RequestError && [403, 404].includes(cause.status)) report.value = undefined
      throw cause
    }
  })
}

function preset(days: number) {
  Object.assign(date, { from: utcDay(days - 1), through: utcDay(0) })
  load()
}

onMounted(load)
</script>

<template>
  <div class="console-stack model-usage">
    <section class="console-card" aria-label="查询和筛选">
      <div class="usage-presets">
        <UiButton v-for="days in [7, 30, 90]" :key="days" variant="soft" size="small" :disabled="busy" @click="preset(days)">
          最近 {{ days }} 天
        </UiButton>
      </div>
      <form class="usage-controls" @submit.prevent="load">
        <UiField label="起始日期（UTC）" for="usage-from"><input id="usage-from" v-model="date.from" type="date" class="ui-control" :disabled="busy" /></UiField>
        <UiField label="截止日期（UTC）" for="usage-through"><input id="usage-through" v-model="date.through" type="date" class="ui-control" :disabled="busy" /></UiField>
        <UiButton type="submit" tone="primary" :loading="busy" :disabled="busy || !valid">查询用量</UiButton>
      </form>
      <UiAlert v-if="!valid" tone="warning">请选择有效日期范围，最多 {{ maxUsageDays }} 天。</UiAlert>
      <div v-if="report?.rows.length" class="usage-controls">
        <UiField v-for="key in keys" :key="key" :label="dimensions[key]" :for="'usage-' + key">
          <select :id="'usage-' + key" v-model="filters[key]" class="ui-control">
            <option value="">全部</option>
            <option v-for="item in options[key]" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </UiField>
      </div>
    </section>
    <UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
    <UiSpinner v-if="busy && !report" aria-label="正在加载外部模型统计" />
    <UiEmpty v-else-if="report && !aggregate.summary.requests" :description="report.rows.length
      ? '当前筛选条件下暂无调用记录。' : '所选时间内暂无外部模型调用记录。'" />
    <template v-else-if="report && aggregate.summary.requests">
      <section class="console-card" aria-labelledby="usage-summary">
        <div class="console-section-heading">
          <h3 id="usage-summary">用量概览</h3>
          <span class="usage-muted">{{ report.from }} 至 {{ report.through }}（UTC）</span>
        </div>
        <dl class="usage-totals">
          <div><dt>请求数</dt><dd>{{ format.format(aggregate.summary.requests) }}</dd></div>
          <div><dt>失败请求</dt><dd>{{ format.format(aggregate.summary.failed) }}</dd></div>
          <div><dt>发送量</dt><dd>{{ bytes(aggregate.summary.sentBytes) }}</dd></div>
          <div><dt>接收量</dt><dd>{{ bytes(aggregate.summary.receivedBytes) }}</dd></div>
          <div><dt>总 Token</dt><dd>{{ aggregate.summary.tokenReports ? format.format(aggregate.summary.totalTokens) : '—' }}</dd></div>
          <div><dt>平均耗时</dt><dd>{{ latency(aggregate.summary) }}</dd></div>
        </dl>
        <p class="usage-muted">
          Token 已报告 {{ format.format(aggregate.summary.tokenReports) }} / {{ format.format(aggregate.summary.requests) }} 次。
          输入 {{ aggregate.summary.tokenReports ? format.format(aggregate.summary.inputTokens) : '—' }} ·
          输出 {{ aggregate.summary.tokenReports ? format.format(aggregate.summary.outputTokens) : '—' }}。
          数据量按交给 HTTP 客户端的请求体和实际读取的响应体计。
        </p>
        <p v-if="aggregate.errors.length" class="usage-muted">{{ aggregate.errors.map(item => item.label + ' ' + format.format(item.count) + ' 次').join(' · ') }}</p>
      </section>
      <section class="console-card" aria-labelledby="usage-trend">
        <div class="console-section-heading">
          <h3 id="usage-trend">每日趋势</h3>
          <select v-model="measure" class="ui-control usage-select" aria-label="趋势指标">
            <option v-for="(label, key) in measures" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="usage-chart" aria-hidden="true">
          <span v-for="[day, values] in aggregate.days" :key="day" class="usage-bar"
            :style="{ height: 100 * values[measure] / maximum + '%' }" :title="day + ' · ' + dailyValue(values)" />
        </div>
        <div class="usage-dates usage-muted"><span>{{ report.from }}</span><span>{{ report.through }}</span></div>
        <details class="usage-daily">
          <summary>查看每日数值</summary>
          <dl><template v-for="[day, values] in aggregate.days" :key="day">
            <dt>{{ day }}</dt><dd>{{ dailyValue(values) }}</dd>
          </template></dl>
        </details>
      </section>
      <section class="console-card" aria-labelledby="usage-groups">
        <div class="console-section-heading">
          <h3 id="usage-groups">分组明细</h3>
          <select v-model="groupBy" class="ui-control usage-select" aria-label="分组维度">
            <option v-for="(label, key) in dimensions" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="usage-table-scroll" tabindex="0" role="region" aria-label="模型用量分组表">
          <table>
            <thead><tr>
              <th scope="col">{{ dimensions[groupBy] }}</th><th scope="col">请求</th><th scope="col">失败</th>
              <th scope="col">发送量</th><th scope="col">接收量</th><th scope="col">输入 Token</th><th scope="col">输出 Token</th>
              <th scope="col">总 Token</th><th scope="col">已报告</th><th scope="col">平均耗时</th>
            </tr></thead>
            <tbody><tr v-for="{ key, label, metrics } in aggregate.groups" :key="key">
              <th scope="row">{{ label }}</th><td>{{ format.format(metrics.requests) }}</td><td>{{ format.format(metrics.failed) }}</td>
              <td>{{ bytes(metrics.sentBytes) }}</td><td>{{ bytes(metrics.receivedBytes) }}</td>
              <td>{{ metrics.tokenReports ? format.format(metrics.inputTokens) : '—' }}</td>
              <td>{{ metrics.tokenReports ? format.format(metrics.outputTokens) : '—' }}</td>
              <td>{{ metrics.tokenReports ? format.format(metrics.totalTokens) : '—' }}</td>
              <td>{{ metrics.tokenReports }} / {{ metrics.requests }}</td><td>{{ latency(metrics) }}</td>
            </tr></tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.model-usage, .model-usage section { min-width: 0; }
.usage-presets, .usage-controls { display: flex; flex-wrap: wrap; gap: .5rem .75rem; align-items: start; }
.usage-presets { margin-block-end: .875rem; }
.usage-controls :deep(.ui-field) { flex: 1 1 9rem; max-width: 18rem; }
.usage-controls :deep(.ui-button) { margin-block-start: 1.5rem; }
.usage-muted, .usage-totals dt { color: var(--console-muted); font-size: .875rem; }
.usage-totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr)); gap: .875rem; }
.usage-totals dd { margin: .25rem 0 0; font-weight: 650; font-size: 1.3rem; font-variant-numeric: tabular-nums; }
.usage-select { width: auto; }
.usage-chart { display: flex; align-items: end; gap: 2px; height: 8rem; border-block-end: 1px solid var(--console-field); }
.usage-bar { flex: 1 1 0; min-width: 0; background: var(--console-primary); border-radius: 2px 2px 0 0; }
.usage-dates { display: flex; justify-content: space-between; margin-block: .375rem; }
.usage-daily summary { cursor: pointer; font-size: .875rem; }
.usage-daily dl { display: grid; grid-template-columns: max-content auto; gap: .25rem .75rem; font-variant-numeric: tabular-nums; }
.usage-daily dd { margin: 0; }
.usage-table-scroll { overflow: auto; max-width: 100%; }
.usage-table-scroll table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.usage-table-scroll :is(th, td) { padding: .625rem .5rem; text-align: end; white-space: nowrap; border-block-end: 1px solid var(--console-line); }
.usage-table-scroll th:first-child { min-width: 11rem; text-align: start; white-space: normal; overflow-wrap: anywhere; }
.usage-table-scroll thead { background: var(--console-hover); }
</style>
