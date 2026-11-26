<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { UiAlert, UiButton, UiDialog, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { characterPath, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import type { AutoReviewTemplateView, AutoReviewView } from '@ricajs/contracts/auto-review'

const props = defineProps<{ characterId: string; identityId?: string; identityName?: string }>()
const emit = defineEmits<{
  close: []; expired: []; saved: [identityId: string, enabled: boolean, manual: boolean];
}>()
const settings = ref<AutoReviewView>()
const templates = ref<AutoReviewTemplateView[]>([])
const enabled = ref(false)
const manual = ref(false)
const templateId = ref<string | null>(null)
const { active, busy, error, run, command } = useConsoleTask(() => emit('expired'))
const base = computed(() => characterPath(props.characterId))
const path = computed(() => base.value + '/identities/' + encodeURIComponent(props.identityId ?? '') + '/auto-review')
const changed = computed(() => settings.value && (enabled.value !== settings.value.enabled
  || manual.value !== settings.value.imManualReviewEnabled || templateId.value !== settings.value.templateId))

function load() {
  const id = props.identityId
  if (!id) return
  void run(async () => {
    const [current, rules] = await Promise.all([
      request<AutoReviewView>(path.value),
      request<AutoReviewTemplateView[]>(base.value + '/auto-review/templates'),
    ])
    if (!active() || id !== props.identityId) return
    settings.value = current
    templates.value = rules
    enabled.value = current.enabled
    manual.value = current.imManualReviewEnabled
    templateId.value = current.templateId
  })
}

watch(() => props.identityId, (id) => {
  if (!id) return
  settings.value = undefined
  load()
})

function save() {
  const id = props.identityId
  const current = settings.value
  if (!id || !current || !changed.value) return
  const input = { enabled: enabled.value, imManualReviewEnabled: manual.value, templateId: templateId.value }
  void run(async () => {
    await command(path.value, input, 'PUT', current.version)
    if (!active() || id !== props.identityId) return
    emit('saved', id, input.enabled, input.imManualReviewEnabled)
    emit('close')
  })
}
</script>

<template>
  <UiDialog :open="!!identityId" :title="'自动审批设置 · ' + (identityName ?? '')" :busy="busy"
    @update:open="!$event && emit('close')">
    <UiAlert v-if="error" tone="error" role="alert">
      {{ error }}
      <UiButton variant="quiet" size="small" @click="load">重新读取设置</UiButton>
    </UiAlert>
    <UiSpinner v-if="busy && !settings" aria-label="正在读取自动审批设置" />
    <form v-if="settings" class="review-form" @submit.prevent="save">
      <label class="review-toggle">
        <span>自动审批</span>
        <input v-model="enabled" type="checkbox" role="switch" :disabled="busy" />
      </label>
      <p v-if="enabled && !settings.model" class="review-warning">部署尚未配置可用的审核模型。</p>
      <p v-else-if="enabled && settings.model" class="review-hint">{{ [settings.model.name, settings.model.provider, settings.model.model].filter(Boolean).join(' · ') }}</p>
      <label class="review-toggle">
        <span>IM 人工复核</span>
        <input v-model="manual" type="checkbox" role="switch" aria-describedby="identity-review-manual-hint" :disabled="busy" />
      </label>
      <p id="identity-review-manual-hint" class="review-hint">关闭后，未获自动批准的 IM 回复将取消。</p>
      <UiField label="审批规则" for="identity-review-template">
        <select id="identity-review-template" v-model="templateId" class="ui-control" :disabled="busy">
          <option :value="null">内置默认规则</option>
          <option v-for="rule in templates" :key="rule.id" :value="rule.id">{{ rule.name }}</option>
        </select>
      </UiField>
      <div class="review-actions">
        <UiButton type="submit" tone="primary" :disabled="busy || !changed">保存设置</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.review-form { display: grid; gap: .75rem; }
.review-toggle { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-block-size: 2rem; }
.review-toggle input { inline-size: 1.25rem; block-size: 1.25rem; accent-color: var(--console-accent-text); }
.review-hint, .review-warning { margin: -.375rem 0 0; font-size: .8125rem; overflow-wrap: anywhere; }
.review-hint { color: var(--console-muted); }
.review-warning { color: var(--console-warning); }
.review-actions { display: flex; justify-content: flex-end; }
</style>
