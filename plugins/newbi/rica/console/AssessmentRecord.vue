<script setup lang="ts">
import type { z } from '@hono/zod-openapi'
import type { newbiAssessmentView } from '../management/contracts.js'

defineProps<{ item: z.infer<typeof newbiAssessmentView> }>()

const participationLabels = { talkative: '话痨', balanced: '适中', reserved: '寡言' }
const assessmentReasons: Partial<Record<string, string>> = {
  DIRECT_QUESTION: '直接提问', SUBSTANTIVE_CORRECTION: '实质纠错', FOLLOW_UP: '需要跟进', RELEVANT_DISCUSSION: '值得补充',
  ALREADY_ANSWERED: '已有人回答', LOW_VALUE: '无需接话', OUT_OF_SCOPE: '与身份无关', INSUFFICIENT_CONTEXT: '上下文不足',
  THREAD_LOCKED: '帖子已锁定',
}
</script>

<template>
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
  <p v-else>此记录未捕获模型调用的 System Prompt。</p>
</template>
