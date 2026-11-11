<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView } from '../../../../../packages/contracts/management.js'
import type { pluginStatusView, PluginService } from '../../../../../packages/contracts/plugin-status.js'
import { request, RequestError } from '../../shared/request.js'

type Account = z.infer<typeof accountView>
type Service = z.infer<typeof pluginStatusView>['services'][number]
type Plugin = Service['catalog'][number]
const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: []; accounts: [id?: string] }>()
const base = '/v1/characters/' + encodeURIComponent(props.characterId)
const services = ref<Service[]>([])
const bindings = ref<Account[]>([])
const expanded = ref(new Set<PluginService>())

function toggle(service: PluginService) {
  if (expanded.value.has(service)) expanded.value.delete(service)
  else expanded.value.add(service)
}
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
const reports = { READY: '已就绪', COMPLETED: '最近任务已完成', FAILED: '最近任务失败' }
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
  <div class="plugin-workspace">
    <section aria-labelledby="plugin-status-heading">
      <div class="console-section-heading">
        <h3 id="plugin-status-heading">进程状态</h3>
        <NButton size="small" quaternary :disabled="busy || loadingBindings" @click="refresh">刷新状态</NButton>
      </div>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NSpin v-if="busy && !services.length" />
      <NEmpty v-else-if="!services.length && !error" description="暂无进程报告。" />
      <table v-if="services.length" class="plugin-status-table" aria-labelledby="plugin-status-heading">
        <thead><tr><th scope="col">进程</th><th scope="col">状态</th><th scope="col">最近报告</th></tr></thead>
        <tbody v-for="service in services" :key="service.service">
          <tr>
            <th scope="row">
              {{ names[service.service] }}
              <NButton text size="small" class="plugin-toggle" :aria-label="(expanded.has(service.service) ? '收起' : '展开') + names[service.service] + '详情'"
                :aria-expanded="expanded.has(service.service)" :aria-controls="'plugin-details-' + service.service"
                @click="toggle(service.service)">{{ expanded.has(service.service) ? '收起' : '详情' }}</NButton>
            </th>
            <td>
              <NTag size="small" :bordered="false" :type="service.report?.status === 'READY' ? 'success' : service.report?.status === 'FAILED' ? 'error' : 'default'">
                {{ service.report ? reports[service.report.status] : '未知' }}
              </NTag>
            </td>
            <td><time v-if="service.report" :datetime="service.report.observedAt">{{ new Date(service.report.observedAt).toLocaleString() }}</time>
              <span v-else>—</span></td>
          </tr>
          <tr v-show="expanded.has(service.service)" :id="'plugin-details-' + service.service">
            <td colspan="3" class="plugin-details">
              <p v-if="service.report?.diagnostic">错误码 <code>{{ service.report.diagnostic }}</code></p>
              <ul class="plugin-list">
                <li v-for="plugin in service.catalog" :key="plugin.kind + '/' + plugin.id" class="plugin-row">
                  <div><strong>{{ plugin.id }}</strong>
                    <div>{{ kinds[plugin.kind] }} · v{{ observed(service, plugin)?.version ?? plugin.version }} · 契约
                      {{ observed(service, plugin)?.contractVersion ?? plugin.contractVersion }}</div>
                  </div>
                  <NTag size="small" :bordered="false">{{ state(service, plugin) }}</NTag>
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
    <section v-if="!error || services.length" aria-labelledby="plugin-accounts-heading">
      <div class="console-section-heading">
        <h3 id="plugin-accounts-heading">当前角色的账号</h3>
        <NButton size="small" quaternary @click="emit('accounts')">查看平台账号</NButton>
      </div>
      <NAlert v-if="bindingError" type="warning" role="status">{{ bindingError }}</NAlert>
      <NSpin v-else-if="loadingBindings && !bindings.length" />
      <NEmpty v-else-if="!bindings.length" description="暂无平台账号。" />
      <ul v-if="bindings.length" class="plugin-list">
        <li v-for="account in bindings" :key="account.id" class="plugin-row">
          <span>{{ account.platform }} · {{ account.instanceKey }}</span>
          <div class="console-actions">
            <NTag size="small" :bordered="false">{{ accountStatus[account.status] ?? account.status }}</NTag>
            <NButton v-if="account.platform === 'newbi'" size="small" quaternary
              @click="emit('accounts', account.id)">查看读取状态</NButton>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.plugin-workspace { display: grid; gap: 1.5rem; min-width: 0; }
.plugin-status-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.plugin-status-table th, .plugin-status-table td { text-align: start; padding: .55rem .375rem;
  border-bottom: 1px solid var(--console-line); overflow-wrap: anywhere; }
.plugin-status-table thead th { color: var(--console-muted); font-size: .875rem; font-weight: 500; }
.plugin-status-table tbody th { font-weight: 600; }
.plugin-status-table th:first-child { width: 40%; }
.plugin-status-table time { font-size: .875rem; color: var(--console-muted); }
.plugin-toggle { margin-inline-start: .4rem; }
.plugin-details { background: var(--console-hover); }
.plugin-details p { margin: .25rem 0 .5rem; }
.plugin-status-table :deep(.n-tag) { height: auto; min-height: 22px; max-width: 100%; white-space: normal; }
.plugin-row { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; justify-content: space-between;
  padding-block: .5rem; overflow-wrap: anywhere; }
.plugin-list { list-style: none; margin: 0; padding: 0; }
.plugin-list > li + li { border-top: 1px solid var(--console-line); }
@media (max-width: 30rem) { .plugin-toggle { margin-inline-start: 0; display: flex; } }
</style>
