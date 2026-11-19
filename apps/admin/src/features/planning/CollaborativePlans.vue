<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { UiAlert, UiButton, UiCheckbox, UiEmpty, UiField, UiDialog, UiSpinner, UiBadge } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, identityView } from '@ricajs/contracts/management'
import { planInput, type planView } from '@ricajs/contracts/plans'
import { characterPath, formatTime, readAll, useConsoleTask } from '@ricajs/console-shared/console-data'
import TimeZoneSelect from '../../shared/TimeZoneSelect.vue'

type Plan = z.infer<typeof planView>
type Identity = z.infer<typeof identityView>
type Account = z.infer<typeof accountView>
const props = defineProps<{ characterId: string; zone: string }>()
const emit = defineEmits<{ expired: []; run: [id: string] }>()
const { active, busy, error, notice, run, command } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const path = base + '/plans'
const plans = ref<Plan[]>([])
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const editor = ref<{ plan?: Plan; reminder?: boolean }>()
const titleField = ref<{ focus: () => void }>()
const heading = ref<HTMLElement>()
const checked = ref<string[]>([])
const tasks = ref<Record<string, string>>({})
const reminderAccountId = ref('')
const reminderTask = ref('')
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const form = reactive({ title: '', date: '', time: '09:00', zone: 'UTC', enabled: true })
let trigger: HTMLElement | undefined

const byIdentity = computed(() => new Map(accounts.value.filter(({ status }) => status !== 'REVOKED')
  .map((account) => [account.identityId, account])))
const byAccount = computed(() => new Map(accounts.value.filter(({ status }) => status !== 'REVOKED')
  .map((account) => [account.id, account])))
const currentBinding = ({ identityId, accountId }: Pick<Plan['participants'][number], 'identityId' | 'accountId'>) =>
  byAccount.value.get(accountId)?.identityId === identityId
const editorAccounts = computed(() => {
  const choices = new Map(byIdentity.value)
  for (const participant of editor.value?.plan?.participants ?? []) {
    if (currentBinding(participant)) choices.set(participant.identityId, byAccount.value.get(participant.accountId)!)
  }
  return choices
})
const identityName = (id: string) => {
  const item = identities.value.find((identity) => identity.id === id)
  return item?.profile?.displayName || item?.slug || id
}
const accountName = (account: Account) => {
  const ambiguous = accounts.value.some(({ id, identityId, platform, instanceKey }) =>
    id !== account.id && identityId === account.identityId && platform === account.platform && instanceKey === account.instanceKey)
  return account.instanceKey + (ambiguous ? ' · ' + account.id.slice(0, 8) : '')
}
const usesSimulation = (platform: string) => platform === 'mock-a' || platform === 'mock-b'
const available = computed(() => identities.value.some(({ id }) => byIdentity.value.has(id)))
const reminderAccounts = computed(() => {
  const readyIdentities = new Set(identities.value.filter(({ status }) => status === 'ACTIVE').map(({ id }) => id))
  return accounts.value.filter(({ identityId, status, platform }) =>
    readyIdentities.has(identityId) && status === 'ACTIVE' && usesSimulation(platform))
})
const selectedReminder = computed(() => reminderAccounts.value.find(({ id }) => id === reminderAccountId.value))
const staleBindings = computed(() => editor.value?.plan?.participants.some((participant) => !currentBinding(participant)))
const due = computed(() => {
  const value = new Date(form.date + 'T' + form.time)
  if (Number.isFinite(value.getTime()) && localDate(value) === form.date + 'T' + form.time) return value
})
const payload = computed(() => {
  const reminder = selectedReminder.value
  const participants = editor.value?.reminder ? (reminder ? [{
    identityId: reminder.identityId, accountId: reminder.id, task: reminderTask.value,
  }] : []) : identities.value.flatMap(({ id }) => {
    const account = editorAccounts.value.get(id)
    return account && checked.value.includes(id) ? [{ identityId: id, accountId: account.id, task: tasks.value[id] ?? '' }] : []
  })
  return planInput.safeParse({
    title: form.title, enabled: form.enabled, zone: form.date ? browserZone : form.zone,
    rule: form.date || editor.value?.reminder
      ? { kind: 'REMINDER', dueAt: due.value?.toISOString() ?? '' } : { kind: 'DAILY', localTime: form.time },
    participants,
  })
})

function localDate(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function load() {
  const [rows, names, bindings] = await Promise.all([
    readAll<Plan>(path, active), readAll<Identity>(base + '/identities', active), readAll<Account>(base + '/accounts', active),
  ])
  if (!active()) return
  const previous = editorAccounts.value
  plans.value = rows
  identities.value = names
  accounts.value = bindings
  checked.value = checked.value.filter((id) => previous.get(id)?.id === editorAccounts.value.get(id)?.id)
}

function open(item?: Plan, singleReminder = false) {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  error.value = ''
  notice.value = ''
  const reminder = item?.rule.kind === 'REMINDER' ? localDate(new Date(item.rule.dueAt)) : ''
  Object.assign(form, { title: item?.title ?? '', date: reminder.slice(0, 10), enabled: item?.enabled ?? true,
    time: item?.rule.kind === 'DAILY' ? item.rule.localTime : reminder.slice(11) || '09:00', zone: item?.zone ?? props.zone })
  checked.value = item?.participants.filter(currentBinding).map(({ identityId }) => identityId) ?? []
  tasks.value = Object.fromEntries(item?.participants.map(({ identityId, task }) => [identityId, task]) ?? [])
  reminderAccountId.value = ''
  reminderTask.value = ''
  editor.value = { plan: item, reminder: singleReminder }
  void nextTick(() => titleField.value?.focus())
}

function close() {
  editor.value = undefined
  error.value = ''
  void nextTick(() => (trigger?.isConnected ? trigger : heading.value)?.focus())
}

function save() {
  if (editor.value?.reminder && (!due.value || due.value.getTime() <= Date.now())) {
    error.value = '请选择将来的提醒时间。'
    return
  }
  if (!payload.value.success || !editor.value) {
    error.value = editor.value?.reminder ? '请填写名称、提醒事项并选择执行身份。' : '请填写名称和有效的触发时间，并为每个已勾选身份填写执行事项。'
    return
  }
  const input = payload.value.data
  const { plan, reminder } = editor.value
  void run(async () => {
    if (plan) await command(path + '/' + plan.id, input, 'PUT', plan.version)
    else await command(path, input)
    if (!active()) return
    close()
    notice.value = plan ? '计划已更新。' : reminder ? '单次模拟提醒已创建。' : '计划已创建。'
    await load()
  })
}

function refreshEditor() {
  const id = editor.value?.plan?.id
  if (!id) return
  void run(async () => {
    await load()
    const latest = plans.value.find((item) => item.id === id)
    if (!latest) { error.value = '找不到此计划。'; return }
    const previous = editorAccounts.value
    editor.value = { plan: latest }
    checked.value = checked.value.filter((identityId) => previous.get(identityId)?.id === editorAccounts.value.get(identityId)?.id)
    notice.value = '已读取最新版本。请确认当前输入后再保存。'
  })
}

function toggle(item: Plan) {
  void run(async () => {
    await command(path + '/' + item.id + '/state', { enabled: !item.enabled }, 'PUT', item.version)
    if (!active()) return
    notice.value = item.enabled ? '计划已暂停。' : '计划已恢复。'
    await load()
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <section class="console-record-workspace" aria-labelledby="collaborative-plans-heading">
    <div class="console-section-heading">
      <h3 id="collaborative-plans-heading" ref="heading" tabindex="-1">计划</h3>
      <div class="console-actions">
        <UiButton size="small" variant="quiet" :disabled="busy" @click="run(load)">刷新计划</UiButton>
        <UiButton size="small" :tone="reminderAccounts.length ? 'default' : 'primary'" :disabled="busy || !available" @click="open()">新建计划</UiButton>
        <UiButton v-if="reminderAccounts.length" size="small" tone="primary" :disabled="busy" @click="open(undefined, true)">新建单次提醒</UiButton>
      </div>
    </div>
    <UiAlert v-if="error && !editor" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="notice && !editor" tone="success" role="status">{{ notice }}</UiAlert>
    <UiSpinner v-if="busy && !plans.length" aria-label="正在读取计划" />
    <UiEmpty v-else-if="!plans.length && !error" :description="available ? '暂无计划。' : '先为至少一个身份关联平台账号，再新建计划。'" />
    <ul v-else-if="plans.length" class="plan-list">
      <li v-for="item in plans" :key="item.id">
        <div class="plan-title">
          <h4>{{ item.title }}</h4>
          <div class="console-actions">
            <UiBadge :tone="item.source === 'AI' ? 'info' : 'default'">
              {{ item.source === 'AI' ? 'AI 自主设定' : '人工创建' }}
            </UiBadge>
            <UiBadge v-if="item.humanEdited">已人工编辑</UiBadge>
            <UiBadge :tone="item.enabled ? 'success' : 'default'">{{ item.enabled ? '已启用' : '已暂停' }}</UiBadge>
          </div>
        </div>
        <p class="plan-muted">{{ item.rule.kind === 'DAILY' ? '每天 ' + item.rule.localTime + ' · ' + item.zone : '单次 · ' + formatTime(item.rule.dueAt) }}</p>
        <ul class="plan-tasks" aria-label="参与身份和平台">
          <li v-for="target in item.participants" :key="target.accountId">
            <div class="console-actions">
              <strong>{{ identityName(target.identityId) }} / {{ target.platform }}</strong>
              <small v-if="currentBinding(target)" class="plan-muted">{{ accountName(byAccount.get(target.accountId)!) }}</small>
              <small v-if="!currentBinding(target)" class="plan-muted">账号绑定已变化</small>
              <small v-else-if="target.accountStatus !== 'ACTIVE'" class="plan-muted">账号待启用</small>
              <small v-else-if="!usesSimulation(target.platform)" class="plan-muted">人工执行</small>
              <small v-else-if="item.enabled && target.nextAt" class="plan-muted">下次 {{ formatTime(target.nextAt) }}</small>
            </div>
            <p>{{ target.task }}</p>
            <UiButton v-if="target.lastRunId" size="small" variant="text" @click="emit('run', target.lastRunId)">查看最近运行</UiButton>
          </li>
        </ul>
        <div class="console-actions">
          <UiButton size="small" :disabled="busy" @click="open(item)">编辑计划</UiButton>
          <UiButton size="small" variant="soft" :tone="item.enabled ? 'warning' : 'default'"
            :disabled="busy || (!item.enabled && item.participants.some(target => !currentBinding(target)))"
            @click="toggle(item)">{{ item.enabled ? '暂停计划' : '恢复计划' }}</UiButton>
        </div>
      </li>
    </ul>
  </section>

  <UiDialog :open="!!editor" :title="editor?.plan ? '编辑计划' : editor?.reminder ? '新建单次模拟提醒' : '新建计划'"
    style="width: 36rem; max-width: calc(100% - 2rem)" :dismiss-outside="!busy" :busy="busy"
    @update:open="!$event && close()">
    <form v-if="editor" class="plan-editor" @submit.prevent="save">
      <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
      <UiAlert v-if="notice" tone="info" role="status">{{ notice }}</UiAlert>
      <UiField :label="editor.reminder ? '提醒名称' : '名称'" for="collaborative-plan-title">
        <input class="ui-control" ref="titleField" v-model="form.title" :maxlength="72" :disabled="busy"
          v-bind="{ id: 'collaborative-plan-title', required: true }" />
      </UiField>
      <div class="console-form-grid plan-time">
        <UiField :label="'触发时间（' + (form.date || editor.reminder ? browserZone : form.zone) + '）'" for="collaborative-plan-time">
          <input id="collaborative-plan-time" v-model="form.time" type="time" :disabled="busy" required />
        </UiField>
        <UiField :label="editor.reminder ? '触发日期' : '触发日期（留空则每天）'" for="collaborative-plan-date">
          <input id="collaborative-plan-date" v-model="form.date" type="date" :required="editor.reminder" :disabled="busy" />
        </UiField>
      </div>
      <UiField v-if="!form.date && !editor.reminder" label="时区" for="collaborative-plan-zone">
        <TimeZoneSelect v-model:value="form.zone" id="collaborative-plan-zone" :disabled="busy" />
      </UiField>
      <template v-if="editor.reminder">
        <UiField label="执行身份与模拟账号" for="plan-reminder-account">
          <select id="plan-reminder-account" v-model="reminderAccountId" required :disabled="busy">
            <option disabled value="">选择模拟账号</option>
            <option v-for="account in reminderAccounts" :key="account.id" :value="account.id">
              {{ identityName(account.identityId) }} · {{ account.platform }} · {{ accountName(account) }}
            </option>
          </select>
        </UiField>
        <UiField label="提醒事项" for="plan-reminder-task">
          <textarea id="plan-reminder-task" class="ui-control" v-model="reminderTask" rows="2" maxlength="300" required :disabled="busy"></textarea>
        </UiField>
        <p class="plan-muted">到时启动一次模拟运行。静默时段内，提醒会延后到下一次可运行时间。</p>
      </template>
      <fieldset v-else class="plan-participants">
        <legend>参与身份和平台</legend>
        <p class="plan-muted">模拟账号会在触发时间准备运行上下文。标为人工执行的事项由人工跟进。</p>
        <p v-if="staleBindings" class="plan-muted">原有账号绑定已变化，请重新勾选当前平台账号。</p>
        <div v-for="identity in identities" :key="identity.id" class="plan-participant">
          <UiCheckbox :model-value="checked.includes(identity.id)" :disabled="busy || !editorAccounts.has(identity.id)"
            :aria-disabled="busy || !editorAccounts.has(identity.id)"
            @update:model-value="value => { checked = value ? [...checked, identity.id] : checked.filter(id => id !== identity.id) }">
            {{ identityName(identity.id) }} · {{ editorAccounts.get(identity.id)?.platform ?? '未绑定平台' }}
            <template v-if="editorAccounts.has(identity.id)"> · {{ accountName(editorAccounts.get(identity.id)!) }}</template>
            <template v-if="editorAccounts.has(identity.id) && !usesSimulation(editorAccounts.get(identity.id)!.platform)"> · 人工执行</template>
          </UiCheckbox>
          <UiField v-if="checked.includes(identity.id)" :label="identityName(identity.id) + '的执行事项'"
            :for="'plan-task-' + identity.id">
            <textarea class="ui-control" v-model="tasks[identity.id]" :rows="2" :maxlength="300" :disabled="busy"
              v-bind="{ id: 'plan-task-' + identity.id, required: true }"></textarea>
          </UiField>
        </div>
      </fieldset>
      <div class="console-actions">
        <UiButton tone="primary" type="submit" :loading="busy">{{ editor.reminder ? '创建提醒' : '保存计划' }}</UiButton>
        <UiButton v-if="error && editor.plan" size="small" :disabled="busy" @click="refreshEditor">重新读取版本</UiButton>
        <UiButton :disabled="busy" @click="close">取消</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.plan-list, .plan-tasks { list-style: none; padding: 0; margin: 0; }
.plan-list > li { display: grid; gap: .75rem; padding: 1rem .25rem; border-top: 1px solid var(--console-line); }
.plan-title { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
.plan-title h4, .plan-muted, .plan-tasks p { margin: 0; }
.plan-muted { color: var(--console-muted); font-size: .875rem; }
.plan-tasks { display: grid; gap: .625rem; overflow-wrap: anywhere; }
.plan-tasks li { display: grid; gap: .25rem; justify-items: start; background: var(--console-hover); padding: .625rem .75rem; border-radius: 4px; }
.plan-tasks p { white-space: pre-wrap; }
.plan-editor { display: grid; gap: .875rem; }
.plan-time { gap: .875rem; }
.plan-participants { min-width: 0; margin: 0; padding: .5rem .75rem; border: 1px solid var(--console-line); border-radius: 5px; }
.plan-participant { display: grid; gap: .5rem; padding: .5rem 0; }
.plan-participant + .plan-participant { border-top: 1px solid var(--console-line); }
</style>
