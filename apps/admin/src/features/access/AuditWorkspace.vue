<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiSpinner } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { auditView } from '@ricajs/contracts/management'
import { platformReviews, pluginAuditLabels } from '../../app/plugin-integrations.js'
import { request, RequestError } from '@ricajs/console-shared/request'

type Entry = z.infer<typeof auditView>
type Page = { items: Entry[]; nextCursor: string | null }

const props = defineProps<{ characterId: string; runId?: string; targetId?: string; canReview: boolean }>()
const emit = defineEmits<{ expired: []; all: []; openRun: [id: string]; proposal: [plugin: string, id: string] }>()
const path = '/v1/characters/' + encodeURIComponent(props.characterId) + '/audit'
const items = ref<Entry[]>([])
const cursor = ref<string | null>(null)
const busy = ref(false)
const error = ref('')
const reviewFor = (entry: Entry) => props.canReview ? platformReviews.find(({ ownsAudit }) => ownsAudit?.(entry.operation)) : undefined
function openProposal(entry: Entry) {
  const review = reviewFor(entry)
  if (review) emit('proposal', review.id, entry.targetId)
}
let active = true
onBeforeUnmount(() => { active = false })

const labels: Record<string, string> = {
  'simulation.start': '发起模拟', 'action.review': '提交审批', 'action.invalidate': '使提案失效',
  'simulation.settings': '修改模拟限制',
  'simulation.term.update': '更新模拟群聊词条',
  'auto-review.update': '修改自动审批设置', 'action.auto-approve': 'AI 批准模拟回复',
  'newbi.reply.auto-approve': 'AI 批准 Newbi 回复',
  'newbi.discussion.assess': '评估 Newbi 讨论',
  'simulation.resolve': '模拟对账', 'outbox.retry': '恢复隔离事件',
  'simulation.executing': '领取模拟执行许可', 'simulation.simulated': '模拟执行完成',
  'simulation.blocked': '模拟执行被拦截', 'simulation.reconciling': '模拟发送结果待核对',
  'plan.register_from_receipt': '由回执登记模拟计划', 'commitment.register_from_receipt': '由回执登记模拟承诺',
  'character.create': '创建角色', 'character.core.update': '更新角色核心',
  'identity.create': '创建身份', 'identity.update': '更新身份', 'account.create': '登记平台账号',
  'account.register': '添加账号到账号池', 'account.associate': '关联平台账号',
  'control.apply': '变更运行状态', 'membership.change': '变更角色管理员', 'account.remove': '移除未关联账号',
  'state.energy.approve': '批准角色精力', 'goal.create': '新增目标', 'goal.update': '更新目标',
  'belief.create': '新增观点', 'belief.update': '更新观点', 'belief.restore': '恢复观点版本',
  'contact.boundary': '变更联系边界', 'memory.correct': '纠正记忆',
  'memory.grant.create': '授予记忆访问权限', 'memory.grant.revoke': '撤销记忆访问权限',
  'schedule.create': '新增模拟计划', 'schedule.update': '更新模拟计划',
  'commitment.create': '登记模拟承诺', 'commitment.update': '处理模拟承诺',
  ...pluginAuditLabels,
}

async function load(append = false) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({ order: 'desc' })
    if (props.runId) query.set('runId', props.runId)
    if (props.targetId) query.set('targetId', props.targetId)
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
  <section class="console-card console-stack" aria-labelledby="audit-records-heading">
    <div class="console-section-heading">
      <h3 id="audit-records-heading">{{ runId ? '此运行的审计记录' : targetId ? '此目标的审计记录' : '操作记录' }}</h3>
      <div class="console-actions">
        <UiButton size="small" variant="quiet" :disabled="busy" @click="load()">刷新记录</UiButton>
        <UiButton v-if="runId || targetId" size="small" variant="quiet" @click="emit('all')">查看全部审计</UiButton>
        <UiButton v-if="runId" size="small" @click="emit('openRun', runId)">返回运行详情</UiButton>
      </div>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiSpinner v-if="busy && !items.length" />
    <UiEmpty v-else-if="!items.length && !error" description="暂无审计记录。" />
    <ul v-if="items.length" class="console-group-list">
      <li v-for="item in items" :key="item.id">
        <div class="console-group-row">
          <div class="audit-summary">
            <strong>{{ item.operation === 'action.review' && item.decision ? (item.decision === 'APPROVE' ? '人工批准模拟回复' : '人工拒绝模拟回复') : labels[item.operation] || '系统活动' }}</strong>
            <div class="console-group-meta">
              <time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time>
              <span v-if="item.actorLabel">{{ item.actorLabel }}</span>
              <span v-if="item.run?.identity">{{ item.run.identity }} · {{ item.run.platform }}</span>
              <span v-if="item.commitment">{{ item.commitment.title }} · 当前到期 {{ new Date(item.commitment.dueAt).toLocaleString() }}</span>
            </div>
          </div>
          <div class="console-actions">
            <UiButton v-if="!runId && item.run" size="small" variant="quiet"
              @click="emit('openRun', item.run!.id)">查看运行</UiButton>
            <UiButton v-if="reviewFor(item)" size="small" variant="quiet"
              @click="openProposal(item)">查看平台提案</UiButton>
          </div>
        </div>
        <details class="audit-details">
          <summary>查看记录详情</summary>
          <dl>
            <div><dt>操作代码</dt><dd>{{ item.operation }}</dd></div>
            <div><dt>操作人 ID</dt><dd>{{ item.actorId }}</dd></div>
            <div><dt>目标 ID</dt><dd>{{ item.targetId }}</dd></div>
            <div><dt>请求 ID</dt><dd>{{ item.requestId }}</dd></div>
            <div><dt>摘要哈希</dt><dd>{{ item.digest }}</dd></div>
          </dl>
        </details>
      </li>
    </ul>
    <UiButton v-if="cursor" size="small" :disabled="busy" @click="load(true)">加载更多</UiButton>
  </section>
</template>

<style scoped>
.audit-summary { display: grid; gap: .25rem; }
.audit-summary .console-group-meta { display: flex; flex-wrap: wrap; gap: .2rem .75rem; }
.audit-details { padding: 0 .75rem .85rem; }
.audit-details summary { width: fit-content; cursor: pointer; color: var(--console-muted); font-size: .875rem; }
.audit-details dl { display: grid; gap: .4rem; margin: .6rem 0 0; padding: .75rem;
  background: var(--console-hover); border-radius: 4px; }
.audit-details dl > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .5rem; }
.audit-details dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 30rem) {
  .audit-details dl > div { grid-template-columns: minmax(0, 1fr); gap: .15rem; }
}
</style>
