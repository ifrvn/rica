<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NEmpty, NForm, NFormItem, NInput, NModal, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, identityView } from '../../../../../packages/contracts/management.js'
import { planInput, type planView } from '../../../../../packages/contracts/plans.js'
import { characterPath, formatTime, readAll, useConsoleTask } from '../../shared/console-data.js'
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
const editor = ref<{ plan?: Plan }>()
const titleField = ref<{ focus: () => void }>()
const heading = ref<HTMLElement>()
const checked = ref<string[]>([])
const tasks = ref<Record<string, string>>({})
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const form = reactive({ title: '', date: '', time: '09:00', zone: 'UTC', enabled: true })
let trigger: HTMLElement | undefined

const byIdentity = computed(() => new Map(accounts.value.filter(({ status }) => status !== 'REVOKED')
  .map((account) => [account.identityId, account])))
const identityName = (id: string) => {
  const item = identities.value.find((identity) => identity.id === id)
  return item?.profile?.displayName || item?.slug || id
}
const usesSimulation = (platform: string) => platform === 'mock-a' || platform === 'mock-b'
const available = computed(() => identities.value.some(({ id }) => byIdentity.value.has(id)))
const staleBindings = computed(() => editor.value?.plan?.participants.some(({ identityId, accountId }) => byIdentity.value.get(identityId)?.id !== accountId))
const payload = computed(() => {
  const due = new Date(form.date + 'T' + form.time)
  const validDate = Number.isFinite(due.getTime()) && localDate(due) === form.date + 'T' + form.time
  return planInput.safeParse({
    title: form.title, enabled: form.enabled, zone: form.date ? browserZone : form.zone,
    rule: form.date ? { kind: 'REMINDER', dueAt: validDate ? due.toISOString() : '' } : { kind: 'DAILY', localTime: form.time },
    participants: identities.value.flatMap(({ id }) => {
      const account = byIdentity.value.get(id)
      return account && checked.value.includes(id) ? [{ identityId: id, accountId: account.id, task: tasks.value[id] ?? '' }] : []
    }),
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
  const previous = byIdentity.value
  plans.value = rows
  identities.value = names
  accounts.value = bindings
  checked.value = checked.value.filter((id) => previous.get(id)?.id === byIdentity.value.get(id)?.id)
}

function open(item?: Plan) {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  error.value = ''
  notice.value = ''
  const reminder = item?.rule.kind === 'REMINDER' ? localDate(new Date(item.rule.dueAt)) : ''
  Object.assign(form, { title: item?.title ?? '', date: reminder.slice(0, 10), enabled: item?.enabled ?? true,
    time: item?.rule.kind === 'DAILY' ? item.rule.localTime : reminder.slice(11) || '09:00', zone: item?.zone ?? props.zone })
  checked.value = item?.participants.filter(({ identityId, accountId }) => byIdentity.value.get(identityId)?.id === accountId)
    .map(({ identityId }) => identityId) ?? []
  tasks.value = Object.fromEntries(item?.participants.map(({ identityId, task }) => [identityId, task]) ?? [])
  editor.value = { plan: item }
  void nextTick(() => titleField.value?.focus())
}

function close() {
  editor.value = undefined
  error.value = ''
  void nextTick(() => (trigger?.isConnected ? trigger : heading.value)?.focus())
}

function save() {
  if (!payload.value.success || !editor.value) {
    error.value = '请填写名称和有效的触发时间，并为每个已勾选身份填写执行事项。'
    return
  }
  const input = payload.value.data
  const plan = editor.value.plan
  void run(async () => {
    if (plan) await command(path + '/' + plan.id, input, 'PUT', plan.version)
    else await command(path, input)
    if (!active()) return
    close()
    notice.value = plan ? '计划已更新。' : '计划已创建。'
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
    editor.value = { plan: latest }
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
        <NButton size="small" quaternary :disabled="busy" @click="run(load)">刷新计划</NButton>
        <NButton size="small" type="primary" :disabled="busy || !available" @click="open()">新建计划</NButton>
      </div>
    </div>
    <NAlert v-if="error && !editor" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice && !editor" type="success" role="status">{{ notice }}</NAlert>
    <NSpin v-if="busy && !plans.length" aria-label="正在读取计划" />
    <NEmpty v-else-if="!plans.length && !error" :description="available ? '暂无计划。' : '先为至少一个身份关联平台账号，再新建计划。'" />
    <ul v-else-if="plans.length" class="plan-list">
      <li v-for="item in plans" :key="item.id">
        <div class="plan-title">
          <h4>{{ item.title }}</h4>
          <div class="console-actions">
            <NTag size="small" :type="item.source === 'AI' ? 'info' : 'default'" :bordered="false">
              {{ item.source === 'AI' ? 'AI 自主设定' : '人工创建' }}
            </NTag>
            <NTag v-if="item.humanEdited" size="small" :bordered="false">已人工编辑</NTag>
            <NTag size="small" :type="item.enabled ? 'success' : 'default'" :bordered="false">{{ item.enabled ? '已启用' : '已暂停' }}</NTag>
          </div>
        </div>
        <p class="plan-muted">{{ item.rule.kind === 'DAILY' ? '每天 ' + item.rule.localTime + ' · ' + item.zone : '单次 · ' + formatTime(item.rule.dueAt) }}</p>
        <ul class="plan-tasks" aria-label="参与身份和平台">
          <li v-for="target in item.participants" :key="target.accountId">
            <div class="console-actions">
              <strong>{{ identityName(target.identityId) }} / {{ target.platform }}</strong>
              <small v-if="byIdentity.get(target.identityId)?.id !== target.accountId" class="plan-muted">账号绑定已变化</small>
              <small v-else-if="target.accountStatus !== 'ACTIVE'" class="plan-muted">账号待启用</small>
              <small v-else-if="!usesSimulation(target.platform)" class="plan-muted">人工执行</small>
              <small v-else-if="item.enabled && target.nextAt" class="plan-muted">下次 {{ formatTime(target.nextAt) }}</small>
            </div>
            <p>{{ target.task }}</p>
            <NButton v-if="target.lastRunId" size="small" text @click="emit('run', target.lastRunId)">查看最近运行</NButton>
          </li>
        </ul>
        <div class="console-actions">
          <NButton size="small" :disabled="busy" @click="open(item)">编辑计划</NButton>
          <NButton size="small" secondary :type="item.enabled ? 'warning' : 'default'"
            :disabled="busy || (!item.enabled && item.participants.some(target => byIdentity.get(target.identityId)?.id !== target.accountId))"
            @click="toggle(item)">{{ item.enabled ? '暂停计划' : '恢复计划' }}</NButton>
        </div>
      </li>
    </ul>
  </section>

  <NModal :show="!!editor" preset="card" :title="editor?.plan ? '编辑计划' : '新建计划'"
    :aria-label="editor?.plan ? '编辑计划' : '新建计划'"
    style="width: 36rem; max-width: calc(100% - 2rem)" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy"
    @update:show="!$event && close()">
    <NForm v-if="editor" class="plan-editor" :show-feedback="false" @submit.prevent="save">
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NAlert v-if="notice" type="info" role="status">{{ notice }}</NAlert>
      <NFormItem label="名称" :label-props="{ for: 'collaborative-plan-title' }">
        <NInput ref="titleField" v-model:value="form.title" :maxlength="72" :disabled="busy"
          :input-props="{ id: 'collaborative-plan-title', required: true }" />
      </NFormItem>
      <div class="console-form-grid plan-time">
        <NFormItem :label="'触发时间（' + (form.date ? browserZone : form.zone) + '）'" :label-props="{ for: 'collaborative-plan-time' }">
          <input id="collaborative-plan-time" v-model="form.time" type="time" :disabled="busy" required />
        </NFormItem>
        <NFormItem label="触发日期（留空则每天）" :label-props="{ for: 'collaborative-plan-date' }">
          <input id="collaborative-plan-date" v-model="form.date" type="date" :disabled="busy" />
        </NFormItem>
      </div>
      <NFormItem v-if="!form.date" label="时区" :label-props="{ for: 'collaborative-plan-zone' }">
        <TimeZoneSelect v-model:value="form.zone" id="collaborative-plan-zone" :disabled="busy" />
      </NFormItem>
      <fieldset class="plan-participants">
        <legend>参与身份和平台</legend>
        <p class="plan-muted">模拟账号会在触发时间准备运行上下文。标为人工执行的事项由人工跟进。</p>
        <p v-if="staleBindings" class="plan-muted">原有账号绑定已变化，请重新勾选当前平台账号。</p>
        <div v-for="identity in identities" :key="identity.id" class="plan-participant">
          <NCheckbox :checked="checked.includes(identity.id)" :disabled="busy || !byIdentity.has(identity.id)"
            :aria-disabled="busy || !byIdentity.has(identity.id)"
            @update:checked="value => { checked = value ? [...checked, identity.id] : checked.filter(id => id !== identity.id) }">
            {{ identityName(identity.id) }} · {{ byIdentity.get(identity.id)?.platform ?? '未绑定平台' }}
            <template v-if="byIdentity.has(identity.id) && !usesSimulation(byIdentity.get(identity.id)!.platform)"> · 人工执行</template>
          </NCheckbox>
          <NFormItem v-if="checked.includes(identity.id)" :label="identityName(identity.id) + '的执行事项'"
            :label-props="{ for: 'plan-task-' + identity.id }">
            <NInput v-model:value="tasks[identity.id]" type="textarea" :rows="2" :maxlength="300" :disabled="busy"
              :input-props="{ id: 'plan-task-' + identity.id, required: true }" />
          </NFormItem>
        </div>
      </fieldset>
      <div class="console-actions">
        <NButton type="primary" attr-type="submit" :loading="busy">保存计划</NButton>
        <NButton v-if="error && editor.plan" size="small" :disabled="busy" @click="refreshEditor">重新读取版本</NButton>
        <NButton :disabled="busy" @click="close">取消</NButton>
      </div>
    </NForm>
  </NModal>
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
