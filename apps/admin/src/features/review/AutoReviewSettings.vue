<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { UiAlert, UiButton, UiDialog, UiField, UiSpinner } from '@rica/console-shared/ui'
import { characterPath, useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'
import { defaultAutoReviewPrompt, type AutoReviewView } from '../../../../../packages/contracts/auto-review.js'

const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: [] }>()
const open = ref(false)
const settings = ref<AutoReviewView>()
const enabled = ref(false)
const prompt = ref('')
const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = characterPath(props.characterId) + '/auto-review'
const changed = computed(() => settings.value
  && (enabled.value !== settings.value.enabled || prompt.value.trim() !== settings.value.prompt))

function load() {
  void run(async () => {
    const current = await request<AutoReviewView>(path)
    if (!active()) return
    settings.value = current
    enabled.value = current.enabled
    prompt.value = current.prompt
  })
}

watch(open, (shown) => {
  if (!shown) return
  settings.value = undefined
  load()
})

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
    settings.value = { ...current, ...input, version: result.version }
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
      <div class="auto-review-option">
        <label class="auto-review-toggle">
          <span>启用此角色的自动审批</span>
          <input v-model="enabled" class="auto-review-switch" type="checkbox" role="switch"
            aria-describedby="auto-review-description" :disabled="busy" />
        </label>
        <p id="auto-review-description">符合条件的公开回复及讨论内容会交给部署默认的外部模型审核。需复核的提案进入人工队列，真实平台的发送由管理员触发。</p>
        <dl v-if="settings.model" class="auto-review-model">
          <dt>审核模型</dt>
          <dd>{{ [settings.model.name, settings.model.provider, settings.model.model].filter(Boolean).join(' · ') }}</dd>
        </dl>
        <p v-else class="auto-review-model-warning">没有有效的默认外部模型配置，提案将由人工审批。</p>
      </div>
      <UiField class="auto-review-field" label="审核提示词" for="auto-review-prompt">
        <textarea id="auto-review-prompt" v-model="prompt" class="ui-control auto-review-prompt" rows="8"
          maxlength="4000" aria-describedby="auto-review-prompt-length" required :disabled="busy" />
        <template #feedback>
          <span id="auto-review-prompt-length">{{ prompt.length }} / 4000 字符</span>
        </template>
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
.auto-review-form { display: grid; gap: 1rem; }
.auto-review-option { padding: .75rem; border-radius: 6px; background: var(--console-hover); }
.auto-review-option p { margin: .375rem 0 0; color: var(--console-muted); font-size: .875rem; }
.auto-review-model {
  display: flex;
  flex-wrap: wrap;
  gap: .25rem .625rem;
  margin: .625rem 0 0;
  color: color-mix(in srgb, var(--console-muted) 89%, var(--console-hover));
  font-size: .8125rem;
}
.auto-review-model dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.auto-review-option .auto-review-model-warning { margin-block-start: .625rem; color: var(--console-warning); }
.auto-review-toggle { display: flex; align-items: center; justify-content: space-between; gap: .75rem; font-weight: 600; }
.auto-review-switch {
  appearance: none;
  display: flex;
  align-items: center;
  flex: none;
  width: 2.75rem;
  height: 1.5rem;
  margin: 0;
  padding: 0 .1875rem;
  border: 1px solid var(--console-muted);
  border-radius: 999px;
  background: var(--console-surface);
  color: var(--console-muted);
  cursor: pointer;
}
.auto-review-switch::before {
  content: '';
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: currentColor;
}
.auto-review-switch:checked {
  justify-content: flex-end;
  border-color: var(--console-accent-text);
  background: var(--console-primary);
  color: var(--console-accent-text);
}
.auto-review-switch:focus-visible { outline: 2px solid var(--console-accent-text); outline-offset: 2px; }
.auto-review-switch:disabled { opacity: .6; cursor: default; }
.auto-review-field { padding-block-end: 0; }
.auto-review-field :deep(label) { font-weight: 600; }
.auto-review-field :deep(.ui-field-feedback) { text-align: end; font-variant-numeric: tabular-nums; }
.auto-review-prompt {
  padding: .75rem;
  border-color: var(--console-muted);
  line-height: 1.6;
}
.auto-review-prompt:focus { border-color: var(--console-accent-text); outline: 2px solid var(--console-accent-text); outline-offset: 1px; }
.auto-review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  justify-content: space-between;
  padding-block-start: .875rem;
  border-block-start: 1px solid var(--console-line);
}
</style>
