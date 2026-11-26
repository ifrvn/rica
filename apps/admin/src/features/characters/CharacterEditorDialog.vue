<script setup lang="ts">
import { UiAlert, UiButton, UiDialog, UiField } from '@ricajs/console-shared/ui'
import { maxAiDisclosureLength } from '@ricajs/contracts/management'
import TimeZoneSelect from '../../shared/TimeZoneSelect.vue'

defineProps<{
  open: boolean
  creating: boolean
  busy: boolean
  error: string
  fieldError: (field: string) => string | undefined
  fieldInput: (field: string, hintId?: string) => { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }
}>()
const emit = defineEmits<{ save: []; close: []; closed: []; touch: [field: string] }>()
const slug = defineModel<string>('slug', { required: true })
const name = defineModel<string>('name', { required: true })
const timezone = defineModel<string>('timezone', { required: true })
const disclosure = defineModel<string>('disclosure', { required: true })
const reason = defineModel<string>('reason', { required: true })
</script>

<template>
  <UiDialog id="character-profile-editor" class="workspace-editor" :open="open" :title="creating ? '新建角色' : '角色设置'"
    :busy="busy" @update:open="!$event && emit('close')" @closed="emit('closed')">
    <UiAlert v-if="error" class="editor-alert" tone="error" role="alert">{{ error }}</UiAlert>
    <form @submit.prevent="emit('save')">
      <UiField v-if="creating" label="唯一标识" for="workspace-slug" :invalid="!!fieldError('slug')">
        <input class="ui-control" v-model="slug" v-bind="fieldInput('slug')" @blur="emit('touch', 'slug')" placeholder="小写字母、数字和连字符" maxlength="63" />
        <template v-if="fieldError('slug')" #feedback>
          <span id="workspace-slug-error">{{ fieldError('slug') }}</span>
        </template>
      </UiField>
      <UiField label="角色称呼"
        for="workspace-name" :invalid="!!fieldError('name')">
        <input class="ui-control" placeholder="例如：小黎"
          v-model="name" v-bind="fieldInput('name', 'workspace-name-hint')" @blur="emit('touch', 'name')" maxlength="120" />
        <template #feedback>
          <div id="workspace-name-hint" class="editor-hint">填写角色本身的称呼。</div>
          <div v-if="fieldError('name')" id="workspace-name-error">{{ fieldError('name') }}</div>
        </template>
      </UiField>
      <UiField v-if="creating" label="时区" for="workspace-timezone" :invalid="!!fieldError('timezone')">
        <TimeZoneSelect v-model:value="timezone" id="workspace-timezone"
          :invalid="!!fieldError('timezone')" @blur="emit('touch', 'timezone')" />
        <template v-if="fieldError('timezone')" #feedback>
          <span id="workspace-timezone-error">{{ fieldError('timezone') }}</span>
        </template>
      </UiField>
      <UiField label="角色核心设定" for="workspace-disclosure" :invalid="!!fieldError('disclosure')"
        :feedback="fieldError('disclosure') ? undefined : `可分行填写，最多 ${maxAiDisclosureLength} 个字符。内容用于内部写作提示。`">
        <textarea class="ui-control" rows="5" placeholder="例如：我是由 AI 驱动的虚拟角色" v-model="disclosure"
          :maxlength="maxAiDisclosureLength" v-bind="fieldInput('disclosure')" @blur="emit('touch', 'disclosure')" />
        <template v-if="fieldError('disclosure')" #feedback>
          <span id="workspace-disclosure-error">{{ fieldError('disclosure') }}</span>
        </template>
      </UiField>
      <UiField v-if="!creating" label="变更原因说明（可选）"
        for="workspace-reason" :invalid="!!fieldError('reason')">
        <input class="ui-control" placeholder="例如：更新角色核心设定" v-model="reason" v-bind="fieldInput('reason')" @blur="emit('touch', 'reason')" maxlength="240" />
        <template v-if="fieldError('reason')" #feedback>
          <span id="workspace-reason-error">{{ fieldError('reason') }}</span>
        </template>
      </UiField>
      <div class="editor-actions">
        <UiButton tone="primary" type="submit" :loading="busy" :disabled="busy">{{ creating ? '新建角色' : '保存修改' }}</UiButton>
        <UiButton :disabled="busy" @click="emit('close')">取消</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
