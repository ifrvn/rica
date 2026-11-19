<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { UiAlert, UiButton, UiSpinner } from '@ricajs/console-shared/ui'
import { characterPath, formatTime, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import type { z } from '@hono/zod-openapi'
import type { newbiAssessmentView } from '../management/contracts.js'
import { assessmentStatusLabels } from './activity-labels.js'
import AssessmentRecord from './AssessmentRecord.vue'

type Assessment = z.infer<typeof newbiAssessmentView>
const props = defineProps<{ characterId: string; assessmentId: string }>()
const emit = defineEmits<{ expired: [] }>()
const item = ref<Assessment>()
const { run, busy, error } = useConsoleTask(() => emit('expired'))
function load() {
  return run(async () => {
    item.value = await request<Assessment>(`${characterPath(props.characterId)}/newbi/assessments/${props.assessmentId}`)
  })
}
onMounted(load)
</script>

<template>
  <UiSpinner v-if="busy" aria-label="正在读取讨论评估" />
  <UiAlert v-else-if="error" tone="error" role="alert">{{ error }} <UiButton size="small" @click="load">重试</UiButton></UiAlert>
  <section v-else-if="item" class="console-card" aria-label="Newbi 讨论评估">
    <h2>Newbi · {{ assessmentStatusLabels[item.result.status] }}</h2>
    <p>{{ formatTime(item.createdAt) }}</p>
    <AssessmentRecord :item />
  </section>
</template>
