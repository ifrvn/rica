<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NTag } from 'naive-ui'
import type { PluginService } from '../../../../../packages/contracts/plugin-status.js'
import type { Readiness } from '../../../../../packages/contracts/health.js'
import { deploymentPluginIds } from '../../../../../packages/contracts/deployment-plugins.js'
import { formatTime } from '../../shared/console-data.js'
import { modelCheckLabels, pluginNames, usePluginStatus } from '../plugins/plugin-status.js'

type Tone = 'default' | 'success' | 'warning' | 'error'
type Node = { id: string; label: string; description: string; state: string; tone: Tone; at?: string; diagnostic?: string }
const props = defineProps<{ characterId: string; readiness?: Readiness; checkedAt?: string; checking: boolean }>()
const emit = defineEmits<{ expired: []; plugins: []; accounts: []; runs: []; check: [] }>()
const { status, busy, error, refresh: refreshPlugins } = usePluginStatus(props.characterId, () => emit('expired'))
const selected = ref('api')
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
  const deployment = status.value?.deployment
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
  const reader = processNode('connector-reader', '读取 Newbi 消息', '独立读取平台事件到账号收件箱。账号接入及读取记录可在平台账号池查看。')
  const executor = processNode('connector-executor', '发送 Newbi 回复', '单次发送命令的最近报告。每条回复都须取得对应的发送许可。')
  const hasNewbi = deployment?.plugins.newbi === 'ENABLED'
  const worker = processNode('worker', '生成草稿', '认知 Worker 消费模拟任务并生成草稿。')
  const loadedModel = services?.find(({ service }) => service === 'worker')?.report?.plugins.find(({ kind }) => kind === 'model')?.id
  const enabledModels = deploymentPluginIds.filter((id) => id !== 'newbi' && deployment?.plugins[id] === 'ENABLED')
  const models: Node[] = enabledModels
    .map((id) => {
      const configured = deployment?.configuredModel === id
      return { id, label: pluginNames[id] + ' 写作', description: '由认知 Worker 在公开模拟草稿任务中使用。',
        state: !configured ? '待配置' : loadedModel === id ? '已载入' : '已配置 · 等待载入',
        tone: configured && loadedModel === id ? 'success' : 'default' }
    })
  const approval: Node = { id: 'approval', label: '人工审批与发送许可', description: '管理 API 校验审批权限、回复目标和发送许可。',
    state: '由管理 API 提供', tone: 'default' }
  const dependencies = [
    dependency('postgres', 'PostgreSQL', '存储角色配置、审批、回执与运行记录。连接状态来自管理 API 的探测。'),
    dependency('redis', 'Redis', '提供任务队列和进程报告缓存。连接状态来自管理 API 的探测。'),
  ]
  const external = (id: string, label: string, description: string, configured: boolean): Node =>
    ({ id, label, description, state: configured ? '暂无独立探测' : '待配置', tone: 'default' })
  if (hasNewbi) {
    dependencies.push(
      external('newbi-read', 'Newbi 读取 API', '账号级连接核验与读取结果可在平台账号池查看。', !!deployment?.newbi.hasCredential),
      external('newbi-write', 'Newbi 发送 API', '发送结果可在 Newbi 提案中查看。读取连接与发送许可分别校验。', !!deployment?.newbi.hasCredential),
    )
  }
  for (const id of enabledModels) {
    const configured = deployment?.configuredModel === id
    const check = status.value?.modelCheck
    const node = external('model-api-' + id, pluginNames[id] + ' API',
      configured ? '在插件中心可用固定消息测试模型连接。' : '在插件中心保存模型 ID 和 API 密钥后即可测试。', configured)
    if (configured && check?.provider === id) {
      node.state = check.status === 'OK' ? '测试通过' : '测试失败'
      node.tone = check.status === 'OK' ? 'success' : 'error'
      node.at = check.checkedAt
      node.description = modelCheckLabels[check.status]
    }
    dependencies.push(node)
  }
  return [
    { label: '控制面', nodes: [api] },
    { label: '接收事件', nodes: [adapters, ...(hasNewbi ? [reader] : [])] },
    { label: '生成草稿', edge: '模拟事件入队', nodes: [worker, ...models] },
    { label: '审核动作', edge: '提案送审', nodes: [approval] },
    { label: '执行动作', edge: '按运行模式及许可分流', nodes: [
      processNode('simulation-executor', '写入模拟回执', '执行已获许可的模拟动作，并把回执写入模拟账本。'),
      ...(hasNewbi ? [executor] : []),
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
      <NButton size="small" quaternary @click="emit('plugins')">插件中心</NButton>
      <NButton size="small" secondary :disabled="checking || busy" @click="refresh">刷新状态</NButton>
    </div>
    <NAlert v-if="error" type="warning" role="status">进程报告读取失败。{{ error }}</NAlert>
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
        <NTag size="small" :type="detail.tone" :bordered="false" aria-live="polite">{{ detail.state }}</NTag>
      </div>
      <p>{{ detail.description }}</p>
      <p v-if="detail.at">最近检查或报告 <time :datetime="detail.at">{{ formatTime(detail.at) }}</time></p>
      <p v-if="detail.diagnostic">错误码 <code>{{ detail.diagnostic }}</code></p>
      <NButton v-if="detail.id === 'connector-reader' || detail.id === 'newbi-read'" size="small" secondary
        @click="emit('accounts')">查看平台账号池</NButton>
      <NButton v-if="detail.id.startsWith('model-api-')" size="small" secondary
        @click="detail.state === '待配置' ? emit('plugins') : emit('runs')">
        {{ detail.state === '待配置' ? '前往插件中心' : '查看运行记录' }}
      </NButton>
      <NButton v-if="detail.id === 'postgres' || detail.id === 'redis'" size="small" secondary
        :disabled="checking" @click="emit('check')">重试探测</NButton>
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
.health-detail .n-button { margin-block-start: .75rem; }
@media (max-width: 40rem) {
  .health-layer { grid-template-columns: minmax(0, 1fr); gap: .375rem; }
  .health-edge { padding-inline-start: .5rem; }
}
</style>
