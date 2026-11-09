<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, conversationOption } from '../../packages/contracts/management.js'
import type { scheduleView } from '../../packages/contracts/schedules.js'
import type { commitmentView } from '../../packages/contracts/commitments.js'
import type { runReplayView } from '../../packages/contracts/simulation-observability.js'
import { characterPath, formatTime, queryPath, readAll, useConsoleTask, type Page } from './console-data.js'
import { request } from './request.js'

type Schedule = z.infer<typeof scheduleView>
type Commitment = z.infer<typeof commitmentView>
type Account = z.infer<typeof accountView>
type Conversation = z.infer<typeof conversationOption>
type Replay = z.infer<typeof runReplayView>
const props = defineProps<{ characterId: string; runId?: string }>()
const emit = defineEmits<{ expired: []; clear: [] }>()
const { busy, error, notice, active, run, command } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const schedules = ref<Schedule[]>([])
const commitments = ref<Commitment[]>([])
const accounts = ref<Account[]>([])
const conversations = ref<Conversation[]>([])
const conversationCursor = ref<string | null>(null)
const selectedRun = ref<Replay>()
const zone = ref('UTC')
const editing = ref<'schedule' | 'commitment' | 'new-commitment'>()
const schedule = ref<Schedule>()
const commitment = ref<Commitment>()
const form = reactive({ key: '', accountId: '', conversationId: '', zone: 'UTC', kind: 'DAILY' as Schedule['rule']['kind'],
  enabled: true, localTime: '09:00', dueAt: '', title: '', reason: '', operation: 'DEFER' as 'DEFER' | 'FULFILL' | 'CANCEL' | 'EXPIRE' })
const stateLabels: Record<Commitment['state'], string> = {
  OPEN: '待履行', DEFERRED: '已延期', FULFILLED: '已履行', CANCELED: '已取消', EXPIRED: '已到期',
}
const kinds = [{ value: 'DAILY', label: '每日计划' }, { value: 'REMINDER', label: '单次提醒' }]
const operations = [{ value: 'DEFER', label: '延期' }, { value: 'FULFILL', label: '标记已履行' },
  { value: 'CANCEL', label: '取消承诺' }, { value: 'EXPIRE', label: '标记已到期' }]
const accountOptions = computed(() => accounts.value.filter(({ platform, status }) => ['mock-a', 'mock-b'].includes(platform) && status !== 'REVOKED')
  .map(({ id }) => ({ value: id, label: accountName(id) })))
const validDate = computed(() => Number.isFinite(Date.parse(form.dueAt)))
const valid = computed(() => {
  if (editing.value === 'schedule') return !!(form.zone.trim() && (form.kind === 'DAILY' ? form.localTime : validDate.value)
    && (schedule.value || (form.key.trim() && form.accountId && form.conversationId)))
  if (editing.value === 'new-commitment') return !!(selectedRun.value?.proposal?.receiptAt && form.title.trim() && form.reason.trim() && validDate.value)
  return !!(commitment.value && form.reason.trim() && (form.operation !== 'DEFER' || validDate.value))
})

function accountName(id: string) {
  const row = accounts.value.find((item) => item.id === id)
  return row ? row.platform + ' · ' + row.instanceKey : id
}

function toLocalInput(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function load() {
  const [plans, promises, bindings, workspace] = await Promise.all([
    readAll<Schedule>(base + '/schedules', active), readAll<Commitment>(base + '/commitments', active),
    readAll<Account>(base + '/accounts', active), request<z.infer<typeof characterWorkspaceView>>(base),
  ])
  if (!active()) return
  schedules.value = plans
  commitments.value = promises
  accounts.value = bindings
  zone.value = workspace.timezone
}

async function loadConversations(append = false) {
  const binding = accounts.value.find(({ id }) => id === form.accountId)
  if (!binding) return
  const page = await request<Page<Conversation>>(queryPath(base + '/identities/' + binding.identityId + '/conversations', {
    accountId: binding.id, cursor: append ? conversationCursor.value : null,
  }))
  if (!active()) return
  conversations.value = append ? [...conversations.value, ...page.items] : page.items
  conversationCursor.value = page.nextCursor
}

function selectAccount(id: string) {
  form.accountId = id
  form.conversationId = ''
  conversations.value = []
  conversationCursor.value = null
  void run(() => loadConversations())
}

function editSchedule(item?: Schedule) {
  editing.value = 'schedule'
  schedule.value = item
  Object.assign(form, { key: '', accountId: '', conversationId: '', zone: item?.zone ?? zone.value,
    kind: item?.rule.kind ?? 'DAILY', enabled: item?.enabled ?? true,
    localTime: item?.rule.kind === 'DAILY' ? item.rule.localTime : '09:00',
    dueAt: item?.rule.kind === 'REMINDER' ? toLocalInput(item.rule.dueAt) : '' })
  conversations.value = []
  conversationCursor.value = null
  error.value = ''
}

function editCommitment(item: Commitment) {
  editing.value = 'commitment'
  commitment.value = item
  Object.assign(form, { reason: '', dueAt: toLocalInput(item.dueAt), operation: 'DEFER' })
  error.value = ''
}

function close() {
  editing.value = undefined
  if (props.runId) emit('clear')
}

function refreshDraft() {
  void run(async () => {
    await load()
    if (!active()) return
    if (schedule.value && editing.value === 'schedule') {
      schedule.value = schedules.value.find(({ id }) => id === schedule.value?.id)
    }
    if (commitment.value && editing.value === 'commitment') {
      commitment.value = commitments.value.find(({ id }) => id === commitment.value?.id)
    }
    notice.value = '已更新版本，请与下方记录核对后提交。'
  })
}

function save() {
  if (!valid.value) return
  void run(async () => {
    if (editing.value === 'schedule') {
      const rule = form.kind === 'DAILY' ? { kind: form.kind, localTime: form.localTime }
        : { kind: form.kind, dueAt: new Date(form.dueAt).toISOString() }
      const data = { zone: form.zone.trim(), enabled: form.enabled, rule }
      if (schedule.value) await command(base + '/schedules/' + schedule.value.id, data, 'PUT', schedule.value.version)
      else {
        const conversation = conversations.value.find(({ id }) => id === form.conversationId)
        if (!conversation) return
        await command(base + '/schedules', { ...data, scheduleKey: form.key.trim(), accountId: form.accountId,
          conversationId: conversation.id, contactId: conversation.privateContactId ?? undefined })
      }
    } else if (editing.value === 'new-commitment' && selectedRun.value?.proposal) {
      await command(base + '/commitments', { actionId: selectedRun.value.proposal.id, title: form.title.trim(),
        dueAt: new Date(form.dueAt).toISOString(), reason: form.reason.trim() })
    } else if (commitment.value) {
      await command(base + '/commitments/' + commitment.value.id, { operation: form.operation, reason: form.reason.trim(),
        ...(form.operation === 'DEFER' ? { dueAt: new Date(form.dueAt).toISOString() } : {}) }, 'PUT', commitment.value.version)
    } else return
    if (!active()) return
    close()
    notice.value = '运行配置已保存。'
    await load()
  })
}

onMounted(() => {
  void run(async () => {
    await load()
    if (!props.runId || !active()) return
    const replay = await request<Replay>(base + '/runs/' + props.runId + '/replay')
    if (!active()) return
    if (replay.state === 'SIMULATED' && replay.proposal?.receiptAt) {
      selectedRun.value = replay
      editing.value = 'new-commitment'
    } else error.value = '只有已确认模拟回执的运行可以登记承诺。'
  })
})
</script>

<template>
  <section class="console-workspace console-stack" aria-label="运行配置">
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NCard v-if="editing" :title="editing === 'schedule' ? (schedule ? '编辑模拟计划' : '新增模拟计划')
      : editing === 'new-commitment' ? '登记模拟承诺' : '处理模拟承诺'" size="small">
      <NForm @submit.prevent="save">
        <div v-if="editing === 'schedule'" class="console-form-grid">
          <template v-if="!schedule">
            <NFormItem label="计划标识" :label-props="{ for: 'plan-key' }">
              <NInput v-model:value="form.key" maxlength="63" :disabled="busy" :input-props="{ id: 'plan-key' }" />
            </NFormItem>
            <NFormItem label="模拟账号" :label-props="{ for: 'plan-account' }">
              <NSelect filterable :value="form.accountId" :options="accountOptions" :disabled="busy"
                :input-props="{ id: 'plan-account' }" @update:value="selectAccount" />
            </NFormItem>
            <NFormItem label="会话" :label-props="{ for: 'plan-conversation' }">
              <NSelect filterable v-model:value="form.conversationId" :disabled="busy || !form.accountId"
                :options="conversations.map(({ id, channel }) => ({ value: id, label: (channel === 'PRIVATE' ? '私聊 · ' : '公开 · ') + id }))"
                :input-props="{ id: 'plan-conversation' }" />
            </NFormItem>
            <NButton v-if="conversationCursor" size="small" :disabled="busy" @click="run(() => loadConversations(true))">加载更多会话</NButton>
          </template>
          <NFormItem label="计划类型" :label-props="{ for: 'plan-kind' }">
            <NSelect filterable v-model:value="form.kind" :options="kinds" :disabled="busy" :input-props="{ id: 'plan-kind' }" />
          </NFormItem>
          <NFormItem label="时区" :label-props="{ for: 'plan-zone' }">
            <NInput v-model:value="form.zone" :disabled="busy" :input-props="{ id: 'plan-zone' }" />
          </NFormItem>
          <NFormItem v-if="form.kind === 'DAILY'" label="每天触发时间（计划时区）" :label-props="{ for: 'plan-time' }">
            <input id="plan-time" v-model="form.localTime" type="time" :disabled="busy" />
          </NFormItem>
          <NFormItem v-else label="提醒时间（浏览器本地）" :label-props="{ for: 'plan-due' }">
            <input id="plan-due" v-model="form.dueAt" type="datetime-local" :disabled="busy" />
          </NFormItem>
          <NCheckbox v-model:checked="form.enabled" :disabled="busy">启用计划</NCheckbox>
        </div>
        <template v-else>
          <p v-if="selectedRun && editing === 'new-commitment'">账号 {{ accountName(selectedRun.accountId) }} ·
            回执 {{ formatTime(selectedRun.proposal!.receiptAt!) }}</p>
          <p v-if="editing === 'commitment' && commitment">{{ commitment.title }} · v{{ commitment.version }}</p>
          <div class="console-form-grid">
            <NFormItem v-if="editing === 'new-commitment'" label="承诺标题" :label-props="{ for: 'commit-title' }">
              <NInput v-model:value="form.title" maxlength="120" :disabled="busy" :input-props="{ id: 'commit-title' }" />
            </NFormItem>
            <NFormItem v-else label="处理方式" :label-props="{ for: 'commit-operation' }">
              <NSelect filterable v-model:value="form.operation" :options="operations" :disabled="busy" :input-props="{ id: 'commit-operation' }" />
            </NFormItem>
            <NFormItem v-if="editing === 'new-commitment' || form.operation === 'DEFER'"
              label="截止时间（本地）" :label-props="{ for: 'commit-due' }">
              <input id="commit-due" v-model="form.dueAt" type="datetime-local" :disabled="busy" />
            </NFormItem>
            <NFormItem label="理由" :label-props="{ for: 'commit-reason' }">
              <NInput v-model:value="form.reason" maxlength="240" :disabled="busy" :input-props="{ id: 'commit-reason' }" />
            </NFormItem>
          </div>
        </template>
        <div class="console-actions">
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!valid">保存配置</NButton>
          <NButton v-if="editing === 'commitment' || (editing === 'schedule' && schedule)" size="small" :disabled="busy"
            @click="refreshDraft">重新读取版本</NButton>
          <NButton :disabled="busy" @click="close">取消</NButton>
        </div>
      </NForm>
    </NCard>
    <NCard title="模拟计划" size="small">
      <template #header-extra><NButton size="small" :disabled="busy || !accountOptions.length" @click="editSchedule()">新增计划</NButton></template>
      <NSpin v-if="busy && !schedules.length && !editing" />
      <NEmpty v-else-if="!schedules.length && !error" description="暂无模拟计划。" />
      <ul v-if="schedules.length" class="console-record-list">
        <li v-for="item in schedules" :key="item.id">
          <div class="console-actions"><strong>{{ item.scheduleKey }}</strong><NTag size="small">{{ item.enabled ? '已启用' : '已暂停' }}</NTag>
            <NTag v-if="item.commitmentId" size="small">承诺提醒</NTag>
            <NButton v-else size="small" :disabled="busy" @click="editSchedule(item)">编辑计划</NButton></div>
          <span>{{ accountName(item.accountId) }} · {{ item.zone }} · v{{ item.version }}</span>
          <span>{{ item.rule.kind === 'DAILY' ? '每天 ' + item.rule.localTime : '单次 ' + formatTime(item.rule.dueAt) }}
            <template v-if="item.nextAt"> · 下次 {{ formatTime(item.nextAt) }}</template></span>
        </li>
      </ul>
    </NCard>
    <NCard title="模拟承诺" size="small">
      <NEmpty v-if="!commitments.length && !busy && !error" description="暂无模拟承诺。" />
      <ul v-if="commitments.length" class="console-record-list">
        <li v-for="item in commitments" :key="item.id">
          <div class="console-actions"><strong>{{ item.title }}</strong><NTag size="small">{{ stateLabels[item.state] }}</NTag>
            <NButton v-if="item.state === 'OPEN' || item.state === 'DEFERRED'" size="small" :disabled="busy"
              @click="editCommitment(item)">处理承诺</NButton></div>
          <span>{{ accountName(item.accountId) }} · 截止 {{ formatTime(item.dueAt) }} · v{{ item.version }}</span>
          <span v-if="item.contactId">联系人 {{ item.contactId }}</span>
        </li>
      </ul>
    </NCard>
  </section>
</template>
