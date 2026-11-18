<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { UiAlert, UiButton, UiDialog, UiField, UiSpinner } from '@rica/console-shared/ui'
import { characterPath, useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'
import { defaultAutoReviewPrompt, type AutoReviewSettings } from '../../../../../packages/contracts/auto-review.js'

const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: [] }>()
const open = ref(false)
const settings = ref<AutoReviewSettings>()
const enabled = ref(false)
const prompt = ref('')
const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = characterPath(props.characterId) + '/auto-review'
const changed = computed(() => settings.value
  && (enabled.value !== settings.value.enabled || prompt.value.trim() !== settings.value.prompt))

function load() {
  void run(async () => {
    const current = await request<AutoReviewSettings>(path)
    if (!active()) return
    settings.value = current
    enabled.value = current.enabled
    prompt.value = current.prompt
  })
}

watch(open, (shown) => { if (shown) load() })

function save() {
  const current = settings.value
  const input = { enabled: enabled.value, prompt: prompt.value.trim() }
  if (!current || !input.prompt || !changed.value) return
  void run(async () => {
    const result = await request<{ version: number }>(path, {
      method: 'PUT', body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"' + current.version + '"' },
    })
    if (!active()) return
    settings.value = { ...input, version: result.version }
    notice.value = '已保存自动审批设置。'
  })
}
</script>

<template>
  <UiButton size="small" @click="open = true">自动审批设置</UiButton>
  <UiDialog v-model:open="open" title="自动审批设置" :busy="busy">
    <UiAlert v-if="error" tone="error">
      {{ error }}
      <UiButton size="small" variant="quiet" @click="load">重新读取设置</UiButton>
    </UiAlert>
    <UiAlert v-if="notice" tone="success">{{ notice }}</UiAlert>
    <UiSpinner v-if="busy && !settings" />
    <form v-if="settings" class="auto-review-form" @submit.prevent="save">
      <label class="auto-review-toggle">
        <input v-model="enabled" type="checkbox" :disabled="busy" />
        启用此角色的自动审批
      </label>
      <p>符合条件的公开回复及讨论内容会交给部署默认的外部模型审核。需要复核的提案进入人工队列，真实平台的发送仍由管理员触发。</p>
      <UiField label="审核提示词" for="auto-review-prompt" feedback="最多 4000 字符">
        <textarea id="auto-review-prompt" v-model="prompt" rows="8" maxlength="4000" required :disabled="busy" />
      </UiField>
      <div class="auto-review-actions">
        <UiButton variant="quiet" :disabled="busy || prompt === defaultAutoReviewPrompt"
          @click="prompt = defaultAutoReviewPrompt">恢复默认提示词</UiButton>
        <UiButton type="submit" tone="primary" :disabled="busy || !changed || !prompt.trim()">保存设置</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.auto-review-form { display: grid; gap: 0.875rem; }
.auto-review-toggle { display: flex; align-items: center; gap: 0.5rem; }
.auto-review-form p { margin: 0; }
.auto-review-form textarea { width: 100%; resize: vertical; }
.auto-review-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; }
</style>
