<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NInputNumber, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { beliefSummary, beliefView, contactBoundaryView, contactSummary, dailyEnergyView, identityReflectionView, manualGoalView } from '../../packages/contracts/management.js'
import { characterPath, formatTime, queryPath, useConsoleTask, utcToday, type Page } from './console-data.js'
import { request, RequestError } from './request.js'

type Goal = z.infer<typeof manualGoalView>
type Belief = z.infer<typeof beliefView>
type BeliefRow = z.infer<typeof beliefSummary>
type Contact = z.infer<typeof contactSummary>
type Boundary = z.infer<typeof contactBoundaryView>
type Reflection = z.infer<typeof identityReflectionView>
type Energy = z.infer<typeof dailyEnergyView>
const props = defineProps<{ characterId: string; identityId: string; canEdit: boolean }>()
const emit = defineEmits<{ expired: [] }>()
const { busy, error, notice, active, run, command } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const identity = base + '/identities/' + props.identityId
const goals = ref<Goal[]>([])
const beliefs = ref<BeliefRow[]>([])
const contacts = ref<Contact[]>([])
const beliefCursor = ref<string | null>(null)
const contactCursor = ref<string | null>(null)
const date = ref(utcToday())
const shownDate = ref('')
const reflection = ref<Reflection | null>(null)
const energy = ref<Energy | null>(null)
const belief = ref<Belief>()
const historical = ref<Belief>()
const restoreVersion = ref<number | null>(null)
const restoreReason = ref('')
const contact = ref<Boundary>()
const contactLabel = ref('')
const boundaryReason = ref('')
const goalStatus: Record<Goal['status'], string> = {
  DRAFT: '草稿', ACTIVE: '进行中', PAUSED: '已暂停', DONE: '已完成', CANCELED: '已取消', EXPIRED: '已到期',
}
const beliefStatus: Record<Belief['status'], string> = {
  PENDING: '待核验', ACTIVE: '有效', DISPUTED: '有争议', INVALIDATED: '已失效',
}
const energyLabels: Record<Energy['energy'], string> = { LOW: '低', NORMAL: '正常', HIGH: '高' }

async function optional<T>(path: string) {
  try { return await request<T>(path) }
  catch (cause) {
    if (cause instanceof RequestError && cause.status === 404) return null
    throw cause
  }
}

async function loadDay() {
  if (!date.value) return
  const day = date.value
  const [record, level] = await Promise.all([
    optional<Reflection>(identity + '/reflections/' + day), optional<Energy>(base + '/daily-energy/' + day),
  ])
  if (!active()) return
  shownDate.value = day
  reflection.value = record
  energy.value = level
}

async function loadBeliefs(append = false) {
  const page = await request<Page<BeliefRow>>(queryPath(identity + '/beliefs', { cursor: append ? beliefCursor.value : null }))
  if (!active()) return
  beliefs.value = append ? [...beliefs.value, ...page.items] : page.items
  beliefCursor.value = page.nextCursor
}

async function loadContacts(append = false) {
  const page = await request<Page<Contact>>(queryPath(identity + '/contacts', { cursor: append ? contactCursor.value : null }))
  if (!active()) return
  contacts.value = append ? [...contacts.value, ...page.items] : page.items
  contactCursor.value = page.nextCursor
}

async function readBelief(id: string) {
  const result = await request<Belief>(identity + '/beliefs/' + id)
  if (active()) belief.value = result
}

function openBelief(id: string) {
  belief.value = undefined
  historical.value = undefined
  restoreReason.value = ''
  restoreVersion.value = null
  void run(() => readBelief(id))
}

function readHistory() {
  const current = belief.value
  const version = restoreVersion.value
  if (!current || !version || version >= current.version) return
  historical.value = undefined
  void run(async () => {
    const result = await request<Belief>(queryPath(identity + '/beliefs/' + current.id, { revision: String(version) }))
    if (active()) historical.value = result
  })
}

function restore() {
  const current = belief.value
  const revision = historical.value
  if (!props.canEdit || !current || !revision?.statement || !restoreReason.value.trim()) return
  void run(async () => {
    await command(identity + '/beliefs/' + current.id + '/restore',
      { restoreVersion: revision.version, reason: restoreReason.value.trim() }, 'POST', current.version)
    if (!active()) return
    historical.value = undefined
    restoreVersion.value = null
    restoreReason.value = ''
    notice.value = '观点已追加恢复版本。'
    await Promise.all([readBelief(current.id), loadBeliefs()])
  })
}

async function readBoundary(id: string) {
  const result = await request<Boundary>(base + '/contacts/' + id + '/boundary')
  if (active()) contact.value = result
}

function openContact(row: Contact) {
  contact.value = undefined
  contactLabel.value = row.label ?? row.id
  boundaryReason.value = ''
  void run(() => readBoundary(row.id))
}

function saveBoundary() {
  const current = contact.value
  if (!props.canEdit || !current || !boundaryReason.value.trim()) return
  void run(async () => {
    await command(base + '/contacts/' + current.id + '/boundary',
      { blocked: !current.blocked, reason: boundaryReason.value.trim() }, 'PUT', current.version)
    if (!active()) return
    boundaryReason.value = ''
    notice.value = '联系边界已更新。'
    await Promise.all([readBoundary(current.id), loadContacts()])
  })
}

onMounted(() => {
  void run(async () => {
    await Promise.all([
      request<Goal[]>(identity + '/goals').then((rows) => { if (active()) goals.value = rows }),
      loadDay(), loadBeliefs(), loadContacts(),
    ])
  })
})
</script>

<template>
  <section class="console-stack" aria-label="所选身份的成长记录">
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NSpin v-if="busy && !shownDate" />
    <section class="console-panel" aria-labelledby="growth-reflection-heading">
      <div class="console-section-heading"><h3 id="growth-reflection-heading">反思与精力</h3></div>
      <NForm @submit.prevent="run(loadDay)">
        <div class="console-form-grid">
          <NFormItem label="日期（UTC）" :label-props="{ for: 'growth-day' }">
            <input id="growth-day" v-model="date" type="date" :disabled="busy" />
          </NFormItem>
        </div>
        <NButton size="small" attr-type="submit" :disabled="busy || !date">查看当天</NButton>
      </NForm>
      <ul v-if="shownDate" class="console-record-list">
        <li><strong>{{ shownDate }} · 角色精力</strong><span>{{ energy ? energyLabels[energy.energy] : '暂无已批准记录' }}</span></li>
        <li><strong>身份反思</strong>
          <span v-if="reflection">模拟回执 {{ reflection.observedActivity.simulatedReceipts }} ·
            未核实入站 {{ reflection.unverifiedExternal.inboundMessages }}</span>
          <span v-else>暂无反思记录。</span>
          <NButton v-if="reflection?.candidateBeliefId" size="small" :disabled="busy"
            @click="openBelief(reflection.candidateBeliefId)">查看反思产生的候选观点</NButton>
        </li>
      </ul>
    </section>
    <section class="console-panel" aria-labelledby="growth-goals-heading">
      <div class="console-section-heading"><h3 id="growth-goals-heading">目标</h3></div>
      <NEmpty v-if="!goals.length && !busy && !error" description="暂无目标。" />
      <ul v-if="goals.length" class="console-record-list">
        <li v-for="goal in goals" :key="goal.id">
          <div class="console-actions"><strong>{{ goal.title }}</strong><NTag size="small">{{ goalStatus[goal.status] }}</NTag>
            <NTag size="small">{{ goal.origin === 'SELF' ? '自主' : '管理员' }}</NTag></div>
          <span>优先级 {{ goal.priority }} · 预算 {{ goal.budget }} · 截止 {{ formatTime(goal.dueAt) }}</span>
          <span v-if="goal.nextStep">{{ goal.nextStep }}</span>
        </li>
      </ul>
    </section>
    <section class="console-panel" aria-labelledby="growth-beliefs-heading">
      <div class="console-section-heading"><h3 id="growth-beliefs-heading">观点与偏好</h3></div>
      <NEmpty v-if="!beliefs.length && !busy && !error" description="暂无观点或偏好。" />
      <ul v-if="beliefs.length" class="console-record-list">
        <li v-for="item in beliefs" :key="item.id">
          <div class="console-actions">
            <NButton size="small" :disabled="busy" @click="openBelief(item.id)">{{ item.kind === 'OPINION' ? '观点' : '偏好' }} {{ item.id.slice(0, 8) }}</NButton>
            <NTag size="small">v{{ item.version }}</NTag>
          </div>
        </li>
      </ul>
      <NButton v-if="beliefCursor" size="small" :disabled="busy" @click="run(() => loadBeliefs(true))">加载更多观点</NButton>
      <template v-if="belief">
        <h4>观点详情</h4>
        <p>v{{ belief.version }} · {{ beliefStatus[belief.status] }}<template v-if="belief.confidence !== null">
          · 置信度 {{ Math.round(belief.confidence * 100) }}%</template></p>
        <p>{{ belief.statement ?? '观点内容当前不可用。' }}</p>
        <NForm v-if="canEdit && belief.version > 1" @submit.prevent="restore">
          <NFormItem label="历史版本" :label-props="{ for: 'belief-version' }">
            <NInputNumber v-model:value="restoreVersion" :min="1" :max="belief.version - 1" :precision="0"
              :disabled="busy" :input-props="{ id: 'belief-version' }" @update:value="historical = undefined" />
          </NFormItem>
          <div class="console-actions">
            <NButton size="small" :disabled="busy || !restoreVersion" @click="readHistory">查看历史版本</NButton>
            <NButton size="small" :disabled="busy" @click="run(() => readBelief(belief!.id))">重新读取当前版本</NButton>
          </div>
          <template v-if="historical">
            <p>v{{ historical.version }} · {{ historical.statement ?? '此版本内容当前不可用。' }}</p>
            <NFormItem label="恢复理由" :label-props="{ for: 'belief-reason' }">
              <NInput v-model:value="restoreReason" maxlength="240" :disabled="busy" :input-props="{ id: 'belief-reason' }" />
            </NFormItem>
            <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!historical.statement || !restoreReason.trim()">追加恢复版本</NButton>
          </template>
        </NForm>
      </template>
    </section>
    <section class="console-panel" aria-labelledby="growth-boundaries-heading">
      <div class="console-section-heading"><h3 id="growth-boundaries-heading">联系边界</h3></div>
      <NEmpty v-if="!contacts.length && !busy && !error" description="暂无联系人。" />
      <ul v-if="contacts.length" class="console-record-list">
        <li v-for="item in contacts" :key="item.id">
          <div class="console-actions">
            <NButton size="small" :disabled="busy" @click="openContact(item)">{{ item.label ?? item.id.slice(0, 8) }}</NButton>
            <NTag size="small">{{ item.blocked ? '已禁止联系' : '未禁止联系' }}</NTag>
          </div>
        </li>
      </ul>
      <NButton v-if="contactCursor" size="small" :disabled="busy" @click="run(() => loadContacts(true))">加载更多联系人</NButton>
      <template v-if="contact">
        <h4>{{ contactLabel }}</h4>
        <p>账号 {{ contact.accountId }} · v{{ contact.version }} · {{ contact.blocked ? '已禁止联系' : '未禁止联系' }}</p>
        <p v-if="contact.reason">{{ contact.reason }}</p>
        <NForm v-if="canEdit" @submit.prevent="saveBoundary">
          <NFormItem label="边界变更理由" :label-props="{ for: 'boundary-reason' }">
            <NInput v-model:value="boundaryReason" maxlength="240" :disabled="busy" :input-props="{ id: 'boundary-reason' }" />
          </NFormItem>
          <div class="console-actions">
            <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!boundaryReason.trim()">
              {{ contact.blocked ? '解除联系限制' : '禁止联系' }}
            </NButton>
            <NButton size="small" :disabled="busy" @click="run(() => readBoundary(contact!.id))">重新读取边界</NButton>
          </div>
        </NForm>
      </template>
    </section>
  </section>
</template>
