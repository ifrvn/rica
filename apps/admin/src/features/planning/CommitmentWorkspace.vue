<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { UiAlert, UiButton, UiCheckbox, UiEmpty, UiField, UiDialog, UiSpinner, UiBadge } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import { commitmentInput, commitmentUpdate, type commitmentReceiptView, type commitmentView } from '@ricajs/contracts/commitments'
import type { accountView, identityView } from '@ricajs/contracts/management'
import { characterPath, formatTime, queryPath, readAll, useConsoleTask, type Page } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'

type Commitment = z.infer<typeof commitmentView>
type Receipt = z.infer<typeof commitmentReceiptView>
type Account = z.infer<typeof accountView>
type Identity = z.infer<typeof identityView>
type Operation = z.infer<typeof commitmentUpdate>['operation']
type Editor = { kind: 'CREATE' } | { kind: Operation; item: Commitment }
const props = defineProps<{ characterId: string; runId?: string }>()
const emit = defineEmits<{ expired: []; clear: [feedback?: string] }>()
const { active, busy, error, notice, run, command } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const path = base + '/commitments'
const commitments = ref<Commitment[]>([])
const identities = ref<Identity[]>([])
const accounts = ref<Account[]>([])
const receipts = ref<Receipt[]>([])
const receiptCursor = ref<string | null>(null)
const editor = ref<Editor>()
const selected = ref<string>()
const collaborators = ref<string[]>([])
const heading = ref<HTMLElement>()
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const form = reactive({ title: '', task: '', due: '', reason: '' })
let trigger: HTMLElement | undefined
let initialDeadline = ''

const stateLabels = { OPEN: '待履行', DEFERRED: '已延期', FULFILLED: '已履行', CANCELED: '已取消', EXPIRED: '已到期' }
const editorLabels = { CREATE: '新建承诺', EDIT: '编辑承诺', DEFER: '延期', FULFILL: '标记已履行', CANCEL: '取消承诺', EXPIRE: '标记已到期' }
const dialogTitle = computed(() => editor.value ? editorLabels[editor.value.kind] : '')
const target = computed(() => editor.value?.kind === 'CREATE' ? receipts.value.find(({ id }) => id === selected.value) : editor.value?.item)
const details = computed(() => editor.value?.kind === 'CREATE' || editor.value?.kind === 'EDIT')
const byIdentity = computed(() => new Map(accounts.value.filter(({ status }) => status !== 'REVOKED')
  .map((account) => [account.identityId, account])))
const byAccount = computed(() => new Map(accounts.value.map((account) => [account.id, account])))
const bindingChanged = computed(() => editor.value?.kind === 'EDIT' && editor.value.item.collaborators.some(({ identityId, accountId }) =>
  byIdentity.value.get(identityId)?.id !== accountId))
const receiptOptions = computed(() => receipts.value.map((item) => ({
  value: item.id,
  label: identityName(item.identityId) + ' / ' + item.platform + ' · ' + recipient(item) + ' · ' + formatTime(item.receiptAt)
    + ' · ' + item.id.slice(0, 8),
})))

function identityName(id: string) {
  const identity = identities.value.find((item) => item.id === id)
  return identity?.profile?.displayName || identity?.slug || id
}

function recipient(item: { contactId: string | null; contactLabel: string | null }) {
  return item.contactLabel || (item.contactId ? '私聊联系人' : '公开会话')
}

function toLocalInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function isOpen(item: Commitment) {
  return item.state === 'OPEN' || item.state === 'DEFERRED'
}

function isOverdue(item: Commitment) {
  return isOpen(item) && Date.parse(item.dueAt) <= Date.now()
}

async function load() {
  const [items, names, bindings] = await Promise.all([
    readAll<Commitment>(path, active), readAll<Identity>(base + '/identities', active), readAll<Account>(base + '/accounts', active),
  ])
  if (!active()) return
  commitments.value = items
  identities.value = names
  accounts.value = bindings
}

async function loadReceipts(append = false) {
  const page = await request<Page<Receipt>>(queryPath(base + '/commitment-receipts', {
    runId: props.runId, cursor: append ? receiptCursor.value : null,
  }))
  if (!active()) return
  receipts.value = append ? [...receipts.value, ...page.items] : page.items
  receiptCursor.value = page.nextCursor
  if (props.runId) selected.value = page.items[0]?.id
  else if (!append && !receipts.value.some(({ id }) => id === selected.value)) selected.value = undefined
}

function open(next: Editor) {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const item = next.kind === 'CREATE' ? undefined : next.item
  initialDeadline = item ? toLocalInput(new Date(item.dueAt)) : ''
  Object.assign(form, { title: item?.title ?? '', task: item?.task ?? '', due: initialDeadline, reason: '' })
  collaborators.value = item?.collaborators.filter(({ identityId, accountId }) => byIdentity.value.get(identityId)?.id === accountId)
    .map(({ accountId }) => accountId) ?? []
  selected.value = undefined
  error.value = ''
  notice.value = ''
  editor.value = next
}

function openNew() {
  receipts.value = []
  receiptCursor.value = null
  open({ kind: 'CREATE' })
  void run(loadReceipts)
}

function close(feedback?: string) {
  editor.value = undefined
  error.value = ''
  if (props.runId) emit('clear', feedback)
  else void nextTick(() => (trigger?.isConnected ? trigger : heading.value)?.focus())
}

function selectReceipt(id: string) {
  selected.value = id
  const owner = receipts.value.find((item) => item.id === id)?.identityId
  collaborators.value = collaborators.value.filter((accountId) => byAccount.value.get(accountId)?.identityId !== owner)
}

function setCollaborator(identityId: string, checked: boolean) {
  const account = byIdentity.value.get(identityId)
  if (!account) return
  collaborators.value = checked ? [...collaborators.value, account.id] : collaborators.value.filter((id) => id !== account.id)
}

function deadline(item?: Commitment) {
  if (item && form.due === initialDeadline) return item.dueAt
  const date = new Date(form.due)
  return Number.isFinite(date.getTime()) && toLocalInput(date) === form.due ? date.toISOString() : undefined
}

function save() {
  const current = editor.value
  if (!current) return
  const dueAt = deadline(current.kind === 'CREATE' ? undefined : current.item)
  const selectedCollaborators = collaborators.value.flatMap((accountId) => {
    const account = byAccount.value.get(accountId)
    return account ? [{ accountId, identityId: account.identityId }] : []
  })
  const fields = { title: form.title, task: form.task, dueAt, collaborators: selectedCollaborators, reason: form.reason }
  const payload = current.kind === 'CREATE'
    ? commitmentInput.safeParse({ ...fields, actionId: selected.value })
    : commitmentUpdate.safeParse(current.kind === 'EDIT' ? { ...fields, operation: current.kind }
      : { operation: current.kind, reason: form.reason, ...(current.kind === 'DEFER' ? { dueAt } : {}) })
  if (!payload.success) {
    error.value = details.value ? '请核对回执、名称、承诺事项、截止时间和理由。' : '请核对截止时间和理由。'
    return
  }
  void run(async () => {
    if (current.kind === 'CREATE') await command(path, payload.data)
    else await command(path + '/' + current.item.id, payload.data, 'PUT', current.item.version)
    if (!active()) return
    const feedback = current.kind === 'CREATE' ? '承诺已登记。' : '承诺已更新。'
    close(feedback)
    if (!props.runId) {
      notice.value = feedback
      await load()
    }
  })
}

function reloadEditor() {
  const current = editor.value
  if (!current) return
  void run(async () => {
    await load()
    if (!active()) return
    if (current.kind === 'CREATE') await loadReceipts()
    else {
      const latest = commitments.value.find(({ id }) => id === current.item.id)
      if (!latest || !isOpen(latest)) {
        error.value = '该承诺已关闭或无法读取。'
        return
      }
      editor.value = { kind: current.kind, item: latest }
      if (form.due === initialDeadline) form.due = toLocalInput(new Date(latest.dueAt))
      initialDeadline = toLocalInput(new Date(latest.dueAt))
    }
    const before = collaborators.value.length
    const currentIds = new Set([...byIdentity.value.values()].map(({ id }) => id))
    collaborators.value = collaborators.value.filter((id) => currentIds.has(id))
    notice.value = before === collaborators.value.length ? '已读取最新记录。请确认当前输入后再保存。' : '部分账号绑定已变化，请重新勾选协作身份。'
  })
}

onMounted(() => {
  void run(async () => {
    await load()
    if (props.runId && active()) {
      open({ kind: 'CREATE' })
      await loadReceipts()
    }
  })
})
</script>

<template>
  <section class="console-record-workspace" aria-labelledby="commitments-heading">
    <div class="console-section-heading">
      <h3 id="commitments-heading" ref="heading" tabindex="-1">承诺</h3>
      <div class="console-actions">
        <UiButton size="small" variant="quiet" :disabled="busy" @click="run(load)">刷新承诺</UiButton>
        <UiButton size="small" tone="primary" :disabled="busy" @click="openNew">新建承诺</UiButton>
      </div>
    </div>
    <UiAlert v-if="error && !editor" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="notice && !editor" tone="success" role="status">{{ notice }}</UiAlert>
    <UiSpinner v-if="busy && !commitments.length && !editor" aria-label="正在读取承诺" />
    <UiEmpty v-else-if="!commitments.length && !error" description="暂无承诺。" />
    <ul v-else-if="commitments.length" class="commitments-list">
      <li v-for="item in commitments" :key="item.id">
        <div class="commitment-title">
          <h4>{{ item.title }}</h4>
          <div class="console-actions">
            <UiBadge :tone="item.source === 'AI' ? 'info' : 'default'">
              {{ item.source === 'AI' ? 'AI 从回执登记' : '人工登记' }}
            </UiBadge>
            <UiBadge :tone="isOverdue(item) ? 'warning' : item.state === 'FULFILLED' ? 'success' : 'default'">
              {{ isOverdue(item) ? '已逾期' : stateLabels[item.state] }}
            </UiBadge>
          </div>
        </div>
        <p class="commitment-muted">截止 {{ formatTime(item.dueAt) }} · 对象 {{ recipient(item) }} · 模拟回执 {{ item.actionId.slice(0, 8) }}</p>
        <p v-if="item.task" class="console-payload commitment-task">{{ item.task }}</p>
        <p v-else class="commitment-muted">未记录承诺事项</p>
        <ul class="commitment-participants" aria-label="负责与协作身份">
          <li><strong>负责</strong> · {{ identityName(item.identityId) }} / {{ byAccount.get(item.accountId)?.platform ?? item.accountId }}</li>
          <li v-for="member in item.collaborators" :key="member.identityId">
            <strong>协作</strong> · {{ identityName(member.identityId) }} / {{ member.platform }}
            <small v-if="byIdentity.get(member.identityId)?.id !== member.accountId" class="commitment-muted">账号绑定已变化</small>
          </li>
        </ul>
        <div v-if="isOpen(item)" class="console-actions">
          <UiButton size="small" :disabled="busy" @click="open({ kind: 'EDIT', item })">编辑承诺</UiButton>
          <UiButton size="small" variant="quiet" :disabled="busy" @click="open({ kind: 'DEFER', item })">延期</UiButton>
          <UiButton size="small" variant="soft" tone="success" :disabled="busy" @click="open({ kind: 'FULFILL', item })">标记已履行</UiButton>
          <UiButton v-if="isOverdue(item)" size="small" variant="quiet" :disabled="busy" @click="open({ kind: 'EXPIRE', item })">标记已到期</UiButton>
          <UiButton size="small" variant="soft" tone="error" :disabled="busy" @click="open({ kind: 'CANCEL', item })">取消承诺</UiButton>
        </div>
      </li>
    </ul>
  </section>

  <UiDialog :open="!!editor" :title="dialogTitle"
    style="width: 36rem; max-width: calc(100% - 2rem)" :dismiss-outside="!busy" :busy="busy"
    @update:open="!$event && close()">
    <form v-if="editor" class="commitment-editor" @submit.prevent="save">
      <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
      <UiAlert v-if="notice" tone="info" role="status">{{ notice }}</UiAlert>
      <template v-if="editor.kind === 'CREATE' && !receipts.length">
        <UiSpinner v-if="busy" aria-label="正在查询回执" />
        <p v-else-if="!error" class="commitment-muted">{{ runId ? '这条运行暂无可登记的回执，或已登记承诺。' : '当前角色暂无尚未登记承诺的已确认模拟回执。' }}</p>
      </template>
      <template v-else>
        <template v-if="editor.kind === 'CREATE' && !runId">
          <UiField label="已确认的模拟回执" for="commitment-receipt">
            <select id="commitment-receipt" :value="selected ?? ''" :disabled="busy" required
              @change="selectReceipt(($event.target as HTMLSelectElement).value)">
              <option disabled value="">选择承诺来源</option>
              <option v-for="option in receiptOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </UiField>
          <UiButton v-if="receiptCursor" size="small" :disabled="busy" @click="run(() => loadReceipts(true))">加载更多回执</UiButton>
        </template>
        <p v-if="target" class="commitment-muted">
          负责 {{ identityName(target.identityId) }} / {{ byAccount.get(target.accountId)?.platform ?? target.accountId }}
          · 对象 {{ recipient(target) }} · 回执 {{ ('actionId' in target ? target.actionId : target.id).slice(0, 8) }}
        </p>
        <p v-if="editor.kind !== 'CREATE' && !details" class="commitment-muted">{{ editor.item.title }}</p>
        <template v-if="details">
          <UiField label="名称" for="commitment-title">
            <input class="ui-control" v-model="form.title" :maxlength="120" :disabled="busy" v-bind="{ id: 'commitment-title', required: true }" />
          </UiField>
          <UiField label="承诺事项" for="commitment-task">
            <textarea class="ui-control" v-model="form.task" :rows="3" :maxlength="300" :disabled="busy"
              placeholder="写清楚要交付什么，以及怎样算履行" v-bind="{ id: 'commitment-task', required: true }"></textarea>
          </UiField>
        </template>
        <UiField v-if="details || editor.kind === 'DEFER'" :label="'履行截止时间（' + browserZone + '）'" for="commitment-due">
          <input id="commitment-due" v-model="form.due" type="datetime-local" :disabled="busy" required />
        </UiField>
        <fieldset v-if="details && target" class="commitment-collaborators">
          <legend>协作身份和平台（可选）</legend>
          <p v-if="bindingChanged" class="commitment-muted">部分协作账号已变更，请重新勾选。</p>
          <div v-for="identity in identities.filter(({ id }) => id !== target?.identityId)" :key="identity.id">
            <UiCheckbox :model-value="collaborators.includes(byIdentity.get(identity.id)?.id ?? '')"
              :disabled="busy || !byIdentity.has(identity.id)" :aria-disabled="busy || !byIdentity.has(identity.id)"
              @update:model-value="setCollaborator(identity.id, $event)">
              {{ identityName(identity.id) }} · {{ byIdentity.get(identity.id)?.platform ?? '未绑定平台' }}
            </UiCheckbox>
          </div>
        </fieldset>
        <UiField label="理由" for="commitment-reason">
          <input class="ui-control" v-model="form.reason" :maxlength="240" :disabled="busy" v-bind="{ id: 'commitment-reason', required: true }" />
        </UiField>
      </template>
      <div class="console-actions">
        <UiButton v-if="target" :tone="editor.kind === 'CANCEL' ? 'error' : 'primary'" type="submit" :loading="busy">
          {{ details ? '保存承诺' : '确认' + dialogTitle }}
        </UiButton>
        <UiButton v-if="error" size="small" :disabled="busy" @click="reloadEditor">重新读取</UiButton>
        <UiButton :disabled="busy" @click="close()">返回</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.commitments-list, .commitment-participants { list-style: none; padding: 0; margin: 0; }
.commitments-list > li { display: grid; gap: .75rem; padding: 1rem .25rem; border-top: 1px solid var(--console-line); }
.commitment-title { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; justify-content: space-between; }
.commitment-title h4, .commitment-muted, .commitment-task { margin: 0; }
.commitment-muted { color: var(--console-muted); font-size: .875rem; overflow-wrap: anywhere; }
.commitment-participants { display: grid; gap: .375rem; }
.commitment-editor { display: grid; gap: .875rem; }
.commitment-editor select, .commitment-editor input[type='datetime-local'] { box-sizing: border-box; width: 100%; min-width: 0;
  min-height: 34px; padding: .25rem .5rem; border: 1px solid var(--console-field); border-radius: 5px;
  background: var(--console-surface); color: inherit; font: inherit; }
.commitment-collaborators { display: grid; gap: .5rem; min-width: 0; margin: 0; padding: .625rem .75rem;
  border: 1px solid var(--console-line); border-radius: 5px; }
</style>
