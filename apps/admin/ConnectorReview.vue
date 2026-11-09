<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { NewbiReplyView, newbiReplySummary } from '../../packages/contracts/newbi-pilot.js'
import { request, RequestError } from './request.js'

type Summary = z.infer<typeof newbiReplySummary>
type Page = { items: Summary[]; nextCursor: string | null }
const props = defineProps<{ characterId: string; detailId?: string; accountId?: string; canReview: boolean; canClose: boolean }>()
const emit = defineEmits<{ expired: []; open: [id: string]; all: [] }>()
const base = '/v1/characters/' + encodeURIComponent(props.characterId) + '/newbi/replies'
const statusText: Record<Summary['status'], string> = {
  WAITING: '待审', READY: '待发送', REJECTED: '已拒绝', IN_FLIGHT: '发送中',
  UNKNOWN: '待核对', SENT: '已发送', CLOSED: '已结案',
}
const options = [{ label: '全部状态', value: '' }, ...Object.entries(statusText).map(([value, label]) => ({ label, value }))]
const filter = ref('WAITING')
const rows = ref<Summary[]>([])
const cursor = ref<string | null>(null)
const reply = ref<NewbiReplyView>()
const reason = ref('')
const loadingList = ref(false)
const loadingDetail = ref(false)
const submitting = ref(false)
const listError = ref('')
const detailError = ref('')
const notice = ref('')
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

function changeFilter(value: string) {
  filter.value = value
  rows.value = []
  cursor.value = null
  void list()
}

async function detail(id?: string) {
  const current = ++selection
  reply.value = undefined
  detailError.value = ''
  loadingDetail.value = !!id
  if (!id) return
  try {
    const view = await request<NewbiReplyView>(base + '/' + encodeURIComponent(id))
    if (!active || current !== selection) return
    if (props.accountId && props.accountId !== view.accountId) {
      detailError.value = '找不到当前账号的提案。'
    } else reply.value = view
  } catch (cause) {
    if (active && current === selection) detailError.value = message(cause)
  } finally { if (current === selection) loadingDetail.value = false }
}

watch([() => props.detailId, () => props.accountId], ([id]) => {
  reason.value = ''
  pending = undefined
  notice.value = ''
  void detail(id)
}, { immediate: true })

async function submit(action: 'APPROVE' | 'REJECT' | 'CLOSE') {
  const item = reply.value
  const note = reason.value.trim()
  if (!item || !note || submitting.value || loadingDetail.value
    || (action === 'CLOSE' ? !props.canClose || item.status !== 'UNKNOWN'
      : !props.canReview || item.status !== 'WAITING' || !item.content)) return
  const payload = action === 'CLOSE' ? { reason: note } : { reason: note, decision: action, reviewDigest: item.reviewDigest }
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

watch(() => props.accountId, () => {
  rows.value = []
  cursor.value = null
  void list()
})
onMounted(() => { void list() })
</script>

<template>
  <section class="connector-review" aria-label="本机连接器审批">
    <NCard :title="accountId ? '当前账号的提案' : '本机连接器提案'" size="small">
      <template v-if="accountId" #header-extra><NButton size="small" @click="emit('all')">查看全部账号</NButton></template>
      <div class="connector-actions">
        <label for="connector-filter">状态</label>
        <NSelect :value="filter" :options="options" :input-props="{ id: 'connector-filter' }"
          class="filter" :disabled="loadingList || submitting" @update:value="changeFilter" />
        <NButton :disabled="loadingList || submitting" size="small" @click="list()">刷新列表</NButton>
      </div>
      <NAlert v-if="listError" type="error" role="alert">{{ listError }}</NAlert>
      <NSpin v-if="loadingList && !rows.length" />
      <NEmpty v-else-if="!rows.length && !listError" description="暂无符合条件的提案。" />
      <ul v-if="rows.length">
        <li v-for="item in rows" :key="item.id" class="connector-actions">
          <NButton quaternary :disabled="submitting" :aria-pressed="detailId === item.id" @click="emit('open', item.id)">
            {{ item.identity }} · {{ new Date(item.createdAt).toLocaleString() }}
          </NButton>
          <NTag size="small">{{ statusText[item.status] }}</NTag>
          <span class="post-id">{{ item.postId }}</span>
        </li>
      </ul>
      <NButton v-if="cursor" size="small" :disabled="loadingList || submitting" @click="list(true)">加载更多</NButton>
    </NCard>
    <NCard v-if="detailId" title="回复详情" size="small">
      <template #header-extra>
        <NButton size="small" :disabled="loadingDetail || submitting" @click="detail(detailId)">重新核对</NButton>
      </template>
      <NAlert v-if="detailError" type="error" role="alert">{{ detailError }}</NAlert>
      <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
      <NSpin v-if="loadingDetail" />
      <template v-if="reply">
        <NTag size="small">{{ statusText[reply.status] }}</NTag>
        <dl>
          <div><dt>平台</dt><dd>本机连接器 · {{ reply.endpoint }}</dd></div>
          <div><dt>身份</dt><dd>{{ reply.identityId }}</dd></div>
          <div><dt>账号</dt><dd>{{ reply.accountId }} · {{ reply.agentId }}</dd></div>
          <div><dt>目标</dt><dd>{{ reply.postId }} · 公开回复</dd></div>
          <div><dt>到期</dt><dd>{{ new Date(reply.expiresAt).toLocaleString() }}</dd></div>
          <div v-if="reply.remoteCommentId"><dt>评论回执</dt><dd>{{ reply.remoteCommentId }}</dd></div>
          <div v-if="reply.closureReason"><dt>结案理由</dt><dd>{{ reply.closureReason }}</dd></div>
        </dl>
        <p v-if="reply.content" class="reply-content">{{ reply.content }}</p>
        <NForm v-if="(canReview && reply.status === 'WAITING' && reply.content) || (canClose && reply.status === 'UNKNOWN')"
          @submit.prevent="submit(reply.status === 'UNKNOWN' ? 'CLOSE' : 'APPROVE')">
          <p v-if="reply.status === 'UNKNOWN'">结案会停止对此提案的发送尝试。</p>
          <NFormItem :label="reply.status === 'UNKNOWN' ? '结案理由' : '审批理由'" :label-props="{ for: 'connector-reason' }">
            <NInput v-model:value="reason" type="textarea" :rows="2" :maxlength="240" :disabled="submitting"
              :input-props="{ id: 'connector-reason' }" />
          </NFormItem>
          <div class="connector-actions">
            <NButton type="primary" attr-type="submit" :disabled="submitting || !reason.trim()">
              {{ reply.status === 'UNKNOWN' ? '确认结案' : '批准回复' }}
            </NButton>
            <NButton v-if="reply.status === 'WAITING'" :disabled="submitting || !reason.trim()" @click="submit('REJECT')">拒绝</NButton>
          </div>
        </NForm>
      </template>
    </NCard>
  </section>
</template>

<style scoped>
.connector-review { display: grid; gap: 1rem; margin-top: 1rem; }
.connector-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.filter { width: min(10rem, 100%); }
ul { list-style: none; margin: .5rem 0; padding: 0; }
li + li { border-top: 1px solid #e0e8e7; }
dl { display: grid; gap: .4rem; }
dl > div { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: .5rem; }
dd { margin: 0; }
dd, .post-id, .reply-content { overflow-wrap: anywhere; }
.reply-content { white-space: pre-wrap; }
</style>
