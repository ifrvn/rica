<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { auditView } from '../../packages/contracts/management.js'
import { request, RequestError } from './request.js'

type Entry = z.infer<typeof auditView>
type Page = { items: Entry[]; nextCursor: string | null }

const props = defineProps<{ characterId: string; runId?: string }>()
const emit = defineEmits<{ expired: []; all: []; openRun: [id: string] }>()
const path = '/v1/characters/' + encodeURIComponent(props.characterId) + '/audit'
const items = ref<Entry[]>([])
const cursor = ref<string | null>(null)
const busy = ref(false)
const error = ref('')
let active = true
onBeforeUnmount(() => { active = false })

const labels: Record<string, string> = {
  'simulation.start': '发起模拟', 'action.review': '提交审批', 'action.invalidate': '使提案失效',
  'simulation.resolve': '模拟对账', 'outbox.retry': '恢复隔离事件',
  'character.create': '创建角色', 'character.core.update': '更新角色核心',
  'identity.create': '创建身份', 'identity.update': '更新身份', 'account.create': '登记平台账号',
  'account.register': '添加账号到账号池', 'account.associate': '关联平台账号',
  'control.apply': '变更运行状态', 'membership.change': '变更成员权限',
  'state.energy.approve': '批准角色精力', 'goal.create': '新增目标', 'goal.update': '更新目标',
  'belief.create': '新增观点', 'belief.update': '更新观点', 'belief.restore': '恢复观点版本',
  'contact.boundary': '变更联系边界', 'memory.correct': '纠正记忆',
  'memory.grant.create': '授予记忆访问权限', 'memory.grant.revoke': '撤销记忆访问权限',
  'schedule.create': '新增模拟计划', 'schedule.update': '更新模拟计划',
  'commitment.create': '登记模拟承诺', 'commitment.update': '处理模拟承诺',
  'newbi.account.bind': '绑定连接器账号', 'newbi.reply.create': '创建回复提案',
  'newbi.reply.review': '审批公开回复', 'newbi.reply.close': '结案回复提案',
}

async function load(append = false) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({ order: 'desc' })
    if (props.runId) query.set('runId', props.runId)
    if (append && cursor.value) query.set('cursor', cursor.value)
    const page = await request<Page>(path + '?' + query.toString())
    if (!active) return
    items.value = append ? [...items.value, ...page.items] : page.items
    cursor.value = page.nextCursor
  } catch (cause) {
    if (!active) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) {
      emit('expired')
      return
    }
    if (status === 403 || status === 404) {
      items.value = []
      cursor.value = null
    }
    error.value = ({
      403: '当前账号无权查看审计记录。', 404: '当前角色或运行不可访问。',
      422: '审计记录已变化，请刷新列表。',
    } as Record<number, string>)[status] ?? '无法读取审计记录，请重试。'
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="console-workspace" aria-labelledby="audit-records-heading">
    <div class="console-section-heading">
      <h3 id="audit-records-heading">{{ runId ? '此运行的审计记录' : '操作记录' }}</h3>
      <div class="console-actions">
        <NButton size="small" quaternary :disabled="busy" @click="load()">刷新记录</NButton>
        <template v-if="runId">
          <NButton size="small" quaternary @click="emit('all')">查看全部审计</NButton>
          <NButton size="small" @click="emit('openRun', runId)">返回运行详情</NButton>
        </template>
      </div>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin v-if="busy && !items.length" />
    <NEmpty v-else-if="!items.length && !error" description="暂无审计记录。" />
    <ul v-if="items.length" class="audit-list">
      <li v-for="item in items" :key="item.id">
        <details>
          <summary>
            <span>{{ labels[item.operation] || item.operation }}</span>
            <time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time>
          </summary>
          <dl>
            <div><dt>操作代码</dt><dd>{{ item.operation }}</dd></div>
            <div><dt>操作人 ID</dt><dd>{{ item.actorId }}</dd></div>
            <div><dt>目标 ID</dt><dd>{{ item.targetId }}</dd></div>
            <div><dt>请求 ID</dt><dd>{{ item.requestId }}</dd></div>
            <div><dt>摘要哈希</dt><dd>{{ item.digest }}</dd></div>
          </dl>
          <NButton v-if="!runId && item.operation === 'simulation.start'" size="small" quaternary
            @click="emit('openRun', item.targetId)">查看运行</NButton>
        </details>
      </li>
    </ul>
    <NButton v-if="cursor" size="small" :disabled="busy" @click="load(true)">加载更多</NButton>
  </section>
</template>

<style scoped>
.audit-list { list-style: none; margin: 0 0 .5rem; padding: 0; }
.audit-list li + li { border-top: 1px solid var(--console-line); }
details { padding-block: .6rem; }
summary { cursor: pointer; overflow-wrap: anywhere; }
summary time { margin-inline-start: .65rem; color: var(--console-muted); }
dl { display: grid; gap: .4rem; }
dl > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .5rem; }
dd { margin: 0; overflow-wrap: anywhere; }
</style>
