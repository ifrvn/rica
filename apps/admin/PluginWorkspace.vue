<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView } from '../../packages/contracts/management.js'
import type { pluginStatusView, PluginService } from '../../packages/contracts/plugin-status.js'
import { request, RequestError } from './request.js'

type Account = z.infer<typeof accountView>
type Service = z.infer<typeof pluginStatusView>['services'][number]
type Plugin = Service['catalog'][number]
const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: []; accounts: [] }>()
const base = '/v1/characters/' + encodeURIComponent(props.characterId)
const services = ref<Service[]>([])
const bindings = ref<Account[]>([])
const busy = ref(false)
const loadingBindings = ref(false)
const error = ref('')
const bindingError = ref('')
let active = true
let timer: ReturnType<typeof setInterval> | undefined

const names: Record<PluginService, string> = {
  api: 'API', worker: '认知 Worker', 'simulation-executor': '模拟执行器',
  'connector-reader': '本机连接器 · 读取', 'connector-executor': '本机连接器 · 发送',
}
const kinds: Record<Plugin['kind'], string> = {
  model: '模型', platform: '模拟适配器', 'platform-reader': '只读连接器', 'platform-reply-executor': '发送执行器',
}
const reports = { READY: '已就绪', COMPLETED: '最近命令已完成', FAILED: '最近报告失败' }
const accountStatus: Record<string, string> = {
  ACTIVE: '运行中', PAUSED: '已暂停', PENDING: '待启用', REVOKED: '已撤销', REAUTH_REQUIRED: '需重新授权',
}

function observed(service: Service, plugin: Plugin) {
  return service.report?.plugins.find(({ id, kind }) => id === plugin.id && kind === plugin.kind)
}

function state(service: Service, plugin: Plugin) {
  const report = service.report
  if (report?.status === 'READY') return observed(service, plugin) ? '已启用' : '未启用'
  return report?.status === 'COMPLETED' && observed(service, plugin) ? '最近已运行' : '未知'
}

async function loadStatus() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const data = await request<{ services: Service[] }>(base + '/plugins')
    if (active) services.value = data.services
  } catch (cause) {
    if (!active) return
    services.value = []
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) emit('expired')
    else error.value = status === 403 || status === 404 ? '当前账号无权查看此角色的插件。' : '无法读取插件状态，正在重试。'
    if (status === 403 || status === 404) {
      clearInterval(timer)
      bindings.value = []
    }
  } finally {
    busy.value = false
  }
}

async function loadBindings() {
  if (loadingBindings.value) return
  loadingBindings.value = true
  bindingError.value = ''
  try {
    const items: Account[] = []
    let cursor: string | null = null
    do {
      const page: { items: Account[]; nextCursor: string | null } = await request(base + '/accounts?limit=100'
        + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor && active)
    if (active) bindings.value = items
  } catch (cause) {
    if (!active) return
    bindings.value = []
    if (cause instanceof RequestError && cause.status === 401) emit('expired')
    else bindingError.value = '无法读取账号绑定，请刷新后重试。'
  } finally {
    loadingBindings.value = false
  }
}

function refresh() {
  void loadStatus()
  void loadBindings()
}

onMounted(() => {
  refresh()
  timer = setInterval(() => { void loadStatus() }, 5000)
})
onBeforeUnmount(() => {
  active = false
  clearInterval(timer)
})
</script>

<template>
  <section class="plugin-workspace" aria-label="插件状态">
    <div class="plugin-actions"><NButton size="small" :disabled="busy || loadingBindings" @click="refresh">刷新</NButton></div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin v-if="busy && !services.length" />
    <NCard v-for="service in services" :key="service.service" :title="names[service.service]" size="small">
      <template #header-extra>
        <NTag size="small" :type="service.report?.status === 'READY' ? 'success' : service.report?.status === 'FAILED' ? 'error' : 'default'">
          {{ service.report ? reports[service.report.status] : '未知' }}
        </NTag>
      </template>
      <div v-if="service.report" class="plugin-report">
        <time :datetime="service.report.observedAt">报告于 {{ new Date(service.report.observedAt).toLocaleString() }}</time>
        <code v-if="service.report.diagnostic">{{ service.report.diagnostic }}</code>
      </div>
      <ul class="plugin-list">
        <li v-for="plugin in service.catalog" :key="plugin.kind + '/' + plugin.id" class="plugin-row">
          <div>
            <strong>{{ plugin.id }}</strong>
            <div>{{ kinds[plugin.kind] }} · v{{ observed(service, plugin)?.version ?? plugin.version }} · 契约
              {{ observed(service, plugin)?.contractVersion ?? plugin.contractVersion }}</div>
          </div>
          <NTag size="small">{{ state(service, plugin) }}</NTag>
        </li>
      </ul>
    </NCard>
    <NCard v-if="!error || services.length" title="当前角色的账号绑定" size="small">
      <template #header-extra><NButton size="small" @click="emit('accounts')">查看平台账号</NButton></template>
      <NAlert v-if="bindingError" type="warning" role="status">{{ bindingError }}</NAlert>
      <NSpin v-else-if="loadingBindings && !bindings.length" />
      <NEmpty v-else-if="!bindings.length" description="暂无平台账号绑定。" />
      <ul v-if="bindings.length" class="plugin-list">
        <li v-for="account in bindings" :key="account.id" class="plugin-row">
          <span>{{ account.platform }} · {{ account.instanceKey }}</span>
          <NTag size="small">{{ accountStatus[account.status] ?? account.status }}</NTag>
        </li>
      </ul>
    </NCard>
  </section>
</template>

<style scoped>
.plugin-workspace { display: grid; gap: 1rem; margin-top: 1rem; }
.plugin-actions, .plugin-report, .plugin-row { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
.plugin-report { justify-content: space-between; color: #485c5b; }
.plugin-row { justify-content: space-between; padding-block: .5rem; overflow-wrap: anywhere; }
.plugin-list { list-style: none; margin: 0; padding: 0; }
.plugin-list > li + li { border-top: 1px solid #e0e8e7; }
</style>
