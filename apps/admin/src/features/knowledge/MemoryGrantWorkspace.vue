<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiDialog, UiCombobox, UiSpinner, UiBadge } from '@rica/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import type { accountView, conversationOption, grantView, identityView, memoryGrantInput, memoryView } from '../../../../../packages/contracts/management.js'
import { characterPath, formatTime, queryPath, useConsoleTask, type Page } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'

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
const dialogTitle = computed(() => mode.value === 'revoke' ? '撤销授权' : '新增授权')
const heading = ref<HTMLElement>()
let trigger: HTMLElement | undefined
const revoking = ref<Grant>()
const form = reactive({ purpose: 'INTERNAL_CONTEXT' as Purpose, identityId: '', accountId: '', conversationId: '',
  from: '', until: '', reason: '' })
const purposes: Record<Purpose, string> = {
  INTERNAL_CONTEXT: '内部上下文', DECISION_SUPPORT: '决策支持', PUBLIC_REFERENCE: '公开引用', PRIVATE_REPLY: '私聊回复',
}
const purposeOptions = computed(() => (Object.keys(purposes) as Purpose[])
  .filter(value => value !== 'PUBLIC_REFERENCE' || props.memory.visibility === 'PUBLIC')
  .map(value => ({ value, label: purposes[value] })))
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
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  mode.value = kind
  revoking.value = row
  Object.assign(form, { purpose: 'INTERNAL_CONTEXT', identityId: '', accountId: '', conversationId: '', from: '', until: '', reason: '' })
  conversations.value = []
  conversationCursor.value = null
  error.value = ''
  notice.value = ''
}

function restoreFocus() {
  void nextTick(() => (trigger?.isConnected && !trigger.matches(':disabled') ? trigger : heading.value)?.focus())
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
  <section class="console-stack memory-grants" aria-labelledby="memory-grant-heading">
    <div class="console-section-heading">
      <h3 id="memory-grant-heading" ref="heading" tabindex="-1">使用授权</h3>
      <UiButton v-if="shareable" size="small" tone="primary" :disabled="busy" @click="open('grant')">新增授权</UiButton>
    </div>
    <UiAlert v-if="error && !mode" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
    <UiSpinner v-if="busy && !rows.length && !mode" />
    <UiEmpty v-else-if="!rows.length && !error" description="暂无授权。" />
    <ul v-if="rows.length" class="console-group-list">
      <li v-for="grant in rows" :key="grant.id" class="grant-row">
        <div class="console-actions">
          <strong>{{ name(grant.recipientIdentityId) }}</strong>
          <UiBadge>{{ purposes[grant.purpose as Purpose] ?? grant.purpose }}</UiBadge>
          <UiBadge v-if="grant.revokedAt">已撤销</UiBadge>
          <UiBadge v-else-if="Date.parse(grant.validUntil) <= Date.now()">已到期</UiBadge>
          <UiButton v-else size="small" tone="error" variant="quiet" :disabled="busy" @click="open('revoke', grant)">撤销授权</UiButton>
        </div>
        <span class="console-group-meta">{{ formatTime(grant.validFrom) }} 至 {{ formatTime(grant.validUntil) }}</span>
        <span v-if="grant.recipientAccountId">账号 {{ accounts.find(({ id }) => id === grant.recipientAccountId)?.instanceKey ?? grant.recipientAccountId }}</span>
        <span v-if="grant.audience || grant.recipientConversationId">会话 {{ grant.audience ?? grant.recipientConversationId }}</span>
        <span v-if="grant.recipientContactId">联系人 {{ grant.recipientContactId }}</span>
      </li>
    </ul>
    <UiButton v-if="cursor" size="small" :disabled="busy" @click="run(() => load(true))">加载更多授权</UiButton>
  </section>
  <UiDialog :open="!!mode" :title="dialogTitle"
    class="knowledge-dialog" :busy="busy"
    @update:open="show => { if (!show) { mode = undefined; error = '' } }" @closed="restoreFocus">
    <form v-if="mode" class="console-stack" @submit.prevent="save">
      <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
      <div v-if="mode === 'grant'" class="console-form-grid">
        <UiField label="用途" for="grant-purpose">
          <UiCombobox placeholder="选择记忆用途" v-model="form.purpose" :options="purposeOptions" :disabled="busy"
            :input-attrs="{ id: 'grant-purpose' }" @update:model-value="resetChoice" />
        </UiField>
        <UiField label="接收身份" for="grant-identity">
          <UiCombobox placeholder="选择接收身份" v-model="form.identityId" :options="identities.map(({ id }) => ({ value: id, label: name(id) }))"
            :disabled="busy" :input-attrs="{ id: 'grant-identity' }" @update:model-value="form.accountId = ''; resetChoice()" />
        </UiField>
        <UiField :label="channel ? '接收账号' : '接收账号（可选）'" for="grant-account">
          <UiCombobox placeholder="选择接收账号" clearable :model-value="form.accountId || null" :options="accountOptions" :disabled="busy || !form.identityId"
            :input-attrs="{ id: 'grant-account' }" @update:model-value="form.accountId = $event ?? ''; resetChoice()" />
        </UiField>
        <UiField v-if="channel" :label="channel === 'PUBLIC' ? '公开受众会话' : '私聊会话'" for="grant-conversation">
          <UiCombobox placeholder="搜索或选择会话" v-model="form.conversationId" :disabled="busy || !form.accountId"
            :options="conversations.map(({ id, channel: kind, contactLabel }) => ({
              value: id, label: (contactLabel || (kind === 'PRIVATE' ? '私聊' : '公开会话')) + ' · ' + id.slice(0, 8),
            }))" :input-attrs="{ id: 'grant-conversation' }" />
        </UiField>
        <div v-if="channel && form.accountId && !busy" class="console-actions">
          <span v-if="selected?.privateContactId">联系人 {{ selected.contactLabel || selected.privateContactId }}</span>
          <span v-if="!conversations.length && !error">此账号暂无符合用途的会话。</span>
          <UiButton v-if="conversationCursor" size="small" @click="run(() => loadChoices(true))">加载更多会话</UiButton>
        </div>
        <UiField label="开始时间（本地）" for="grant-from">
          <input id="grant-from" v-model="form.from" type="datetime-local" :disabled="busy" />
        </UiField>
        <UiField label="截止时间（本地）" for="grant-until">
          <input id="grant-until" v-model="form.until" type="datetime-local" :disabled="busy" />
        </UiField>
      </div>
      <p v-else-if="revoking">撤销 {{ name(revoking.recipientIdentityId) }} 的{{ purposes[revoking.purpose as Purpose] }}授权。</p>
      <UiAlert v-if="mode === 'grant' && badDates" tone="warning" role="status">截止时间须晚于开始时间和现在。</UiAlert>
      <UiField label="理由" for="grant-reason">
        <input class="ui-control" :placeholder="revoking ? '例如：协作已结束' : '例如：供该身份回复指定会话'" v-model="form.reason" :disabled="busy" maxlength="240" v-bind="{ id: 'grant-reason' }" />
      </UiField>
      <div class="console-actions grant-actions">
        <UiButton :disabled="busy" @click="mode = undefined">取消</UiButton>
        <UiButton :tone="mode === 'revoke' ? 'error' : 'primary'" type="submit" :loading="busy" :disabled="!valid">{{ mode === 'grant' ? '保存授权' : '确认撤销' }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.memory-grants { border-top: 1px solid var(--console-line); padding-top: 1rem; }
.memory-grants > .ui-button { justify-self: start; }
.grant-row { display: grid; gap: .35rem; padding: .8rem .75rem; overflow-wrap: anywhere; }
.grant-actions { justify-content: flex-end; }
</style>
