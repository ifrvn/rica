<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, conversationOption, grantView, identityView, memoryGrantInput, memoryView } from '../../../../../packages/contracts/management.js'
import { characterPath, formatTime, queryPath, useConsoleTask, type Page } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'

type Identity = z.infer<typeof identityView>
type Account = z.infer<typeof accountView>
type Grant = z.infer<typeof grantView>
type Conversation = z.infer<typeof conversationOption>
type Purpose = z.infer<typeof memoryGrantInput>['purpose']
const props = defineProps<{
  characterId: string; memory: z.infer<typeof memoryView>; identities: Identity[]; accounts: Account[]
}>()
const emit = defineEmits<{ expired: [] }>()
const { busy, error, notice, active, run, command } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const path = base + '/memory-grants'
const rows = ref<Grant[]>([])
const cursor = ref<string | null>(null)
const conversations = ref<Conversation[]>([])
const conversationCursor = ref<string | null>(null)
const mode = ref<'grant' | 'revoke'>()
const revoking = ref<Grant>()
const form = reactive({ purpose: 'INTERNAL_CONTEXT' as Purpose, identityId: '', accountId: '', conversationId: '',
  from: '', until: '', reason: '' })
const purposes: Record<Purpose, string> = {
  INTERNAL_CONTEXT: '内部上下文', DECISION_SUPPORT: '决策支持', PUBLIC_REFERENCE: '公开引用', PRIVATE_REPLY: '私聊回复',
}
const purposeOptions = computed(() => Object.entries(purposes).filter(([value]) => value !== 'PUBLIC_REFERENCE' || props.memory.visibility === 'PUBLIC')
  .map(([value, label]) => ({ value, label })))
const shareable = computed(() => props.memory.status === 'ACTIVE' && ['PUBLIC', 'PERSONAL'].includes(props.memory.visibility)
  && (!props.memory.expiresAt || Date.parse(props.memory.expiresAt) > Date.now()))
const channel = computed(() => form.purpose === 'PUBLIC_REFERENCE' ? 'PUBLIC' : form.purpose === 'PRIVATE_REPLY' ? 'PRIVATE' : undefined)
const accountOptions = computed(() => props.accounts.filter(({ identityId, status }) => identityId === form.identityId && status !== 'REVOKED')
  .map(({ id, platform, instanceKey }) => ({ value: id, label: platform + ' · ' + instanceKey })))
const selected = computed(() => conversations.value.find(({ id }) => id === form.conversationId))
const badDates = computed(() => !!form.from && !!form.until
  && !(Date.parse(form.from) < Date.parse(form.until) && Date.parse(form.until) > Date.now()))
const valid = computed(() => !!form.reason.trim() && (mode.value === 'revoke'
  || !!(form.identityId && form.from && form.until && !badDates.value && (!channel.value || (form.accountId && selected.value)))))

function name(id: string) {
  const identity = props.identities.find((item) => item.id === id)
  return identity?.profile?.displayName || identity?.slug || id
}

async function load(append = false) {
  const page = await request<Page<Grant>>(queryPath(path, { memoryId: props.memory.id, cursor: append ? cursor.value : null }))
  if (!active()) return
  rows.value = append ? [...rows.value, ...page.items] : page.items
  cursor.value = page.nextCursor
}

async function loadChoices(append = false) {
  if (!channel.value || !form.identityId || !form.accountId) return
  const page = await request<Page<Conversation>>(queryPath(base + '/identities/' + form.identityId + '/conversations', {
    accountId: form.accountId, channel: channel.value, cursor: append ? conversationCursor.value : null,
  }))
  if (!active()) return
  conversations.value = append ? [...conversations.value, ...page.items] : page.items
  conversationCursor.value = page.nextCursor
}

function resetChoice() {
  form.conversationId = ''
  conversations.value = []
  conversationCursor.value = null
  void run(() => loadChoices())
}

function open(kind: 'grant' | 'revoke', row?: Grant) {
  mode.value = kind
  revoking.value = row
  Object.assign(form, { purpose: 'INTERNAL_CONTEXT', identityId: '', accountId: '', conversationId: '', from: '', until: '', reason: '' })
  conversations.value = []
  conversationCursor.value = null
  error.value = ''
  notice.value = ''
}

function save() {
  if (!valid.value || !mode.value) return
  void run(async () => {
    if (mode.value === 'revoke' && revoking.value) {
      await command(path + '/' + revoking.value.id + '/revoke', { reason: form.reason.trim() })
    } else {
      const { purpose, identityId, accountId, conversationId, from, until, reason } = form
      await command(path, { memoryId: props.memory.id, purpose, recipientIdentityId: identityId,
        recipientAccountId: accountId || undefined,
        ...(channel.value === 'PUBLIC' ? { audience: conversationId } : channel.value === 'PRIVATE' ? {
          recipientConversationId: conversationId, recipientContactId: selected.value?.privateContactId,
        } : {}),
        validFrom: new Date(from).toISOString(), validUntil: new Date(until).toISOString(), reason: reason.trim(),
      })
    }
    if (!active()) return
    notice.value = mode.value === 'revoke' ? '授权已撤销。' : '授权已保存。'
    mode.value = undefined
    await load()
  })
}

onMounted(() => { void run(load) })
</script>

<template>
  <section class="memory-grants" aria-labelledby="memory-grant-heading">
    <div class="console-section-heading">
      <h3 id="memory-grant-heading">授权</h3>
      <NButton v-if="shareable" size="small" quaternary :disabled="busy" @click="open('grant')">新增授权</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
    <NForm v-if="mode" @submit.prevent="save">
      <div v-if="mode === 'grant'" class="console-form-grid">
        <NFormItem label="用途" :label-props="{ for: 'grant-purpose' }">
          <NSelect placeholder="选择记忆用途" filterable v-model:value="form.purpose" :options="purposeOptions" :disabled="busy"
            :input-props="{ id: 'grant-purpose' }" @update:value="resetChoice" />
        </NFormItem>
        <NFormItem label="接收身份" :label-props="{ for: 'grant-identity' }">
          <NSelect placeholder="选择接收身份" filterable v-model:value="form.identityId" :options="identities.map(({ id }) => ({ value: id, label: name(id) }))"
            :disabled="busy" :input-props="{ id: 'grant-identity' }" @update:value="form.accountId = ''; resetChoice()" />
        </NFormItem>
        <NFormItem :label="channel ? '接收账号' : '接收账号（可选）'" :label-props="{ for: 'grant-account' }">
          <NSelect placeholder="选择接收账号" clearable filterable :value="form.accountId || null" :options="accountOptions" :disabled="busy || !form.identityId"
            :input-props="{ id: 'grant-account' }" @update:value="form.accountId = $event ?? ''; resetChoice()" />
        </NFormItem>
        <NFormItem v-if="channel" :label="channel === 'PUBLIC' ? '公开受众会话' : '私聊会话'" :label-props="{ for: 'grant-conversation' }">
          <NSelect placeholder="搜索或选择会话" filterable v-model:value="form.conversationId" :disabled="busy || !form.accountId"
            :options="conversations.map(({ id, channel: kind, contactLabel }) => ({
              value: id, label: (contactLabel || (kind === 'PRIVATE' ? '私聊' : '公开会话')) + ' · ' + id.slice(0, 8),
            }))" :input-props="{ id: 'grant-conversation' }" />
        </NFormItem>
        <div v-if="channel && form.accountId && !busy" class="console-actions">
          <span v-if="selected?.privateContactId">联系人 {{ selected.contactLabel || selected.privateContactId }}</span>
          <span v-if="!conversations.length && !error">此账号暂无符合用途的会话。</span>
          <NButton v-if="conversationCursor" size="small" @click="run(() => loadChoices(true))">加载更多会话</NButton>
        </div>
        <NFormItem label="开始时间（本地）" :label-props="{ for: 'grant-from' }">
          <input id="grant-from" v-model="form.from" type="datetime-local" :disabled="busy" />
        </NFormItem>
        <NFormItem label="截止时间（本地）" :label-props="{ for: 'grant-until' }">
          <input id="grant-until" v-model="form.until" type="datetime-local" :disabled="busy" />
        </NFormItem>
      </div>
      <p v-else-if="revoking">撤销 {{ name(revoking.recipientIdentityId) }} 的{{ purposes[revoking.purpose as Purpose] }}授权。</p>
      <NAlert v-if="mode === 'grant' && badDates" type="warning" role="status">截止时间须晚于开始时间和现在。</NAlert>
      <NFormItem label="理由" :label-props="{ for: 'grant-reason' }">
        <NInput :placeholder="revoking ? '例如：协作已结束' : '例如：供该身份回复指定会话'" v-model:value="form.reason" :disabled="busy" maxlength="240" :input-props="{ id: 'grant-reason' }" />
      </NFormItem>
      <div class="console-actions">
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!valid">{{ mode === 'grant' ? '保存授权' : '确认撤销' }}</NButton>
        <NButton :disabled="busy" @click="mode = undefined">取消</NButton>
      </div>
    </NForm>
    <NSpin v-if="busy && !rows.length && !mode" />
    <NEmpty v-else-if="!rows.length && !error" description="暂无授权。" />
    <ul v-if="rows.length" class="console-record-list">
      <li v-for="grant in rows" :key="grant.id">
        <div class="console-actions">
          <strong>{{ name(grant.recipientIdentityId) }}</strong>
          <NTag size="small">{{ purposes[grant.purpose as Purpose] ?? grant.purpose }}</NTag>
          <NTag v-if="grant.revokedAt" size="small">已撤销</NTag>
          <NTag v-else-if="Date.parse(grant.validUntil) <= Date.now()" size="small">已到期</NTag>
          <NButton v-else size="tiny" quaternary :disabled="busy" @click="open('revoke', grant)">撤销授权</NButton>
        </div>
        <span>{{ formatTime(grant.validFrom) }} 至 {{ formatTime(grant.validUntil) }}</span>
        <span v-if="grant.recipientAccountId">账号 {{ accounts.find(({ id }) => id === grant.recipientAccountId)?.instanceKey ?? grant.recipientAccountId }}</span>
        <span v-if="grant.audience || grant.recipientConversationId">会话 {{ grant.audience ?? grant.recipientConversationId }}</span>
        <span v-if="grant.recipientContactId">联系人 {{ grant.recipientContactId }}</span>
      </li>
    </ul>
    <NButton v-if="cursor" size="small" :disabled="busy" @click="run(() => load(true))">加载更多授权</NButton>
  </section>
</template>

<style scoped>
.memory-grants { border-top: 1px solid var(--console-line); margin-top: 1rem; padding-top: .875rem; }
</style>
