<script setup lang="ts">
import { computed, ref } from 'vue'
import { UiAlert, UiButton, UiDialog, UiEmpty, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { characterPath, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import { defaultAutoReviewPrompt, type AutoReviewTemplateView } from '@ricajs/contracts/auto-review'

const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: [] }>()
const open = ref(false)
const templates = ref<AutoReviewTemplateView[]>()
const selected = ref<AutoReviewTemplateView>()
const creating = ref(false)
const name = ref('')
const prompt = ref('')
const path = characterPath(props.characterId) + '/auto-review/templates'
const { active, busy, error, notice, run, command } = useConsoleTask(() => emit('expired'))
const changed = computed(() => creating.value || name.value.trim() !== selected.value?.name || prompt.value.trim() !== selected.value?.prompt)

function edit(template?: AutoReviewTemplateView) {
  selected.value = template
  creating.value = false
  name.value = template?.name ?? ''
  prompt.value = template?.prompt ?? ''
}

function load() {
  void run(async () => {
    const entries = await request<AutoReviewTemplateView[]>(path)
    if (!active()) return
    templates.value = entries
    edit(entries.find(({ id }) => id === selected.value?.id) ?? entries[0])
  })
}

function show() {
  templates.value = undefined
  edit()
  open.value = true
  load()
}

function create() {
  edit()
  creating.value = true
  prompt.value = defaultAutoReviewPrompt
  notice.value = ''
  error.value = ''
}

function save() {
  const old = selected.value
  const input = { name: name.value.trim(), prompt: prompt.value.trim() }
  if (!input.name || !input.prompt || !changed.value || (!creating.value && !old)) return
  void run(async () => {
    const { id } = old ? await command(path + '/' + old.id, input, 'PUT', old.version) : await command(path, input)
    if (!active()) return
    const saved = { ...input, id, version: (old?.version ?? 0) + 1 }
    templates.value = [...(templates.value ?? []).filter((item) => item.id !== id), saved]
      .sort((a, b) => a.name.localeCompare(b.name))
    edit(saved)
    notice.value = '已保存规则模板。'
  })
}
</script>

<template>
  <UiButton size="small" aria-haspopup="dialog" @click="show">规则模板</UiButton>
  <UiDialog v-model:open="open" title="规则模板" :busy="busy">
    <UiAlert v-if="error" tone="error" role="alert">
      {{ error }}
      <UiButton variant="quiet" size="small" @click="load">重新读取模板</UiButton>
    </UiAlert>
    <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
    <UiSpinner v-if="busy && !templates" aria-label="正在读取规则模板" />
    <div v-if="templates" class="template-editor">
      <div class="template-controls">
        <UiField v-if="templates.length" label="已保存的模板" for="saved-review-template">
          <select id="saved-review-template" class="ui-control" :value="selected?.id ?? ''" :disabled="busy"
            @change="edit(templates.find(({ id }) => id === ($event.target as HTMLSelectElement).value))">
            <option value="" disabled>选择模板</option>
            <option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
          </select>
        </UiField>
        <UiButton size="small" :tone="templates.length ? 'default' : 'primary'" :disabled="busy || creating" @click="create">新建模板</UiButton>
      </div>
      <UiEmpty v-if="!creating && !selected" description="暂无自定义模板。" />
      <form v-else class="template-editor" @submit.prevent="save">
        <UiField label="模板名称" for="review-template-name">
          <input id="review-template-name" v-model="name" class="ui-control" type="text" maxlength="80" required :disabled="busy" />
        </UiField>
        <UiField label="审批规则" for="review-template-prompt">
          <textarea id="review-template-prompt" v-model="prompt" class="ui-control" rows="9" maxlength="4000" required :disabled="busy" />
          <template #feedback>{{ prompt.length }} / 4000</template>
        </UiField>
        <div class="template-actions">
          <UiButton type="submit" tone="primary" :disabled="busy || !changed || !name.trim() || !prompt.trim()">保存模板</UiButton>
        </div>
      </form>
    </div>
  </UiDialog>
</template>

<style scoped>
.template-editor { display: grid; gap: .75rem; }
.template-controls { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; }
.template-controls :deep(.ui-field) { flex: 1 1 12rem; min-inline-size: 0; padding-block-end: 0; }
.template-actions { display: flex; justify-content: flex-end; }
</style>
