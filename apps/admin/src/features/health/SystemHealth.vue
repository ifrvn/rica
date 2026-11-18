<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { UiAlert, UiButton, UiBadge } from '@rica/console-shared/ui'
import type { PluginService } from '../../../../../packages/contracts/plugin-status.js'
import type { Readiness } from '../../../../../packages/contracts/health.js'
import { platformHealth, hostedModelHealth, hasAccountHealthLink } from '../../app/plugin-integrations.js'
import { formatTime } from '@rica/console-shared/console-data'
import { usePluginStatus } from '../plugins/plugin-status.js'

import type { HealthNode as Node } from '@rica/console-shared/health'
const props = defineProps<{ characterId: string; readiness?: Readiness; checkedAt?: string; checking: boolean; initialNode?: string }>()
const emit = defineEmits<{ expired: []; plugins: []; accounts: []; runs: []; check: [] }>()
const { status, busy, error, refresh: refreshPlugins } = usePluginStatus(props.characterId, () => emit('expired'))
const selected = ref(props.initialNode ?? 'api')
let timer: ReturnType<typeof setInterval>

function refresh() {
  void refreshPlugins()
  emit('check')
}

onMounted(() => {
  emit('check')
  timer = setInterval(() => emit('check'), 5000)
})
onBeforeUnmount(() => clearInterval(timer))

function processNode(id: PluginService, label: string, description: string): Node {
  const report = status.value?.services.find(({ service }) => service === id)?.report
  const state = report?.status === 'READY' ? '已就绪'
    : report?.status === 'COMPLETED' ? '最近任务完成'
      : report?.status === 'FAILED' ? '最近任务失败' : '无近期报告'
  return { id, label, description, state, tone: report?.status === 'READY' ? 'success' : report?.status === 'FAILED' ? 'error' : 'default',
    at: report?.observedAt, diagnostic: report?.diagnostic }
}

function dependency(id: keyof Readiness['checks'], label: string, description: string): Node {
  const reachable = props.readiness?.checks[id]
  return { id, label, description, at: props.checkedAt,
    state: reachable === undefined ? '状态未知' : reachable ? '可连接' : '连接失败',
    tone: reachable === undefined ? 'default' : reachable ? 'success' : 'error' }
}

const layers = computed(() => {
  const services = status.value?.services
  const apiReport = services?.find(({ service }) => service === 'api')?.report
  const adapterCount = apiReport?.status === 'READY' ? apiReport.plugins.filter(({ kind }) => kind === 'platform').length : undefined
  const api: Node = {
    id: 'api', label: '管理与审批入口', description: '管理 API 处理设置、记录查询和人工审批，并探测 PostgreSQL 与 Redis。',
    state: props.readiness?.status === 'ready' ? '已就绪' : props.readiness ? '未就绪' : '无法确认',
    tone: props.readiness?.status === 'ready' ? 'success' : props.readiness ? 'warning' : 'default', at: props.checkedAt,
  }
  const adapters: Node = { id: 'platforms', label: '模拟事件入口', description: '模拟适配器向运行流程提供测试事件。',
    state: adapterCount === undefined ? '载入状态未知' : '已载入 ' + adapterCount + ' 个',
    tone: adapterCount ? 'success' : 'default' }
  const worker = processNode('worker', '生成草稿', '认知 Worker 消费模拟任务并生成草稿。')
  const approval: Node = { id: 'approval', label: '人工审批与发送许可', description: '管理 API 校验审批权限、回复目标和发送许可。',
    state: '由管理 API 提供', tone: 'default' }
  const dependencies = [
    dependency('postgres', 'PostgreSQL', '存储角色配置、审批、回执与运行记录。连接状态来自管理 API 的探测。'),
    dependency('redis', 'Redis', '提供任务队列和进程报告缓存。连接状态来自管理 API 的探测。'),
  ]
  const external = (id: string, label: string, description: string, configured: boolean): Node =>
    ({ id, label, description, state: configured ? '暂无独立探测' : '待配置', tone: 'default' })
  const connector = platformHealth(status.value, processNode, external)
  const modelHealth = hostedModelHealth(status.value, external)
  dependencies.push(...connector.dependencies, ...modelHealth.dependencies)
  return [
    { label: '控制面', nodes: [api] },
    { label: '接收事件', nodes: [adapters, ...connector.readers] },
    { label: '生成草稿', edge: '模拟事件入队', nodes: [worker, ...modelHealth.models] },
    { label: '审核动作', edge: '提案送审', nodes: [approval] },
    { label: '执行动作', edge: '按运行模式及许可分流', nodes: [
      processNode('simulation-executor', '写入模拟回执', '模拟执行器为已批准的提案申请许可，并把结果写入模拟账本。'),
      ...connector.executors,
    ] },
    { label: '外部连接', nodes: dependencies },
  ]
})
const detail = computed(() => {
  const nodes = layers.value.flatMap(({ nodes }) => nodes)
  return nodes.find(({ id }) => id === selected.value) ?? nodes[0]
})
</script>

<template>
  <div class="console-stack health-workspace">
    <div class="console-actions health-toolbar">
      <UiButton size="small" variant="quiet" @click="emit('plugins')">插件中心</UiButton>
      <UiButton size="small" variant="soft" :disabled="checking || busy" @click="refresh">刷新状态</UiButton>
    </div>
    <UiAlert v-if="error" tone="warning" role="status">进程报告读取失败。{{ error }}</UiAlert>
    <section class="console-record-workspace health-map" aria-label="分层运行图">
      <template v-for="layer in layers" :key="layer.label">
        <div v-if="layer.edge" class="health-edge">
          <span class="i-lucide-arrow-down" aria-hidden="true" /> {{ layer.edge }}
        </div>
        <div class="health-layer">
          <h3>{{ layer.label }}</h3>
          <div class="health-nodes">
            <button v-for="node in layer.nodes" :key="node.id" type="button" class="health-node"
              :aria-pressed="detail.id === node.id" @click="selected = node.id">
              <strong>{{ node.label }}</strong>
              <span><i class="health-dot" :data-tone="node.tone" aria-hidden="true" />{{ node.state }}</span>
            </button>
          </div>
        </div>
      </template>
    </section>
    <section class="console-record-workspace health-detail" aria-label="组件详情">
      <div class="console-section-heading">
        <h3>{{ detail.label }}</h3>
        <UiBadge :tone="detail.tone" aria-live="polite">{{ detail.state }}</UiBadge>
      </div>
      <p>{{ detail.description }}</p>
      <p v-if="detail.at">最近检查或报告 <time :datetime="detail.at">{{ formatTime(detail.at) }}</time></p>
      <p v-if="detail.diagnostic">错误码 <code>{{ detail.diagnostic }}</code></p>
      <template v-if="detail.id === 'simulation-executor' && status">
        <p v-if="detail.diagnostic === 'INVALID_CONFIG'">请核对执行器的数据库连接配置，并确认它与管理 API 使用同一个数据库。</p>
        <p v-else-if="detail.state === '最近任务失败'">请查看模拟执行器日志，核对数据库连接和执行权限。</p>
        <p v-else-if="detail.state === '无近期报告'">请确认模拟执行器已启动并连接到本部署的 Redis，再刷新状态。</p>
        <p v-else-if="detail.state === '已就绪'">仍在等待的提案可能受角色当地 22:00 至次日 08:00 的静默时段、账号额度或其他尚未结束的执行影响。</p>
      </template>
      <UiButton v-if="hasAccountHealthLink(detail.id)" size="small" variant="soft"
        @click="emit('accounts')">查看平台账号池</UiButton>
      <UiButton v-if="detail.id.startsWith('model-api-')" size="small" variant="soft"
        @click="detail.state === '待配置' ? emit('plugins') : emit('runs')">
        {{ detail.state === '待配置' ? '前往插件中心' : '查看模拟运行' }}
      </UiButton>
      <UiButton v-if="detail.id === 'postgres' || detail.id === 'redis'" size="small" variant="soft"
        :disabled="checking" @click="emit('check')">重试探测</UiButton>
    </section>
  </div>
</template>

<style scoped>
.health-workspace { gap: 1rem; }
.health-toolbar { justify-content: flex-end; }
.health-map { display: grid; gap: .5rem; }
.health-layer { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: .625rem; align-items: center; }
.health-layer:first-child, .health-layer:last-child { padding-block: .5rem; }
.health-layer:first-child { border-bottom: 1px solid var(--console-line); }
.health-layer:last-child { border-top: 1px solid var(--console-line); }
.health-layer h3 { margin: 0; font-size: .875rem; font-weight: 650; }
.health-nodes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: .5rem; min-width: 0; }
.health-node { display: grid; justify-items: start; gap: .3rem; padding: .625rem .75rem; border: 1px solid var(--console-line);
  border-radius: 4px; background: var(--console-surface); text-align: start; color: inherit; font: inherit; cursor: pointer; overflow-wrap: anywhere; }
.health-node:hover { background: var(--console-hover); }
.health-node[aria-pressed='true'] { background: var(--console-selected); border-color: var(--console-field); }
.health-node span, .health-edge { color: var(--console-muted); font-size: .8125rem; }
.health-dot { display: inline-block; vertical-align: .08em; width: .4rem; aspect-ratio: 1; border-radius: 50%; margin-inline-end: .375rem; background: currentColor; }
.health-dot[data-tone='success'] { background: var(--console-good); }
.health-dot[data-tone='warning'] { background: #ad710c; }
.health-dot[data-tone='error'] { background: #bd454c; }
.health-edge { display: flex; align-items: center; gap: .375rem; padding-inline-start: 7.125rem; }
.health-detail p { margin: .4rem 0 0; }
.health-detail .ui-button { margin-block-start: .75rem; }
@media (max-width: 40rem) {
  .health-layer { grid-template-columns: minmax(0, 1fr); gap: .375rem; }
  .health-edge { padding-inline-start: .5rem; }
}
</style>
