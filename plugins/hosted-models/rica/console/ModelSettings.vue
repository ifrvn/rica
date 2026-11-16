<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { UiAlert, UiButton, UiField, UiSpinner } from '@rica/console-shared/ui'
import type { ModelPluginOption } from '@rica/contracts/model-provider'
import { createModelSettingsContracts, type ModelCheckResult, type ModelSettingsView } from '../management/contracts.js'
import { useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'
import { modelCheckLabels } from './labels.js'

const props = defineProps<{ option: ModelPluginOption; canStartSimulation: boolean }>()
const emit = defineEmits<{ close: []; expired: []; saved: []; simulate: [] }>()
const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = '/v1/model-settings'
const current = ref<ModelSettingsView>()
const checkResult = ref<ModelCheckResult>()
const checking = ref(false)
const form = reactive({ model: '', baseUrl: '', apiKey: '' })
const modelSettingsInput = computed(() => createModelSettingsContracts([props.option]).modelSettingsInput)
const reuseKey = computed(() => current.value?.hasKey && current.value.provider === props.option.id
  && (!props.option.requiresBaseUrl || current.value.baseUrl === form.baseUrl.trim().replace(/\/+$/, '')))
const canCheck = computed(() => reuseKey.value && !form.apiKey && current.value?.model === form.model.trim())

function setCurrent(value: ModelSettingsView) {
  current.value = value
  checkResult.value = undefined
  const same = value.provider === props.option.id
  Object.assign(form, { model: same ? value.model ?? '' : '', baseUrl: same ? value.baseUrl ?? '' : '', apiKey: '' })
}

function load() {
  void run(async () => {
    const value = await request<ModelSettingsView>(path)
    if (active()) setCurrent(value)
  })
}

function save() {
  if (!current.value || busy.value) return
  const input = modelSettingsInput.value.safeParse({
    provider: props.option.id, model: form.model, apiKey: form.apiKey || undefined,
    baseUrl: props.option.requiresBaseUrl ? form.baseUrl.trim() : undefined,
  })
  notice.value = ''
  if (!input.success || (!input.data.apiKey && !reuseKey.value)) {
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
    emit('saved')
  })
}

function testModel() {
  if (!current.value || !canCheck.value || busy.value) return
  const version = current.value.version
  checkResult.value = undefined
  checking.value = true
  void run(async () => {
    const result = await request<ModelCheckResult>(path + '/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
    })
    if (active()) {
      checkResult.value = result
      emit('saved')
    }
  }).finally(() => { checking.value = false })
}

const heading = ref<HTMLElement>()
onMounted(() => { heading.value?.focus(); void load() })
</script>

<template>
  <section class="model-settings" aria-labelledby="model-settings-heading">
    <div class="console-section-heading">
      <h3 id="model-settings-heading" ref="heading" tabindex="-1">{{ option.name }} · AI API 设置</h3>
      <UiButton size="small" variant="quiet" :disabled="busy" @click="emit('close')">收起设置</UiButton>
    </div>
    <UiSpinner v-if="busy && !current" aria-label="正在读取模型设置" />
    <form v-if="current" @submit.prevent="save">
      <p class="model-settings-scope">应用于此部署所有角色的公开模拟草稿。启用外部模型后，模拟消息、身份写作指令及允许公开引用的资料会发送给所选服务。</p>
      <div class="model-settings-fields">
          <UiField label="模型 ID" for="model-settings-name">
            <input class="ui-control" v-model="form.model" :disabled="busy" placeholder="供应商提供的文本模型 ID"
              v-bind="{ id: 'model-settings-name', required: true }" />
          </UiField>
          <UiField v-if="option.requiresBaseUrl" label="API 基础地址" for="model-settings-url">
            <input class="ui-control" v-model="form.baseUrl" :disabled="busy" placeholder="https://provider.example/v1"
              v-bind="{ id: 'model-settings-url', required: true }" />
          </UiField>
          <UiField label="API 密钥" for="model-settings-key">
            <input class="ui-control" v-model="form.apiKey" type="password" :disabled="busy"
              :placeholder="reuseKey ? '已保存密钥，留空继续使用' : '输入供应商 API 密钥'"
              v-bind="{ id: 'model-settings-key', autocomplete: 'new-password', required: !reuseKey }" />
          </UiField>
      </div>
      <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
      <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
      <div class="model-settings-actions">
        <UiButton tone="primary" type="submit" :disabled="busy" :loading="busy && !checking">保存模型设置</UiButton>
        <UiButton type="button" :disabled="busy || !canCheck" :loading="checking" @click="testModel">测试模型</UiButton>
        <UiButton v-if="error" :disabled="busy" variant="quiet" @click="load">重新读取设置</UiButton>
      </div>
      <p class="model-settings-scope model-settings-test-hint">
        {{ canCheck ? '测试会向服务商发送一条固定消息，并可能消耗模型额度。' : '保存当前设置后可测试模型。' }}
      </p>
      <UiAlert v-if="checkResult && canCheck" :tone="checkResult.status === 'OK' ? 'success' : 'error'" role="status">
        {{ modelCheckLabels[checkResult.status] }}
        <p v-if="checkResult.reply" class="console-payload model-settings-reply">{{ checkResult.reply }}</p>
        <p v-if="checkResult.status === 'OK'" class="model-settings-reply">
          {{ canStartSimulation
            ? '用当前角色和模拟账号发起一次模拟，就能在提案中查看认知 Worker 生成的草稿。'
            : '请让当前角色的管理员发起模拟，在提案中核对认知 Worker 生成的草稿。' }}
        </p>
        <UiButton v-if="checkResult.status === 'OK' && canStartSimulation" class="model-settings-simulate"
          size="small" variant="soft" @click="emit('simulate')">发起模拟验证</UiButton>
      </UiAlert>
    </form>
    <template v-else-if="error">
      <UiAlert tone="error" role="alert">{{ error }}</UiAlert>
      <UiButton class="model-settings-actions" :disabled="busy" @click="load">重新读取设置</UiButton>
    </template>
  </section>
</template>

<style scoped>
.model-settings-scope { margin: 0 0 1rem; color: var(--console-muted); }
.model-settings { border-top: 1px solid var(--console-line); padding-block-start: 1rem; }
.model-settings-fields { display: grid; gap: 1rem; max-width: 35rem; }
.model-settings-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
.model-settings-test-hint { margin-block: .5rem; }
.model-settings-reply { margin-block: .5rem 0; }
.model-settings-simulate { margin-block-start: .75rem; }
</style>
