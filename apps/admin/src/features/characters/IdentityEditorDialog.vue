<script setup lang="ts">
import { UiAlert, UiButton, UiCombobox, UiDialog, UiField } from '@ricajs/console-shared/ui'
import TimeZoneSelect from '../../shared/TimeZoneSelect.vue'

defineProps<{
  open: boolean
  creating: boolean
  busy: boolean
  error: string
  fieldError: (field: string) => string | undefined
  fieldInput: (field: string, hintId?: string) => { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }
  inheritedTimezone: string
  draftModels: { id: string; label: string }[]
  defaultDraftModel?: { id: string; label: string }
  maxWritingPromptLength?: number
}>()
const emit = defineEmits<{ save: []; close: []; closed: []; touch: [field: string] }>()
const slug = defineModel<string>('slug', { required: true })
const name = defineModel<string>('name', { required: true })
const timezone = defineModel<string>('timezone', { required: true })
const writingStyle = defineModel<string>('writingStyle', { required: true })
const draftModelProfile = defineModel<string>('draftModelProfile', { required: true })
const participation = defineModel<string>('participation', { required: true })
const writingPrompt = defineModel<string>('writingPrompt', { required: true })
const reason = defineModel<string>('reason', { required: true })

const styles = [
  { label: '中性', value: 'neutral' }, { label: '正式', value: 'formal' },
  { label: '随和', value: 'casual' }, { label: '简洁', value: 'concise' },
]
</script>

<template>
  <UiDialog id="identity-profile-editor" class="workspace-editor" :open="open" :title="creating ? '添加身份' : '编辑身份'"
    :busy="busy" @update:open="!$event && emit('close')" @closed="emit('closed')">
    <UiAlert v-if="error" class="editor-alert" tone="error" role="alert">{{ error }}</UiAlert>
    <form @submit.prevent="emit('save')">
      <UiField v-if="creating" label="唯一标识" for="workspace-slug" :invalid="!!fieldError('slug')">
        <input class="ui-control" v-model="slug" v-bind="fieldInput('slug')" @blur="emit('touch', 'slug')" placeholder="小写字母、数字和连字符" maxlength="63" />
        <template v-if="fieldError('slug')" #feedback>
          <span id="workspace-slug-error">{{ fieldError('slug') }}</span>
        </template>
      </UiField>
      <UiField label="平台身份名称"
        for="workspace-name" :invalid="!!fieldError('name')">
        <input class="ui-control" placeholder="例如：XX社区管理员"
          v-model="name" v-bind="fieldInput('name', 'workspace-name-hint')" @blur="emit('touch', 'name')" maxlength="120" />
        <template #feedback>
          <div id="workspace-name-hint" class="editor-hint">用于标识角色在关联平台上使用的身份，不作为称呼使用。</div>
          <div v-if="fieldError('name')" id="workspace-name-error">{{ fieldError('name') }}</div>
        </template>
      </UiField>
      <UiField label="时区" for="workspace-timezone" :invalid="!!fieldError('timezone')">
        <TimeZoneSelect v-model:value="timezone" id="workspace-timezone" :inherited="inheritedTimezone"
          :invalid="!!fieldError('timezone')" @blur="emit('touch', 'timezone')" />
        <template v-if="fieldError('timezone')" #feedback>
          <span id="workspace-timezone-error">{{ fieldError('timezone') }}</span>
        </template>
      </UiField>
      <UiField label="写作风格" for="workspace-style" :invalid="!!fieldError('style')">
        <UiCombobox placeholder="选择写作风格" v-model="writingStyle" :options="styles" :input-attrs="fieldInput('style')" @blur="emit('touch', 'style')" />
        <template v-if="fieldError('style')" #feedback>
          <span id="workspace-style-error">{{ fieldError('style') }}</span>
        </template>
      </UiField>
      <UiField label="公开草稿模型" for="workspace-draft-model">
        <select id="workspace-draft-model" class="ui-control" v-model="draftModelProfile" :disabled="busy">
          <option value="">使用部署默认{{ defaultDraftModel ? ' · ' + defaultDraftModel.label : '' }}</option>
          <option value="simulated">使用本地模型</option>
          <option v-if="draftModelProfile && draftModelProfile !== 'simulated'
            && !draftModels.some(({ id }) => id === draftModelProfile)" :value="draftModelProfile">配置不可用时使用本地模型</option>
          <option v-for="model in draftModels" :key="model.id" :value="model.id">{{ model.label }}</option>
        </select>
      </UiField>
      <UiField label="参与程度" for="workspace-participation">
        <select id="workspace-participation" class="ui-control" v-model="participation" :disabled="busy">
          <option value="">按身份设定（默认适中）</option>
          <option value="talkative">话痨</option>
          <option value="balanced">适中</option>
          <option value="reserved">寡言</option>
        </select>
      </UiField>
      <UiField label="身份提示词（可选）" for="workspace-writingPrompt"
        :invalid="!!fieldError('writingPrompt')">
        <textarea class="ui-control" v-model="writingPrompt" :rows="4"
          :maxlength="maxWritingPromptLength" v-bind="fieldInput('writingPrompt')"
          placeholder="例如：你负责回答产品使用问题。先给操作步骤，遇到不确定的信息就请对方补充背景。"
          @blur="emit('touch', 'writingPrompt')"></textarea>
        <template #feedback>
          <span v-if="fieldError('writingPrompt')" id="workspace-writingPrompt-error">{{ fieldError('writingPrompt') }}</span>
          <span v-else>用于内部写作提示。模拟模型按模板生成回复。</span>
        </template>
      </UiField>
      <UiField v-if="!creating" label="变更原因说明（可选）"
        for="workspace-reason" :invalid="!!fieldError('reason')">
        <input class="ui-control" placeholder="例如：调整此身份的写作风格" v-model="reason" v-bind="fieldInput('reason')" @blur="emit('touch', 'reason')" maxlength="240" />
        <template v-if="fieldError('reason')" #feedback>
          <span id="workspace-reason-error">{{ fieldError('reason') }}</span>
        </template>
      </UiField>
      <div class="editor-actions">
        <UiButton tone="primary" type="submit" :loading="busy" :disabled="busy">{{ creating ? '添加身份' : '保存修改' }}</UiButton>
        <UiButton :disabled="busy" @click="emit('close')">取消</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
