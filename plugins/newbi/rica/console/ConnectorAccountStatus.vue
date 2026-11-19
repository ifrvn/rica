
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { UiAlert, UiButton, UiEmpty, UiField, UiSpinner, UiBadge } from '@ricajs/console-shared/ui'
import type { z } from '@hono/zod-openapi'
import { newbiReplyInput, type newbiAssessmentList, type newbiAssessmentView, type newbiInboxView, type newbiPollView } from '../management/contracts.js'
import { characterPath, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request, RequestError } from '@ricajs/console-shared/request'

type Inbox = z.infer<typeof newbiInboxView>
type Assessment = z.infer<typeof newbiAssessmentView>
const props = defineProps<{ characterId: string; accountId: string; accountStatus: string; accountLabel: string; identityLabel: string;
  canReview: boolean; canPropose: boolean }>()
const emit = defineEmits<{ expired: []; proposals: [accountId: string, proposalId?: string] }>()
const inbox = ref<Inbox>()
const busy = ref(false)
const error = ref('')
const polling = ref(false)
const pollNotice = ref('')
const pollError = ref('')
let active = true
const base = characterPath(props.characterId) + '/newbi'
const eventsPath = base + '/accounts/' + encodeURIComponent(props.accountId) + '/events'
const assessmentPost = ref('')
const assessments = ref<Assessment[]>([])
const assessmentBusy = ref(false)
const assessmentError = ref('')
let assessmentRequest: { postId: string; key: string } | undefined
const discussions = computed(() => {
  const grouped = new Map<string, Inbox['items']>()
  for (const event of inbox.value?.items ?? []) {
    const group = grouped.get(event.postId)
    if (group) group.push(event)
    else grouped.set(event.postId, [event])
  }
  return [...grouped].map(([postId, events]) => ({ postId, events, latest: events[0]! }))
})
const composer = ref(false)
const composerHeading = ref<HTMLElement>()
const postId = ref('')
const content = ref('')
let composerTrigger: HTMLElement | undefined
const { busy: submitting, error: submitError, run, command } = useConsoleTask(() => emit('expired'))
const draft = computed(() => newbiReplyInput.safeParse({
  accountId: props.accountId, postId: postId.value.trim(), content: content.value,
}))
const invalidPost = computed(() => !!postId.value.trim() && !draft.value.success
  && draft.value.error.issues.some(({ path }) => path[0] === 'postId'))
const invalidContent = computed(() => !!content.value.trim() && !draft.value.success
  && draft.value.error.issues.some(({ path }) => path[0] === 'content'))

const kinds = { POST_REPLIED: '帖子收到回复', COMMENT_REPLIED: '评论收到回复', AGENT_MENTIONED: '被提及' }
const participationLabels = { talkative: '话痨', balanced: '适中', reserved: '寡言' }
const assessmentLabels = { SUGGEST_REPLY: '建议回应', NO_REPLY: '本帖暂不回应', UNAVAILABLE: '评估未完成', PENDING: '评估中' }
const assessmentReasons: Partial<Record<string, string>> = {
  DIRECT_QUESTION: '直接提问', SUBSTANTIVE_CORRECTION: '实质纠错', FOLLOW_UP: '需要跟进', RELEVANT_DISCUSSION: '值得补充',
  ALREADY_ANSWERED: '已有人回答', LOW_VALUE: '无需接话', OUT_OF_SCOPE: '与身份无关', INSUFFICIENT_CONTEXT: '上下文不足',
  THREAD_LOCKED: '帖子已锁定',
}
const format = (value: string) => new Date(value).toLocaleString()

async function showAssessments(post: string, evaluate = false) {
  if (assessmentBusy.value || (evaluate && (!props.canPropose || props.accountStatus !== 'ACTIVE'))) return
  if (assessmentPost.value !== post) assessments.value = []
  assessmentPost.value = post
  assessmentBusy.value = true
  assessmentError.value = ''
  const path = `${base}/accounts/${encodeURIComponent(props.accountId)}/discussions/${encodeURIComponent(post)}/assessments`
  try {
    if (evaluate) {
      if (assessmentRequest?.postId !== post) assessmentRequest = { postId: post, key: crypto.randomUUID() }
      await request(path, { method: 'POST', headers: { 'Idempotency-Key': assessmentRequest.key } }, 25_000)
      assessmentRequest = undefined
    }
    const list = await request<z.infer<typeof newbiAssessmentList>>(path)
    if (active) assessments.value = list.items
  } catch (cause) {
    if (!active) return
    if (cause instanceof RequestError && cause.status === 401) emit('expired')
    else if (cause instanceof RequestError && [403, 404, 409].includes(cause.status)) {
      assessmentRequest = undefined
      assessmentError.value = '讨论或账号当前不可评估，请刷新读取状态后重试。'
    } else assessmentError.value = '无法读取评估记录，请重试。'
  } finally {
    assessmentBusy.value = false
  }
}

async function load() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await request<Inbox>(eventsPath)
    if (active) inbox.value = result
  } catch (cause) {
    if (!active) return
    inbox.value = undefined
    if (cause instanceof RequestError && cause.status === 401) emit('expired')
    else error.value = '无法读取当前账号的状态，请刷新后重试。'
  } finally {
    busy.value = false
  }
}

async function poll() {
  if (!props.canPropose || polling.value || busy.value) return
  polling.value = true
  pollNotice.value = ''
  pollError.value = ''
  try {
    const result = await request<z.infer<typeof newbiPollView>>(eventsPath + '/poll', { method: 'POST' })
    if (!active) return
    if (result.status === 'READ') pollNotice.value = result.saved ? '已保存 ' + result.saved + ' 条新事件。' : '读取完成，本次没有新事件。'
    else if (result.status === 'WAITING') pollNotice.value = '请在 ' + format(result.nextAt) + ' 后再次读取。'
    else pollError.value = '读取已停止，请核对账号状态及最近错误。'
  } catch (cause) {
    if (!active) return
    if (cause instanceof RequestError && cause.status === 401) {
      emit('expired')
      return
    }
    pollError.value = cause instanceof RequestError && cause.status === 403
      ? '当前账号无权拉取事件。' : '未能读取事件，请核对账号状态、连接配置和最近错误后重试。'
  } finally {
    if (active && (pollNotice.value || pollError.value)) await load()
    polling.value = false
  }
}

function openComposer(event: MouseEvent, target = '') {
  composerTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  postId.value = target
  submitError.value = ''
  composer.value = true
  void nextTick(() => composerHeading.value?.focus())
}

function closeComposer() {
  composer.value = false
  content.value = ''
  void nextTick(() => composerTrigger?.focus())
}

function submit() {
  const input = draft.value
  if (!props.canPropose || !input.success) return
  void run(async () => {
    try {
      const result = await command(base + '/replies', input.data)
      if (active) emit('proposals', props.accountId, result.id)
    } catch (cause) {
      if (!(cause instanceof RequestError) || cause.code !== 'PRIVATE_WRITING_PROMPT') throw cause
      if (active) submitError.value = '回复含内部写作提示，请从正文删去后再送审。'
    }
  })
}

onMounted(load)
onBeforeUnmount(() => { active = false })
</script>

<template>
  <section class="console-panel" aria-labelledby="connector-read-heading">
    <div class="console-section-heading">
      <h3 id="connector-read-heading">连接器读取状态</h3>
      <div class="connector-actions">
        <UiButton size="small" variant="quiet" :disabled="busy || polling" @click="load">刷新读取状态</UiButton>
        <UiButton v-if="canPropose" size="small" variant="soft" :loading="polling" :disabled="busy || polling" @click="poll">立即读取</UiButton>
      </div>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiSpinner v-else-if="busy && !inbox" />
    <UiAlert v-if="pollError" tone="error" role="alert">{{ pollError }}</UiAlert>
    <UiAlert v-if="pollNotice" tone="info" role="status">{{ pollNotice }}</UiAlert>
    <template v-if="inbox">
      <div class="connector-actions">
        <UiBadge :tone="inbox.readError ? 'warning' : 'default'">
          {{ accountStatus === 'ACTIVE' ? inbox.readError ? '最近读取失败'
            : inbox.lastSucceededAt ? '最近读取成功' : '尚未读取' : '当前绑定未启用' }}
        </UiBadge>
        <UiButton v-if="canReview" size="small" @click="emit('proposals', accountId)">查看此账号的提案与回执</UiButton>
        <UiButton v-if="canPropose && !composer" tone="primary" size="small" @click="openComposer($event)">拟写回复</UiButton>
      </div>
      <form v-if="composer && canPropose" class="reply-composer" aria-labelledby="newbi-composer-title" @submit.prevent="submit">
        <h4 id="newbi-composer-title" ref="composerHeading" tabindex="-1">拟写 Newbi 回复</h4>
        <p>{{ identityLabel }} · {{ accountLabel }}</p>
        <UiField label="帖子 ID" for="newbi-composer-post"
          :invalid="invalidPost" :feedback="invalidPost ? '请输入完整的帖子 ID。' : undefined">
          <input class="ui-control" v-model="postId" v-bind="{ id: 'newbi-composer-post', required: true, 'aria-invalid': invalidPost || undefined }" :disabled="submitting" />
        </UiField>
        <UiField label="拟公开回复" for="newbi-composer-content"
          :invalid="invalidContent" :feedback="invalidContent ? '回复最多 4000 字符，请检查正文。' : undefined">
          <textarea class="ui-control" v-model="content" :rows="4" v-bind="{ id: 'newbi-composer-content', required: true, 'aria-invalid': invalidContent || undefined }" :disabled="submitting"></textarea>
        </UiField>
        <p>通过审批后，回复才可进入发送流程。</p>
        <UiAlert v-if="submitError" tone="error" role="alert">{{ submitError }}</UiAlert>
        <div class="connector-actions">
          <UiButton tone="primary" type="submit" :loading="submitting" :disabled="!draft.success || submitting">提交回复提案</UiButton>
          <UiButton :disabled="submitting" @click="closeComposer">取消</UiButton>
        </div>
      </form>
      <dl>
        <div><dt>Agent ID</dt><dd>{{ inbox.agentId }}</dd></div>
        <div><dt>最近成功读取</dt><dd>{{ inbox.lastSucceededAt ? format(inbox.lastSucceededAt) : '无记录' }}</dd></div>
        <div v-if="inbox.readError"><dt>最近错误码</dt><dd><code>{{ inbox.readError }}</code></dd></div>
        <div v-if="accountStatus === 'ACTIVE' && inbox.nextPollAt"><dt>允许下次读取</dt><dd>{{ format(inbox.nextPollAt) }}</dd></div>
      </dl>
      <UiAlert v-if="inbox.historyLostCount" tone="warning" role="status">
        事件游标已重置 {{ inbox.historyLostCount }} 次。{{ inbox.lastHistoryLostAt ? '最近一次 ' + format(inbox.lastHistoryLostAt) : '' }}
      </UiAlert>
      <UiEmpty v-if="inbox.items?.length === 0" description="暂无已读取事件。" />
      <ul v-if="discussions.length" class="connector-events" aria-label="最近讨论">
        <li v-for="discussion in discussions" :key="discussion.postId">
          <div class="connector-actions">
            <strong>{{ kinds[discussion.latest.type] }}</strong>
            <time :datetime="discussion.latest.occurredAt">{{ format(discussion.latest.occurredAt) }}</time>
          </div>
          <span>帖子 {{ discussion.postId }}</span>
          <details v-if="discussion.events.length > 1">
            <summary>{{ discussion.events.length }} 条事件</summary>
            <ul>
              <li v-for="event in discussion.events" :key="event.seq">
                {{ kinds[event.type] }} · <time :datetime="event.occurredAt">{{ format(event.occurredAt) }}</time>
              </li>
            </ul>
          </details>
          <div class="connector-actions">
            <UiButton v-if="canPropose && accountStatus === 'ACTIVE'" size="small" variant="soft" :disabled="assessmentBusy || polling"
              @click="showAssessments(discussion.postId, true)">评估讨论</UiButton>
            <UiButton size="small" variant="quiet" :disabled="assessmentBusy" @click="showAssessments(discussion.postId)">评估记录</UiButton>
            <UiButton v-if="canPropose && !composer" size="small" variant="quiet" @click="openComposer($event, discussion.postId)">拟写回复</UiButton>
          </div>
          <section v-if="assessmentPost === discussion.postId" aria-label="讨论评估记录" class="assessment-history">
            <UiSpinner v-if="assessmentBusy" aria-label="正在读取讨论评估" />
            <UiAlert v-if="assessmentError" tone="error" role="alert">{{ assessmentError }}</UiAlert>
            <p v-if="!assessmentBusy && !assessmentError && !assessments.length">暂无评估记录。</p>
            <details v-for="(item, index) in assessments" :key="item.id" :open="index === 0">
              <summary>{{ assessmentLabels[item.result.status] }} · {{ format(item.createdAt) }}</summary>
              <p>{{ item.identity }} · {{ participationLabels[item.participation] }} · 仅评估</p>
              <p v-if="item.result.status !== 'PENDING'">
                <strong v-if="assessmentReasons[item.result.reason]">{{ assessmentReasons[item.result.reason] }} · </strong>{{ item.result.note }}
              </p>
              <blockquote v-if="item.result.status === 'SUGGEST_REPLY'" class="console-payload">
                <strong>{{ item.result.target.author }}</strong> · {{ item.result.target.excerpt }}
              </blockquote>
              <details v-if="item.systemPrompt">
                <summary>System Prompt · {{ item.model }}</summary>
                <pre class="console-payload">{{ item.systemPrompt }}</pre>
              </details>
            </details>
          </section>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.connector-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.reply-composer { margin-block: 1rem; }
.reply-composer h4 { margin-block: 0 .5rem; }
.reply-composer .connector-actions { margin-block-start: .75rem; }
dl { display: grid; gap: .4rem; }
dl > div { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: .5rem; }
dd { margin: 0; overflow-wrap: anywhere; }
.connector-events { list-style: none; margin: .5rem 0 0; padding: 0; }
.connector-events > li { display: grid; gap: .5rem; padding: .5rem 0; border-top: 1px solid var(--console-line); overflow-wrap: anywhere; }
.assessment-history { display: grid; gap: .5rem; min-width: 0; }
.assessment-history summary { cursor: pointer; }
.assessment-history p { margin-block: .35rem; }
</style>
