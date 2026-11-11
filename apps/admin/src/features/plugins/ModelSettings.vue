<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NSelect, NSpin } from 'naive-ui'
import { modelProviders, modelSettingsInput, type ModelSettingsInput, type ModelSettingsView } from '../../../../../packages/contracts/model-settings.js'
import { useConsoleTask } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'

const emit = defineEmits<{ close: []; expired: [] }>()
const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = '/v1/model-settings'
const current = ref<ModelSettingsView>()
const form = reactive({ provider: 'simulated' as ModelSettingsInput['provider'], model: '', baseUrl: '', apiKey: '' })
const names = {
  simulated: '本地模拟模板', openai: 'OpenAI', anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini', 'openai-compatible': 'OpenAI 兼容服务',
}
const options = modelProviders.map((value) => ({ value, label: names[value] }))
const hosted = computed(() => form.provider !== 'simulated')
const compatible = computed(() => form.provider === 'openai-compatible')
const reuseKey = computed(() => current.value?.hasKey && current.value.provider === form.provider
  && (!compatible.value || current.value.baseUrl === form.baseUrl.trim().replace(/\/+$/, '')))

function setCurrent(value: ModelSettingsView) {
  current.value = value
  Object.assign(form, { provider: value.provider, model: value.model ?? '', baseUrl: value.baseUrl ?? '', apiKey: '' })
}

function selectProvider(provider: ModelSettingsInput['provider']) {
  form.provider = provider
  form.model = current.value?.provider === provider ? current.value.model ?? '' : ''
  form.baseUrl = current.value?.provider === provider ? current.value.baseUrl ?? '' : ''
  form.apiKey = ''
  error.value = ''
  notice.value = ''
}

function load() {
  void run(async () => {
    const value = await request<ModelSettingsView>(path)
    if (active()) setCurrent(value)
  })
}

function save() {
  if (!current.value || busy.value) return
  const input = modelSettingsInput.safeParse(hosted.value ? {
    provider: form.provider, model: form.model, apiKey: form.apiKey || undefined,
    baseUrl: compatible.value ? form.baseUrl.trim() : undefined,
  } : { provider: form.provider })
  notice.value = ''
  if (!input.success || (hosted.value && !input.data.apiKey && !reuseKey.value)) {
    error.value = '请核对模型 ID、API 密钥及兼容服务的 HTTPS API 地址。'
    return
  }
  const version = current.value.version
  void run(async () => {
    const value = await request<ModelSettingsView>(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"' + version + '"' },
      body: JSON.stringify(input.data),
    })
    if (!active()) return
    setCurrent(value)
    notice.value = '已保存。下一次生成公开模拟草稿时使用此配置。'
  })
}

onMounted(load)
</script>

<template>
  <NModal :show="true" preset="card" title="模型设置" :mask-closable="!busy"
    :close-on-esc="!busy" :closable="!busy" style="width: 32rem; max-width: calc(100% - 2rem)"
    @update:show="!$event && emit('close')">
    <NSpin v-if="busy && !current" aria-label="正在读取模型设置" />
    <NForm v-if="current" :show-feedback="false" @submit.prevent="save">
      <p class="model-settings-scope">应用于此部署所有角色的公开模拟草稿。启用外部模型后，模拟消息、身份写作指令及允许公开引用的资料会发送给所选服务。</p>
      <div class="model-settings-fields">
        <NFormItem label="模型提供方" :label-props="{ for: 'model-settings-provider' }">
          <NSelect :value="form.provider" :options="options" :disabled="busy"
            :input-props="{ id: 'model-settings-provider' }" @update:value="selectProvider" />
        </NFormItem>
        <template v-if="hosted">
          <NFormItem label="模型 ID" :label-props="{ for: 'model-settings-name' }">
            <NInput v-model:value="form.model" :disabled="busy" placeholder="供应商提供的文本模型 ID"
              :input-props="{ id: 'model-settings-name', required: true }" />
          </NFormItem>
          <NFormItem v-if="compatible" label="API 基础地址" :label-props="{ for: 'model-settings-url' }">
            <NInput v-model:value="form.baseUrl" :disabled="busy" placeholder="https://provider.example/v1"
              :input-props="{ id: 'model-settings-url', required: true }" />
          </NFormItem>
          <NFormItem label="API 密钥" :label-props="{ for: 'model-settings-key' }">
            <NInput v-model:value="form.apiKey" type="password" :disabled="busy"
              :placeholder="reuseKey ? '已保存密钥，留空继续使用' : '输入供应商 API 密钥'"
              :input-props="{ id: 'model-settings-key', autocomplete: 'new-password', required: !reuseKey }" />
          </NFormItem>
        </template>
      </div>
      <NAlert v-if="notice" type="success" role="status">{{ notice }}</NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <div class="model-settings-actions">
        <NButton type="primary" attr-type="submit" :loading="busy">保存模型设置</NButton>
        <NButton v-if="error" :disabled="busy" quaternary @click="load">重新读取设置</NButton>
      </div>
    </NForm>
    <template v-else-if="error">
      <NAlert type="error" role="alert">{{ error }}</NAlert>
      <NButton class="model-settings-actions" :disabled="busy" @click="load">重新读取设置</NButton>
    </template>
  </NModal>
</template>

<style scoped>
.model-settings-scope { margin: 0 0 1rem; color: var(--console-muted); }
.model-settings-fields { display: grid; gap: 1rem; }
.model-settings-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
</style>
