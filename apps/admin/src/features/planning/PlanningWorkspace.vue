<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, conversationOption } from '../../../../../packages/contracts/management.js'
import { scheduleInput, scheduleUpdate, type scheduleView } from '../../../../../packages/contracts/schedules.js'
import { commitmentInput, commitmentUpdate, type commitmentView } from '../../../../../packages/contracts/commitments.js'
import type { runReplayView } from '../../../../../packages/contracts/simulation-observability.js'
import { characterPath, formatTime, queryPath, readAll, useConsoleTask, type Page } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'
import TimeZoneSelect from '../../shared/TimeZoneSelect.vue'

type Schedule = z.infer<typeof scheduleView>
type Commitment = z.infer<typeof commitmentView>
type Account = z.infer<typeof accountView>
type Conversation = z.infer<typeof conversationOption>
type Replay = z.infer<typeof runReplayView>
const props = defineProps<{ characterId: string; runId?: string }>()
const emit = defineEmits<{ expired: []; clear: [feedback?: string] }>()
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
const editorHeading = ref<HTMLElement>()
const plansHeading = ref<HTMLElement>()
const commitmentsHeading = ref<HTMLElement>()
let trigger: HTMLElement | undefined
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
const dueAt = computed(() => {
  const date = new Date(form.dueAt)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
})
const schedulePayload = computed(() => {
  const rule = form.kind === 'DAILY' ? { kind: form.kind, localTime: form.localTime }
    : { kind: form.kind, dueAt: dueAt.value }
  const data = { zone: form.zone, enabled: form.enabled, rule }
  if (schedule.value) return scheduleUpdate.safeParse(data)
  const conversation = conversations.value.find(({ id }) => id === form.conversationId)
  return scheduleInput.safeParse({ ...data, scheduleKey: form.key.trim(), accountId: form.accountId,
    conversationId: conversation?.id, contactId: conversation?.privateContactId ?? undefined })
})
const commitmentPayload = computed(() => editing.value === 'new-commitment'
  ? commitmentInput.safeParse({ actionId: selectedRun.value?.proposal?.id, title: form.title,
    dueAt: dueAt.value, reason: form.reason })
  : commitmentUpdate.safeParse({ operation: form.operation, reason: form.reason,
    ...(form.operation === 'DEFER' ? { dueAt: dueAt.value } : {}) }))
const valid = computed(() => editing.value === 'schedule' ? schedulePayload.value.success
  : !!(editing.value === 'new-commitment' ? selectedRun.value?.proposal?.receiptAt : commitment.value) && commitmentPayload.value.success)
const planKeyError = computed(() => !!form.key && !scheduleInput.shape.scheduleKey.safeParse(form.key.trim()).success)
const invalidZone = computed(() => !scheduleUpdate.shape.zone.safeParse(form.zone).success)
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone

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

function openEditor(kind: NonNullable<typeof editing.value>) {
  if (!editing.value) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  editing.value = kind
  error.value = ''
  notice.value = ''
  void nextTick(() => editorHeading.value?.focus())
}

function editSchedule(item?: Schedule) {
  openEditor('schedule')
  schedule.value = item
  Object.assign(form, { key: '', accountId: '', conversationId: '', zone: item?.zone ?? zone.value,
    kind: item?.rule.kind ?? 'DAILY', enabled: item?.enabled ?? true,
    localTime: item?.rule.kind === 'DAILY' ? item.rule.localTime : '09:00',
    dueAt: item?.rule.kind === 'REMINDER' ? toLocalInput(item.rule.dueAt) : '' })
  conversations.value = []
  conversationCursor.value = null
}

function editCommitment(item: Commitment) {
  openEditor('commitment')
  commitment.value = item
  Object.assign(form, { reason: '', dueAt: toLocalInput(item.dueAt), operation: 'DEFER' })
}

function close(feedback?: string) {
  const heading = editing.value === 'schedule' ? plansHeading : commitmentsHeading
  editing.value = undefined
  if (props.runId) emit('clear', feedback)
  else void nextTick(() => (trigger?.isConnected && !trigger.matches(':disabled') ? trigger : heading.value)?.focus())
}

function refreshDraft() {
  void run(async () => {
    await load()
    if (!active()) return
    if (schedule.value && editing.value === 'schedule') {
      const latest = schedules.value.find(({ id }) => id === schedule.value?.id)
      if (!latest) { error.value = '找不到此计划。'; return }
      schedule.value = latest
    }
    if (commitment.value && editing.value === 'commitment') {
      const latest = commitments.value.find(({ id }) => id === commitment.value?.id)
      if (!latest) { error.value = '找不到此承诺。'; return }
      commitment.value = latest
    }
    notice.value = '已更新版本，请与下方记录核对后提交。'
  })
}

function save() {
  if (!valid.value) return
  void run(async () => {
    if (editing.value === 'schedule') {
      const result = schedulePayload.value
      if (!result.success) return
      if (schedule.value) await command(base + '/schedules/' + schedule.value.id, result.data, 'PUT', schedule.value.version)
      else await command(base + '/schedules', result.data)
    } else {
      const result = commitmentPayload.value
      if (!result.success) return
      if (editing.value === 'new-commitment') await command(base + '/commitments', result.data)
      else if (commitment.value) await command(base + '/commitments/' + commitment.value.id, result.data, 'PUT', commitment.value.version)
      else return
    }
    if (!active()) return
    notice.value = editing.value === 'schedule' ? '计划已保存。' : '承诺已保存。'
    close(notice.value)
    if (!props.runId) await load()
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
      openEditor('new-commitment')
    } else error.value = '只有已确认模拟回执的运行可以登记承诺。'
  })
})
</script>

<template>
  <section class="console-workspace console-stack" aria-label="计划与承诺">
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <section v-if="editing" class="console-panel" aria-labelledby="plan-editor-heading">
      <div class="console-section-heading">
        <h3 id="plan-editor-heading" ref="editorHeading" tabindex="-1">{{ editing === 'schedule'
          ? (schedule ? '编辑模拟计划' : '新增模拟计划') : editing === 'new-commitment' ? '登记模拟承诺' : '处理模拟承诺' }}</h3>
      </div>
      <NForm @submit.prevent="save">
        <div v-if="editing === 'schedule'" class="console-form-grid">
          <template v-if="!schedule">
            <NFormItem label="计划标识" :label-props="{ for: 'plan-key' }" :validation-status="planKeyError ? 'error' : undefined">
              <NInput placeholder="例如：daily-check" v-model:value="form.key" maxlength="63" :disabled="busy"
                :input-props="{ id: 'plan-key', 'aria-invalid': planKeyError || undefined, 'aria-describedby': planKeyError ? 'plan-key-error' : undefined }" />
              <template v-if="planKeyError" #feedback><span id="plan-key-error">用小写字母或数字开头，可加短横线。</span></template>
            </NFormItem>
            <NFormItem label="模拟账号" :label-props="{ for: 'plan-account' }">
              <NSelect placeholder="选择用于运行计划的账号" filterable :value="form.accountId" :options="accountOptions" :disabled="busy"
                :input-props="{ id: 'plan-account' }" @update:value="selectAccount" />
            </NFormItem>
            <NFormItem label="会话" :label-props="{ for: 'plan-conversation' }">
              <NSelect placeholder="搜索联系人或选择会话" filterable v-model:value="form.conversationId" :disabled="busy || !form.accountId"
                :options="conversations.map(({ id, channel, contactLabel }) => ({
                  value: id, label: (contactLabel || (channel === 'PRIVATE' ? '私聊' : '公开会话')) + ' · ' + id.slice(0, 8),
                }))"
                :input-props="{ id: 'plan-conversation' }" />
            </NFormItem>
            <NButton v-if="conversationCursor" size="small" :disabled="busy" @click="run(() => loadConversations(true))">加载更多会话</NButton>
          </template>
          <NFormItem label="计划类型" :label-props="{ for: 'plan-kind' }">
            <NSelect placeholder="选择每日计划或单次提醒" filterable v-model:value="form.kind" :options="kinds" :disabled="busy" :input-props="{ id: 'plan-kind' }" />
          </NFormItem>
          <NFormItem label="时区" :label-props="{ for: 'plan-zone' }" :validation-status="invalidZone ? 'error' : undefined">
            <TimeZoneSelect v-model:value="form.zone" id="plan-zone" :disabled="busy" :invalid="invalidZone" />
            <template v-if="invalidZone" #feedback><span id="plan-zone-error">请选择可用的时区。</span></template>
          </NFormItem>
          <NFormItem v-if="form.kind === 'DAILY'" label="每天触发时间（计划时区）" :label-props="{ for: 'plan-time' }">
            <input id="plan-time" v-model="form.localTime" type="time" :disabled="busy" />
          </NFormItem>
          <NFormItem v-else :label="`提醒时间（${browserZone}）`" :label-props="{ for: 'plan-due' }">
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
              <NInput placeholder="例如：跟进模拟回复" v-model:value="form.title" maxlength="120" :disabled="busy" :input-props="{ id: 'commit-title' }" />
            </NFormItem>
            <NFormItem v-else label="处理方式" :label-props="{ for: 'commit-operation' }">
              <NSelect placeholder="选择承诺的处理方式" filterable v-model:value="form.operation" :options="operations" :disabled="busy" :input-props="{ id: 'commit-operation' }" />
            </NFormItem>
            <NFormItem v-if="editing === 'new-commitment' || form.operation === 'DEFER'"
              :label="`截止时间（${browserZone}）`" :label-props="{ for: 'commit-due' }">
              <input id="commit-due" v-model="form.dueAt" type="datetime-local" :disabled="busy" />
            </NFormItem>
            <NFormItem label="理由" :label-props="{ for: 'commit-reason' }">
              <NInput placeholder="例如：需要等待更多资料" v-model:value="form.reason" maxlength="240" :disabled="busy" :input-props="{ id: 'commit-reason' }" />
            </NFormItem>
          </div>
        </template>
        <div class="console-actions">
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !valid">{{ editing === 'schedule' ? '保存计划' : '保存承诺' }}</NButton>
          <NButton v-if="editing === 'commitment' || (editing === 'schedule' && schedule)" size="small" :disabled="busy"
            @click="refreshDraft">重新读取版本</NButton>
          <NButton :disabled="busy" @click="close()">取消</NButton>
        </div>
      </NForm>
    </section>
    <section class="console-panel" aria-labelledby="plans-heading">
      <div class="console-section-heading">
        <h3 id="plans-heading" ref="plansHeading" tabindex="-1">模拟计划</h3>
        <NButton size="small" :disabled="busy || !!editing || !accountOptions.length" @click="editSchedule()">新增计划</NButton>
      </div>
      <NSpin v-if="busy && !schedules.length && !editing" />
      <NEmpty v-else-if="!schedules.length && !error" description="暂无模拟计划。" />
      <ul v-if="schedules.length" class="console-record-list">
        <li v-for="item in schedules" :key="item.id">
          <div class="console-actions"><strong>{{ item.scheduleKey }}</strong><NTag size="small">{{ item.enabled ? '已启用' : '已暂停' }}</NTag>
            <NTag v-if="item.commitmentId" size="small">承诺提醒</NTag>
            <NButton v-else size="small" :disabled="busy || !!editing" @click="editSchedule(item)">编辑计划</NButton></div>
          <span>{{ accountName(item.accountId) }} · {{ item.zone }} · v{{ item.version }}</span>
          <span>{{ item.rule.kind === 'DAILY' ? '每天 ' + item.rule.localTime : '单次 ' + formatTime(item.rule.dueAt) }}
            <template v-if="item.nextAt"> · 下次 {{ formatTime(item.nextAt) }}</template></span>
        </li>
      </ul>
    </section>
    <section class="console-panel" aria-labelledby="commitments-heading">
      <div class="console-section-heading"><h3 id="commitments-heading" ref="commitmentsHeading" tabindex="-1">模拟承诺</h3></div>
      <NEmpty v-if="!commitments.length && !busy && !error" description="暂无模拟承诺。" />
      <ul v-if="commitments.length" class="console-record-list">
        <li v-for="item in commitments" :key="item.id">
          <div class="console-actions"><strong>{{ item.title }}</strong><NTag size="small">{{ stateLabels[item.state] }}</NTag>
            <NButton v-if="item.state === 'OPEN' || item.state === 'DEFERRED'" size="small" :disabled="busy || !!editing"
              @click="editCommitment(item)">处理承诺</NButton></div>
          <span>{{ accountName(item.accountId) }} · 截止 {{ formatTime(item.dueAt) }} · v{{ item.version }}</span>
          <span v-if="item.contactId">联系人 {{ item.contactId }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>
