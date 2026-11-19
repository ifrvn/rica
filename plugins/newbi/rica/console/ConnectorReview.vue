<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiDialog, UiCombobox, UiSpinner, UiBadge } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import { autoReviewHandoffLabels } from '@ricajs/contracts/auto-review'
import type { newbiReviewView, newbiReplySummary, newbiSendView, newbiThreadView } from '../management/contracts.js'
import { focusRecord, formatTime } from '@ricajs/console-shared/console-data'
import { request, RequestError } from '@ricajs/console-shared/request'

type Summary = z.infer<typeof newbiReplySummary>
type Reply = z.infer<typeof newbiReviewView>
type SendResult = z.infer<typeof newbiSendView>
type Page = { items: Summary[]; nextCursor: string | null }
const props = defineProps<{ characterId: string; detailId?: string; accountId?: string; statusFilter?: string; canReview: boolean; canManage: boolean; canInspect?: boolean }>()
const emit = defineEmits<{ expired: []; open: [id?: string]; all: []; filter: [status: string]; account: [id: string]; audit: [id: string] }>()
const base = '/v1/characters/' + encodeURIComponent(props.characterId) + '/newbi/replies'
const statusText: Record<Summary['status'], string> = {
  WAITING: '待审批', READY: '待发送', REJECTED: '已拒绝', IN_FLIGHT: '发送中',
  UNKNOWN: '待核对', SENT: '已发送', CLOSED: '已结案',
}
const options = [{ label: '全部状态', value: '' }, ...Object.entries(statusText).map(([value, label]) => ({ label, value }))]
const filter = computed(() => options.find(({ value }) => value === props.statusFilter)?.value ?? 'WAITING')
const rows = ref<Summary[]>([])
const cursor = ref<string | null>(null)
const reply = ref<Reply>()
const thread = ref<z.infer<typeof newbiThreadView>>()
const commentPositions = computed(() => new Map(thread.value?.comments.map(({ id }, index) => [id, index + 1])))
const loadingThread = ref(false)
const threadError = ref('')
const reason = ref('')
const detailHeading = ref<HTMLElement>()
const listHeading = ref<HTMLElement>()
const loadingList = ref(false)
const loadingDetail = ref(false)
const submitting = ref(false)
const listError = ref('')
const detailError = ref('')
const notice = ref('')
const confirmation = ref(false)
const checkedAt = ref(Date.now())
const leaseExpired = computed(() => reply.value?.status === 'IN_FLIGHT'
  && !!reply.value.leaseUntil && Date.parse(reply.value.leaseUntil) <= checkedAt.value)
const canRetry = computed(() => reply.value?.status === 'UNKNOWN' || leaseExpired.value)
const canClose = computed(() => {
  const item = reply.value
  return props.canManage && !!item && (item.status === 'UNKNOWN'
    || (leaseExpired.value && (item.attempts >= 3 || Date.parse(item.expiresAt) <= checkedAt.value)))
})
const canSend = computed(() => {
  const item = reply.value
  return props.canManage && !!item?.connectorAvailable && !!item.content
    && (item.status === 'READY' || canRetry.value) && item.attempts < 3
    && Date.parse(item.expiresAt) > checkedAt.value + 10_000
    && (!item.retryNotBefore || Date.parse(item.retryNotBefore) <= checkedAt.value)
})
let pending: { signature: string; key: string } | undefined
let active = true
let selection = 0
let listRevision = 0
onBeforeUnmount(() => { active = false })

function message(cause: unknown) {
  const status = cause instanceof RequestError ? cause.status : 0
  if (status === 401) emit('expired')
  return ({
    403: '当前账号无权执行此操作。', 404: '找不到当前角色的提案。',
    409: '提案状态已变化，请重新核对。', 422: '请求已失效或输入有误，请刷新后重试。',
  } as Record<number, string>)[status] ?? '操作未完成，请重试。'
}

async function list(append = false) {
  if (append && loadingList.value) return
  const current = ++listRevision
  loadingList.value = true
  listError.value = ''
  const query = new URLSearchParams()
  if (filter.value) query.set('status', filter.value)
  if (props.accountId) query.set('accountId', props.accountId)
  if (append && cursor.value) query.set('cursor', cursor.value)
  try {
    const page = await request<Page>(base + '?' + query.toString())
    if (!active || current !== listRevision) return
    rows.value = append ? [...rows.value, ...page.items] : page.items
    cursor.value = page.nextCursor
  } catch (cause) {
    if (!active || current !== listRevision) return
    if (cause instanceof RequestError && [403, 404].includes(cause.status)) {
      rows.value = []
      cursor.value = null
    }
    listError.value = message(cause)
  } finally { if (current === listRevision) loadingList.value = false }
}

async function detail(id?: string) {
  const current = ++selection
  reply.value = undefined
  thread.value = undefined
  threadError.value = ''
  loadingThread.value = false
  detailError.value = ''
  loadingDetail.value = !!id
  if (!id) return
  try {
    const view = await request<Reply>(base + '/' + encodeURIComponent(id))
    if (!active || current !== selection) return
    checkedAt.value = Date.now()
    if (props.accountId && props.accountId !== view.accountId) {
      detailError.value = '找不到当前账号的提案。'
    } else {
      reply.value = view
      if (view.status === 'WAITING' && view.connectorAvailable) void loadThread()
    }
  } catch (cause) {
    if (active && current === selection) detailError.value = message(cause)
  } finally { if (current === selection) loadingDetail.value = false }
}

async function loadThread(append = false) {
  const item = reply.value
  const cursor = append ? thread.value?.nextCursor : undefined
  if (!item?.connectorAvailable || loadingThread.value || (append && !cursor)) return
  const current = selection
  loadingThread.value = true
  threadError.value = ''
  try {
    const path = base + '/' + encodeURIComponent(item.id) + '/thread'
    const result = await request<z.infer<typeof newbiThreadView>>(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))
    if (active && current === selection) {
      thread.value = append ? { ...result, comments: [
        ...(thread.value?.comments ?? []), ...result.comments.filter(({ id }) => !commentPositions.value.has(id)),
      ] } : result
    }
  } catch (cause) {
    if (!active || current !== selection) return
    if (cause instanceof RequestError && cause.status === 401) emit('expired')
    else {
      if (!append || (cause instanceof RequestError && [403, 404, 409].includes(cause.status))) thread.value = undefined
      threadError.value = cause instanceof RequestError && cause.status === 409
        ? 'Newbi 配置已变更，请刷新提案详情后重试。'
        : '无法读取帖子上下文。请重试，或到 Newbi 核对目标帖子。'
    }
  } finally {
    if (active && current === selection) loadingThread.value = false
  }
}

watch([() => props.detailId, () => props.accountId], ([id], previous) => {
  reason.value = ''
  pending = undefined
  notice.value = ''
  confirmation.value = false
  void detail(id)
  void nextTick(() => {
    if (active && id === props.detailId) focusRecord('connector-row-', id, previous?.[0], detailHeading.value, listHeading.value)
  })
}, { immediate: true })

async function submit(action: 'APPROVE' | 'REJECT' | 'CLOSE') {
  const item = reply.value
  const note = reason.value.trim()
  if (!item || (action === 'CLOSE' && !note) || submitting.value || loadingDetail.value
    || (action === 'APPROVE' && !item.connectorAvailable)
    || (action === 'CLOSE' ? !canClose.value
      : !props.canReview || item.status !== 'WAITING' || !item.content)) return
  const payload = action === 'CLOSE' ? { reason: note } : { reason: note || undefined, decision: action, reviewDigest: item.reviewDigest }
  const body = JSON.stringify(payload)
  const path = base + '/' + encodeURIComponent(item.id) + (action === 'CLOSE' ? '/close' : '/decision')
  const signature = JSON.stringify([path, body])
  if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
  const current = selection
  submitting.value = true
  detailError.value = ''
  try {
    await request(path, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key } })
    if (!active || current !== selection) return
    reason.value = ''
    pending = undefined
    notice.value = action === 'APPROVE' ? '已批准，等待单次发送。' : action === 'CLOSE' ? '已结案。' : '已拒绝。'
    await Promise.all([detail(item.id), list()])
  } catch (cause) {
    if (!active || current !== selection) return
    if (cause instanceof RequestError && [403, 404, 409, 412].includes(cause.status)) reply.value = undefined
    detailError.value = message(cause)
  } finally { submitting.value = false }
}

function sendMessage(result: Exclude<SendResult, { status: 'SENT' }>) {
  if (result.status === 'UNKNOWN') return '发送结果待核对。请先到 Newbi 查看评论，再决定是否重试。'
  if (result.status === 'CLOSED') return '帖子已锁定，提案已结案。'
  if (result.retryNotBefore) return '平台暂缓发送。请于 ' + formatTime(result.retryNotBefore) + ' 后刷新详情。'
  if (result.reason === 'CREDENTIAL_INVALID' || result.reason === 'ACCESS_DENIED') return '请在平台账号池核对账号连接和 Agent 权限。'
  if (result.reason === 'COMMUNITY_CLOSED') return 'Newbi 当前暂停公开发布，请稍后重试。'
  if (result.reason === 'POST_LOCKED') return '帖子已锁定。请在 Newbi 核对此前的发送结果。'
  return '暂时无法发送。请核对插件、账号和该账号的待核对提案。'
}

async function send() {
  const item = reply.value
  if (!item || !confirmation.value || !canSend.value || submitting.value) return
  const current = selection
  submitting.value = true
  notice.value = ''
  detailError.value = ''
  try {
    const result = await request<SendResult>(base + '/' + encodeURIComponent(item.id) + '/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry: canRetry.value }),
    })
    if (!active || current !== selection) return
    confirmation.value = false
    await Promise.all([detail(item.id), list()])
    if (!active || props.detailId !== item.id) return
    if (result.status === 'SENT') notice.value = '公开回复已发送。评论回执 ID ' + result.commentId
    else detailError.value ||= sendMessage(result)
  } catch (cause) {
    if (!active || current !== selection) return
    confirmation.value = false
    const feedback = cause instanceof RequestError && cause.status < 500
      ? message(cause) : '暂未确认发送结果。请先核对详情和 Newbi 评论。'
    await Promise.all([detail(item.id), list()])
    if (active && props.detailId === item.id) detailError.value ||= feedback
  } finally { submitting.value = false }
}

watch([() => props.accountId, filter], () => {
  rows.value = []
  cursor.value = null
  void list()
})
onMounted(() => { void list() })
</script>

<template>
  <div class="console-split console-record-workspace" :class="{ 'console-split--detail': detailId }">
    <section class="console-split-list" aria-labelledby="connector-list-heading">
      <div class="console-section-heading">
        <h3 id="connector-list-heading" ref="listHeading" tabindex="-1">{{ accountId ? '当前账号的 Newbi 提案' : 'Newbi 平台提案' }}</h3>
        <div class="console-actions">
          <UiButton v-if="accountId" size="small" variant="quiet" :disabled="submitting" @click="emit('all')">查看全部账号</UiButton>
          <UiButton size="small" variant="quiet" :disabled="loadingList || submitting" @click="list()">刷新列表</UiButton>
        </div>
      </div>
      <div class="connector-actions">
        <label for="connector-filter">状态</label>
        <UiCombobox placeholder="选择提案状态" :model-value="filter" :options="options" :input-attrs="{ id: 'connector-filter' }"
          class="filter" :disabled="loadingList || submitting" @update:model-value="emit('filter', $event)" />
      </div>
      <UiAlert v-if="listError" tone="error" role="alert">{{ listError }}</UiAlert>
      <UiSpinner v-if="loadingList && !rows.length" />
      <UiEmpty v-else-if="!rows.length && !listError" description="暂无符合条件的提案。" />
      <ul v-if="rows.length" class="console-select-list">
        <li v-for="item in rows" :key="item.id">
          <button :id="'connector-row-' + item.id" type="button" class="console-record" :disabled="submitting"
            :aria-current="detailId === item.id ? 'true' : undefined" @click="emit('open', item.id)">
            <span class="console-record-main">
              <strong>{{ item.identity }}</strong>
              <span>Newbi · 公开回复</span>
              <span class="console-record-meta">帖子 {{ item.postId.slice(0, 8) }} · 账号 {{ item.agentId.slice(0, 8) }}</span>
            </span>
            <span class="console-record-meta">
              <UiBadge>{{ statusText[item.status] }}</UiBadge>
              <time :datetime="item.createdAt">{{ formatTime(item.createdAt) }}</time>
            </span>
          </button>
        </li>
      </ul>
      <UiButton v-if="cursor" size="small" :disabled="loadingList || submitting" @click="list(true)">加载更多</UiButton>
    </section>
    <section v-if="detailId" class="console-split-detail" aria-labelledby="connector-detail-heading">
      <div class="console-section-heading">
        <h3 id="connector-detail-heading" ref="detailHeading" tabindex="-1">Newbi 公开回复</h3>
        <div class="console-actions">
          <UiButton size="small" variant="quiet" :disabled="loadingDetail || submitting" @click="detail(detailId)">刷新详情</UiButton>
          <UiButton size="small" variant="quiet" :disabled="submitting" @click="emit('open')">返回提案列表</UiButton>
        </div>
      </div>
      <UiAlert v-if="detailError" tone="error" role="alert">{{ detailError }}</UiAlert>
      <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
      <UiSpinner v-if="loadingDetail" aria-label="正在加载提案" />
      <template v-if="reply">
        <div class="console-actions">
          <UiBadge tone="warning">真实平台</UiBadge>
          <UiBadge>{{ statusText[reply.status] }}</UiBadge>
          <UiBadge v-if="reply.autoApproved" tone="success">AI 自动批准</UiBadge>
        </div>
        <dl>
          <div><dt>平台</dt><dd>Newbi · {{ reply.endpoint }}</dd></div>
          <div><dt>身份</dt><dd>{{ reply.identity || reply.identityId }}</dd></div>
          <div><dt>账号</dt><dd>{{ reply.agentId }}</dd></div>
          <div><dt>目标</dt><dd>{{ reply.postId }} · 公开回复</dd></div>
          <div><dt>到期</dt><dd>{{ new Date(reply.expiresAt).toLocaleString() }}</dd></div>
          <div><dt>发送尝试</dt><dd>{{ reply.attempts }} 次</dd></div>
          <div v-if="reply.retryNotBefore"><dt>最早重试</dt><dd>{{ formatTime(reply.retryNotBefore) }}</dd></div>
          <div v-if="reply.status === 'IN_FLIGHT' && reply.leaseUntil"><dt>许可到期</dt><dd>{{ formatTime(reply.leaseUntil) }}</dd></div>
          <div v-if="reply.remoteCommentId"><dt>评论回执</dt><dd>{{ reply.remoteCommentId }}</dd></div>
          <div v-if="reply.closureReason"><dt>结案理由</dt><dd>{{ reply.closureReason }}</dd></div>
        </dl>
        <div v-if="canInspect" class="console-actions">
          <UiButton size="small" variant="quiet" @click="emit('account', reply.accountId)">查看账号读取状态</UiButton>
          <UiButton size="small" variant="quiet" @click="emit('audit', reply.id)">查看提案审计</UiButton>
        </div>
        <section class="thread-preview" aria-labelledby="newbi-thread-heading">
          <div class="console-section-heading">
            <h4 id="newbi-thread-heading">帖子上下文</h4>
            <UiButton v-if="reply.connectorAvailable" size="small" variant="soft" :loading="loadingThread"
              :disabled="loadingThread || submitting" @click="loadThread()">
              {{ thread ? '刷新上下文' : '读取帖子和评论' }}
            </UiButton>
          </div>
          <UiSpinner v-if="loadingThread && !thread" aria-label="正在读取帖子上下文" />
          <p v-if="!reply.connectorAvailable">请在插件中心核对 Newbi 的启用状态和 Agent API 地址。</p>
          <template v-if="thread">
            <div class="console-actions">
              <strong>{{ thread.post.title }}</strong>
              <UiBadge v-if="thread.post.isLocked" tone="warning">帖子已锁定</UiBadge>
            </div>
            <p class="console-payload thread-content">{{ thread.post.content }}</p>
            <details v-if="thread.comments.length">
              <summary>查看已加载的 {{ thread.comments.length }} 条可见评论</summary>
              <ol class="thread-comments">
                <li v-for="comment in thread.comments" :key="comment.id">
                  <strong>{{ comment.author.username }}</strong>
                  <span v-if="comment.replyToCommentId" class="console-record-meta">
                    · {{ commentPositions.has(comment.replyToCommentId)
                      ? '回复第 ' + commentPositions.get(comment.replyToCommentId) + ' 条'
                      : '回复另一条评论' }}
                  </span>
                  <p class="console-payload">{{ comment.content }}</p>
                </li>
              </ol>
            </details>
            <p v-else>{{ thread.nextCursor ? '本批暂无可见评论。' : '暂无可见评论。' }}</p>
            <UiButton v-if="thread.nextCursor" size="small" :loading="loadingThread" :disabled="loadingThread || submitting"
              @click="loadThread(true)">加载更多评论</UiButton>
          </template>
          <UiAlert v-if="threadError" tone="warning" role="alert">{{ threadError }}</UiAlert>
        </section>
        <template v-if="reply.content">
          <h4>拟发送内容</h4>
          <p class="console-payload">{{ reply.content }}</p>
        </template>
        <p v-else-if="reply.status === 'WAITING'">当前无法预览正文，暂不能审批。</p>
        <UiAlert v-if="reply.autoReviewHandoff" tone="warning">
          <strong>{{ autoReviewHandoffLabels[reply.autoReviewHandoff.status] }}</strong>
          <p>{{ reply.autoReviewHandoff.reason }}</p>
          <small v-if="reply.autoReviewHandoff.model">审核模型 {{ reply.autoReviewHandoff.model }}</small>
        </UiAlert>
        <section aria-labelledby="newbi-review-history-heading">
          <h4 id="newbi-review-history-heading">审批记录</h4>
          <dl v-if="reply.reviewRecord">
            <div><dt>决定</dt><dd>{{ reply.autoApproved ? 'AI 审核' : '人工审核' }} · {{ reply.reviewRecord.decision === 'APPROVE' ? '批准' : '拒绝' }} · {{ formatTime(reply.reviewRecord.at) }}</dd></div>
            <div v-if="reply.reviewerName"><dt>审批人</dt><dd>{{ reply.reviewerName }}</dd></div>
            <div><dt>理由</dt><dd>{{ reply.reviewRecord.reason ?? '当时未填写' }}</dd></div>
            <div v-if="reply.reviewRecord.model"><dt>模型</dt><dd>{{ reply.reviewRecord.model }} · 规则第 {{ reply.reviewRecord.policyVersion }} 版</dd></div>
          </dl>
          <p v-else-if="!reply.autoReviewHandoff">{{ reply.status === 'WAITING' ? '尚无审批决定。' : '当时未采集审批详情。' }}</p>
          <details v-if="reply.reviewPrompt">
            <summary>审核 System Prompt · {{ reply.reviewPrompt.model }} · {{ formatTime(reply.reviewPrompt.at) }}</summary>
            <pre class="console-payload">{{ reply.reviewPrompt.systemPrompt }}</pre>
          </details>
          <p v-else-if="reply.autoApproved">没有可查看的审核提示词快照。</p>
        </section>
        <div v-if="canManage && (reply.status === 'READY' || canRetry)" class="send-actions">
          <UiButton v-if="canSend" tone="primary" :disabled="submitting" @click="confirmation = true">
            {{ canRetry ? '核对后重试' : '发送公开回复' }}
          </UiButton>
          <UiAlert v-else tone="warning">
            {{ !reply.connectorAvailable ? '请在插件中心核对 Newbi 的启用状态和 Agent API 地址。'
              : '当前提案暂不可发送。请核对有效期、重试时间和发送次数。' }}
          </UiAlert>
        </div>
        <form v-if="(canReview && reply.status === 'WAITING' && reply.content) || canClose"
          @submit.prevent="submit(canClose ? 'CLOSE' : 'APPROVE')">
          <UiAlert v-if="canClose" tone="warning">请先核对 Newbi 上的发送结果。结案会停止对此提案的发送尝试。</UiAlert>
          <UiAlert v-else-if="reply.connectorAvailable" tone="warning">批准后，管理员可确认向上述 Newbi 帖子公开发布这条回复。</UiAlert>
          <UiAlert v-else tone="warning">当前 Newbi 配置无法使用此账号。请在插件中心核对启用状态和 Agent API 地址。</UiAlert>
          <UiField :label="canClose ? '结案理由' : '审批理由（选填）'" for="connector-reason">
            <textarea class="ui-control" :placeholder="canClose ? '例如：已人工核对发送结果' : '例如：已核对回复内容和目标'" v-model="reason" :rows="2" :maxlength="240" :disabled="submitting"
              id="connector-reason" :required="canClose"></textarea>
          </UiField>
          <div class="connector-actions">
            <UiButton v-if="canClose || reply.connectorAvailable" :tone="canClose ? 'warning' : 'primary'"
              type="submit" :disabled="submitting || (canClose && !reason.trim())">
              {{ canClose ? '确认结案' : '批准公开回复' }}
            </UiButton>
            <UiButton v-if="reply.status === 'WAITING'" tone="error" :disabled="submitting" @click="submit('REJECT')">拒绝</UiButton>
          </div>
        </form>
      </template>
    </section>
  </div>
  <UiDialog v-model:open="confirmation" :title="canRetry ? '确认重试公开回复' : '确认发送公开回复'"
    :dismiss-outside="!submitting" :busy="submitting">
    <div v-if="reply" class="send-preview">
      <p>{{ canRetry ? '请先核对 Newbi 上的评论。重试会沿用原提案的发送编号。' : '这条回复将发布到真实 Newbi 帖子，所有能查看该帖的人都可见。' }}</p>
      <dl>
        <div><dt>平台</dt><dd>Newbi · {{ reply.endpoint }}</dd></div>
        <div><dt>身份</dt><dd>{{ reply.identity || reply.identityId }}</dd></div>
        <div><dt>Agent ID</dt><dd>{{ reply.agentId }}</dd></div>
        <div><dt>帖子 ID</dt><dd>{{ reply.postId }}</dd></div>
      </dl>
      <p class="console-payload">{{ reply.content }}</p>
    </div>
    <div class="connector-actions send-confirm-actions">
      <UiButton :disabled="submitting" @click="confirmation = false">取消</UiButton>
      <UiButton tone="primary" :disabled="!canSend || submitting" :loading="submitting" @click="send">
        {{ canRetry ? '确认重试' : '确认发送' }}
      </UiButton>
    </div>
  </UiDialog>
</template>

<style scoped>
.connector-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.send-actions { margin-block: 1rem; }
.send-confirm-actions { justify-content: flex-end; margin-top: .875rem; }
.send-preview { max-height: min(55dvh, 32rem); overflow: auto; }
.thread-preview { margin-block: 1rem; overflow-wrap: anywhere; }
.thread-preview h4 { margin: 0; }
.thread-content { margin-block-start: .5rem; }
.thread-preview summary { cursor: pointer; }
.thread-comments { list-style: decimal; padding-inline-start: 2rem; }
.thread-comments .console-payload { margin-block-start: .375rem; }
.filter { width: min(10rem, 100%); }
dl { display: grid; gap: .4rem; }
dl > div { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: .5rem; }
dd { margin: 0; }
dd { overflow-wrap: anywhere; }
.ui-alert + .ui-field { margin-block-start: .875rem; }
h4 { margin-bottom: .5rem; }
</style>
