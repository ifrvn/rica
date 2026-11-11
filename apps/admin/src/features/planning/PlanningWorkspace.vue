<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NSelect, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView } from '../../../../../packages/contracts/management.js'
import { scheduleUpdate, type scheduleView } from '../../../../../packages/contracts/schedules.js'
import { characterPath, formatTime, readAll, useConsoleTask } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'
import TimeZoneSelect from '../../shared/TimeZoneSelect.vue'
import CollaborativePlans from './CollaborativePlans.vue'
import CommitmentWorkspace from './CommitmentWorkspace.vue'

type Schedule = z.infer<typeof scheduleView>
type Account = z.infer<typeof accountView>
const props = defineProps<{ characterId: string; runId?: string }>()
const emit = defineEmits<{ expired: []; clear: [feedback?: string]; run: [id: string] }>()
const { busy, error, notice, active, run, command } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const schedules = ref<Schedule[]>([])
const accounts = ref<Account[]>([])
const zone = ref('UTC')
const schedule = ref<Schedule>()
const editorHeading = ref<HTMLElement>()
const plansHeading = ref<HTMLElement>()
let trigger: HTMLElement | undefined
const form = reactive({ zone: 'UTC', kind: 'DAILY' as Schedule['rule']['kind'], enabled: true, localTime: '09:00', dueAt: '' })
const kinds = [{ value: 'DAILY', label: '每日计划' }, { value: 'REMINDER', label: '单次提醒' }]
const dueAt = computed(() => {
  const date = new Date(form.dueAt)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
})
const payload = computed(() => scheduleUpdate.safeParse({
  zone: form.zone, enabled: form.enabled,
  rule: form.kind === 'DAILY' ? { kind: form.kind, localTime: form.localTime } : { kind: form.kind, dueAt: dueAt.value },
}))
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
  const [plans, bindings, workspace] = await Promise.all([
    readAll<Schedule>(base + '/schedules', active), readAll<Account>(base + '/accounts', active),
    request<z.infer<typeof characterWorkspaceView>>(base),
  ])
  if (!active()) return
  schedules.value = plans.filter((item) => !item.commitmentId)
  accounts.value = bindings
  zone.value = workspace.timezone
}

function editSchedule(item: Schedule) {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  schedule.value = item
  error.value = ''
  notice.value = ''
  Object.assign(form, { zone: item.zone, kind: item.rule.kind, enabled: item.enabled,
    localTime: item.rule.kind === 'DAILY' ? item.rule.localTime : '09:00',
    dueAt: item.rule.kind === 'REMINDER' ? toLocalInput(item.rule.dueAt) : '' })
  void nextTick(() => editorHeading.value?.focus())
}

function close() {
  schedule.value = undefined
  void nextTick(() => (trigger?.isConnected && !trigger.matches(':disabled') ? trigger : plansHeading.value)?.focus())
}

function refreshDraft() {
  void run(async () => {
    await load()
    if (!active() || !schedule.value) return
    const latest = schedules.value.find(({ id }) => id === schedule.value?.id)
    if (!latest) { error.value = '找不到此定时任务。'; return }
    schedule.value = latest
    notice.value = '已更新版本，请与下方记录核对后提交。'
  })
}

function save() {
  const result = payload.value
  const item = schedule.value
  if (!result.success || !item) return
  void run(async () => {
    await command(base + '/schedules/' + item.id, result.data, 'PUT', item.version)
    if (!active()) return
    notice.value = '定时任务已保存。'
    close()
    await load()
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <section class="console-workspace console-stack" aria-label="计划与承诺">
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <CollaborativePlans :character-id="characterId" :zone="zone" @expired="emit('expired')" @run="emit('run', $event)" />
    <CommitmentWorkspace :character-id="characterId" :run-id="runId" @expired="emit('expired')" @clear="emit('clear', $event)" />
    <section v-if="schedule" class="console-panel" aria-labelledby="plan-editor-heading">
      <div class="console-section-heading">
        <h3 id="plan-editor-heading" ref="editorHeading" tabindex="-1">编辑定时任务</h3>
      </div>
      <NForm @submit.prevent="save">
        <div class="console-form-grid">
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
          <NFormItem v-else :label="'提醒时间（' + browserZone + '）'" :label-props="{ for: 'plan-due' }">
            <input id="plan-due" v-model="form.dueAt" type="datetime-local" :disabled="busy" />
          </NFormItem>
          <NCheckbox v-model:checked="form.enabled" :disabled="busy">启用计划</NCheckbox>
        </div>
        <div class="console-actions">
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !payload.success">保存定时任务</NButton>
          <NButton size="small" :disabled="busy" @click="refreshDraft">重新读取版本</NButton>
          <NButton :disabled="busy" @click="close">取消</NButton>
        </div>
      </NForm>
    </section>
    <section v-if="schedules.length" class="console-panel" aria-labelledby="plans-heading">
      <div class="console-section-heading">
        <h3 id="plans-heading" ref="plansHeading" tabindex="-1">独立模拟定时任务</h3>
      </div>
      <ul class="console-record-list">
        <li v-for="item in schedules" :key="item.id">
          <div class="console-actions"><strong>{{ item.scheduleKey }}</strong>
            <NTag size="small">{{ item.enabled ? '已启用' : '已暂停' }}</NTag>
            <NButton size="small" :disabled="busy || !!schedule" @click="editSchedule(item)">编辑定时任务</NButton>
          </div>
          <span>{{ accountName(item.accountId) }} · {{ item.zone }} · v{{ item.version }}</span>
          <span>{{ item.rule.kind === 'DAILY' ? '每天 ' + item.rule.localTime : '单次 ' + formatTime(item.rule.dueAt) }}
            <template v-if="item.nextAt"> · 下次 {{ formatTime(item.nextAt) }}</template>
          </span>
        </li>
      </ul>
    </section>
  </section>
</template>
