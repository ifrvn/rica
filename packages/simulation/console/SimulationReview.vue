<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { UiAlert, UiBadge, UiButton, UiEmpty, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { focusRecord, formatTime } from '@ricajs/console-shared/console-data'
import { autoReviewHandoffLabels } from '@ricajs/contracts/auto-review'
import type { ActionView } from '../contracts/review.js'

const props = defineProps<{
  actions: ActionView[]
  nextCursor: string | null
  selected?: ActionView
  detailId?: string
  reviewStatus?: string
  reviewHistory: boolean
  routing: boolean
  busy: boolean
  error: string
}>()
const reason = defineModel<string>('reason', { required: true })
const emit = defineEmits<{
  refresh: [append?: boolean]
  filter: [status: string]
  open: [id?: string]
  run: [id: string]
  decide: [decision: 'APPROVE' | 'REJECT']
}>()

const reviewListHeading = ref<HTMLElement>()
const reviewDetailHeading = ref<HTMLElement>()
watch(() => props.detailId, (id, previous) => {
  if (id === previous) return
  void nextTick(() => {
    if (reviewListHeading.value && id === props.detailId) focusRecord('review-row-', id, previous,
      reviewDetailHeading.value, reviewListHeading.value)
  })
}, { immediate: true })

const statusText: Record<ActionView['state'], string> = {
  WAITING_APPROVAL: '待审批', READY: '已批准', REJECTED: '已拒绝', CANCELED: '已失效', EXPIRED: '已过期',
  EXECUTING: '模拟执行中', RECONCILING: '待对账', SIMULATED: '模拟完成', BLOCKED: '执行已拦截',
}

function statusTone(state: ActionView['state']) {
  if (state === 'WAITING_APPROVAL' || state === 'RECONCILING') return 'warning'
  if (state === 'READY' || state === 'SIMULATED') return 'success'
  if (state === 'BLOCKED' || state === 'REJECTED') return 'error'
  return 'default'
}
</script>

<template>
  <div class="console-split console-record-workspace" :class="{ 'console-split--detail': detailId }">
    <section class="console-split-list" aria-labelledby="review-list-heading">
      <div class="console-section-heading">
        <h3 id="review-list-heading" ref="reviewListHeading" tabindex="-1">模拟提案</h3>
        <UiButton size="small" variant="quiet" :disabled="busy || routing" @click="emit('refresh')">刷新</UiButton>
      </div>
      <UiField label="审批状态" for="simulation-review-status">
        <select id="simulation-review-status" class="ui-control" :value="reviewHistory ? reviewStatus : 'WAITING'"
          @change="emit('filter', ($event.target as HTMLSelectElement).value)">
          <option value="WAITING">待审批</option>
          <option value="HISTORY">审批历史</option>
          <option value="APPROVE">已批准</option>
          <option value="REJECT">已拒绝</option>
        </select>
      </UiField>
      <UiSpinner v-if="routing && !actions.length" aria-label="正在加载提案" />
      <UiEmpty v-else-if="!actions.length && !busy && !error" :description="reviewHistory ? '暂无符合条件的审批记录。' : '暂无待审批提案。'" />
      <ul v-if="actions.length" class="console-select-list">
        <li v-for="item in actions" :key="item.id">
          <button :id="'review-row-' + item.id" type="button" class="console-record" :disabled="busy"
            :aria-current="detailId === item.id ? 'true' : undefined" @click="emit('open', item.id)">
            <span class="console-record-main">
              <strong>{{ item.target.identity }}</strong>
              <span>{{ item.target.platform }} · {{ item.target.account }}</span>
              <span class="console-record-meta">{{ item.target.audience === 'PUBLIC' ? '公开' : '私聊' }} · {{ item.target.conversation }}</span>
              <time v-if="item.review" class="console-record-meta" :datetime="item.review.at">{{ formatTime(item.review.at) }}</time>
            </span>
            <UiBadge v-if="item.autoReviewPending" tone="info">AI 审核中</UiBadge>
            <UiBadge v-else-if="item.review" :tone="item.review.decision === 'APPROVE' ? 'success' : 'error'">
              {{ item.autoApproved ? 'AI 已批准' : item.review.decision === 'APPROVE' ? '人工已批准' : '已拒绝' }}
            </UiBadge>
            <UiBadge v-else :tone="statusTone(item.state)">{{ statusText[item.state] }}</UiBadge>
          </button>
        </li>
      </ul>
      <UiButton v-if="nextCursor" size="small" variant="quiet" :disabled="busy" @click="emit('refresh', true)">加载更多</UiButton>
    </section>

    <section v-if="detailId" class="console-split-detail proposal" aria-labelledby="review-detail-heading">
      <div class="console-section-heading">
        <h3 id="review-detail-heading" ref="reviewDetailHeading" tabindex="-1">模拟回复</h3>
        <UiButton size="small" variant="quiet" :disabled="busy" @click="emit('open')">返回列表</UiButton>
      </div>
      <UiSpinner v-if="routing && !selected" aria-label="正在加载提案" />
      <div v-if="selected" class="console-actions proposal-actions">
        <UiBadge>模拟执行</UiBadge>
        <UiBadge :tone="statusTone(selected.state)">{{ statusText[selected.state] }}</UiBadge>
        <UiButton size="small" variant="quiet" :disabled="busy" @click="emit('open', selected.id)">重新核对</UiButton>
        <UiButton size="small" variant="quiet" :disabled="busy" @click="emit('run', selected.runId)">查看模拟运行</UiButton>
      </div>
      <UiButton v-else-if="error" size="small" :disabled="busy" @click="emit('open', detailId)">重新加载提案</UiButton>
      <template v-if="selected">
        <dl class="metadata">
          <div><dt>平台</dt><dd>{{ selected.target.platform }} / {{ selected.target.instance }}</dd></div>
          <div><dt>身份与账号</dt><dd>{{ selected.target.identity }} / {{ selected.target.account }}</dd></div>
          <div><dt>目标</dt><dd>{{ selected.target.conversation }} / {{ selected.target.message }}</dd></div>
          <div><dt>受众</dt><dd>{{ selected.target.audience === 'PUBLIC' ? '公开' : '私聊' }}<template v-if="selected.target.contact"> · {{ selected.target.contact }}</template></dd></div>
          <div v-if="selected.review"><dt>审批决定</dt><dd>{{ selected.autoApproved ? 'AI 已批准' : selected.review.decision === 'APPROVE' ? '人工已批准' : '人工已拒绝' }} · {{ formatTime(selected.review.at) }}</dd></div>
          <div v-if="selected.review?.reason"><dt>审批理由</dt><dd>{{ selected.review.reason }}</dd></div>
        </dl>
        <UiAlert v-if="selected.autoReviewPending" tone="info">AI 审核中，结果会自动更新。</UiAlert>
        <UiAlert v-if="!selected.autoReviewHandoff && selected.riskCodes.includes('CROSS_PLATFORM_NEAR_DUPLICATE')" tone="warning">
          此回复与其他平台的内容相似，请核对后再审批。
        </UiAlert>
        <template v-if="selected.content">
          <section aria-labelledby="simulation-context-heading">
            <h4 id="simulation-context-heading">原消息</h4>
            <template v-if="selected.messageContext">
              <p class="console-record-meta">
                {{ selected.messageContext.trigger.sender ? selected.messageContext.trigger.sender + ' · ' : '' }}
                {{ formatTime(selected.messageContext.trigger.occurredAt) }}
              </p>
              <p v-if="selected.messageContext.trigger.content" class="console-payload">{{ selected.messageContext.trigger.content }}</p>
              <p v-else class="console-record-meta">原消息正文已过保留期或不可用。</p>
              <details v-if="selected.messageContext.previous.length">
                <summary>查看同一会话此前的 {{ selected.messageContext.previous.length }} 条消息</summary>
                <ol class="review-context-list">
                  <li v-for="message in selected.messageContext.previous" :key="message.id">
                    <div class="console-record-meta">{{ message.sender ? message.sender + ' · ' : '' }}{{ formatTime(message.occurredAt) }}</div>
                    <p class="console-payload">{{ message.content }}</p>
                  </li>
                </ol>
              </details>
            </template>
            <p v-else class="console-record-meta">当前无法读取原消息。</p>
          </section>
          <h4>拟回复内容</h4>
          <p class="console-payload">{{ selected.content }}</p>
          <UiAlert v-if="selected.followUp" tone="info">
            <strong>{{ selected.followUp.kind === 'PLAN' ? 'AI 拟定计划' : 'AI 拟登记承诺' }} · {{ selected.followUp.title }}</strong>
            <p>{{ selected.followUp.task }}</p>
            <p v-if="selected.followUp.dailyAt">每日 {{ selected.followUp.dailyAt }} · {{ selected.followUp.zone }}</p>
            <p v-else-if="selected.followUp.dueAt">截止 {{ new Date(selected.followUp.dueAt).toLocaleString() }}</p>
            <ul v-if="selected.followUp.participants?.length" class="follow-up-participants">
              <li v-for="participant in selected.followUp.participants" :key="participant.accountId">
                <strong>{{ participant.identity }} · {{ participant.platform }} / {{ participant.account }}</strong>
                <span v-if="participant.task">{{ participant.task }}</span>
              </li>
            </ul>
            <p>批准后，模拟回执确认且参与账号仍有效时自动登记。</p>
          </UiAlert>
        </template>
        <p v-else-if="selected.state === 'WAITING_APPROVAL'">当前无法预览正文，暂不能审批。</p>
        <UiAlert v-if="selected.content && selected.autoReviewHandoff && selected.state === 'WAITING_APPROVAL'" tone="warning">
          <strong>{{ autoReviewHandoffLabels[selected.autoReviewHandoff.status] }}</strong>
          <p>{{ selected.autoReviewHandoff.reason }}</p>
          <small v-if="selected.autoReviewHandoff.model">审核模型 {{ selected.autoReviewHandoff.model }}</small>
        </UiAlert>
        <form v-if="selected.state === 'WAITING_APPROVAL' && selected.content && !selected.autoReviewPending"
          @submit.prevent="emit('decide', 'APPROVE')">
          <UiField label="审批理由（选填）" for="review-reason">
            <textarea class="ui-control" v-model="reason" :rows="3" :maxlength="240"
              id="review-reason" :disabled="busy" placeholder="例如：已核对目标和拟发送内容"></textarea>
          </UiField>
          <div class="decision-buttons">
            <UiButton tone="primary" type="submit" :disabled="busy">
              {{ selected.followUp ? '批准回复及后续事项' : '批准模拟回复' }}
            </UiButton>
            <UiButton tone="error" :disabled="busy" @click="emit('decide', 'REJECT')">拒绝</UiButton>
          </div>
        </form>
      </template>
    </section>
  </div>
</template>

<style scoped>
.decision-buttons { display: flex; gap: .625rem; align-items: center; flex-wrap: wrap; }
.proposal-actions { margin-bottom: .75rem; }
.review-context-list { display: grid; gap: .75rem; margin-block: .75rem; padding-inline-start: 1.5rem; }
.review-context-list .console-payload { margin-block: .25rem 0; }
.metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem 1.25rem; margin: 0 0 1rem; }
.metadata dt { color: var(--console-muted); font-size: .8125rem; }
.metadata dd { margin: .125rem 0 0; overflow-wrap: anywhere; }
.proposal h4 { margin: 0 0 .375rem; font-size: .875rem; }
.follow-up-participants { margin-block: .5rem; padding-inline-start: 1rem; overflow-wrap: anywhere; }
.follow-up-participants span { display: block; }
.decision-buttons { margin-block-start: .75rem; }
@media (max-width: 30rem) {
  .metadata { grid-template-columns: minmax(0, 1fr); }
}
</style>
