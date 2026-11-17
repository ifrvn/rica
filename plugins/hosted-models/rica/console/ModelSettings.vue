<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { UiAlert, UiBadge, UiButton, UiEmpty, UiField, UiSpinner } from '@rica/console-shared/ui'
import { useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'
import { hostedModelCatalog } from '../../providers/catalog.js'
import { modelSettingsContracts, type ModelCheckResult, type ModelSettingsView } from '../management/contracts.js'
import { modelCheckLabels } from './labels.js'

const props = defineProps<{ busy: boolean; canStartSimulation: boolean }>()
const emit = defineEmits<{ close: []; expired: []; saved: []; simulate: [] }>()
type Profile = ModelSettingsView['profiles'][number]

const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = '/v1/model-settings'
const current = ref<ModelSettingsView>()
const editing = ref<string | null>(null)
const checkResult = ref<ModelCheckResult>()
const pending = ref<'save' | 'check' | 'default'>()
const form = reactive({ name: '', provider: '', model: '', baseUrl: '', apiKey: '' })
const heading = ref<HTMLElement>()
const formHeading = ref<HTMLElement>()
const addButton = ref<InstanceType<typeof UiButton>>()
const blocked = computed(() => props.busy || busy.value)
const saved = computed(() => current.value?.profiles.find(({ id }) => id === editing.value))
const option = computed(() => hostedModelCatalog.find(({ id }) => id === form.provider))
const providerName = (id: string) => hostedModelCatalog.find((p) => p.id === id)?.name ?? id
const reuseKey = computed(() => saved.value?.hasKey && saved.value.provider === form.provider
  && (!option.value?.requiresBaseUrl || saved.value.baseUrl === form.baseUrl.trim().replace(/\/+$/, '')))
const canCheck = computed(() => reuseKey.value && !form.apiKey && saved.value?.model === form.model.trim()
  && saved.value?.name === form.name.trim())

function load() {
  void run(async () => {
    const value = await request<ModelSettingsView>(path)
    if (active()) current.value = value
  })
}

function edit(profile?: Profile) {
  editing.value = profile?.id ?? ''
  Object.assign(form, { name: profile?.name ?? '', provider: profile?.provider ?? '',
    model: profile?.model ?? '', baseUrl: profile?.baseUrl ?? '', apiKey: '' })
  checkResult.value = undefined
  error.value = ''
  notice.value = ''
  void nextTick(() => formHeading.value?.focus())
}

function closeForm() {
  const id = editing.value
  editing.value = null
  form.apiKey = ''
  checkResult.value = undefined
  error.value = ''
  notice.value = ''
  void nextTick(() => {
    const target = id ? document.getElementById('edit-model-profile-' + id) : addButton.value?.$el
    target?.focus()
  })
}

function changeProvider() {
  Object.assign(form, { model: '', baseUrl: '', apiKey: '' })
  error.value = ''
}

function update(kind: 'save' | 'default', endpoint: string, payload: object, version: number, apply: (value: ModelSettingsView) => void) {
  pending.value = kind
  void run(async () => {
    const value = await request<ModelSettingsView>(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"' + version + '"' },
      body: JSON.stringify(payload),
    })
    if (!active()) return
    current.value = value
    apply(value)
    emit('saved')
  }).finally(() => { pending.value = undefined })
}

function save() {
  if (!current.value || !option.value || editing.value === null || blocked.value) return
  const parsed = modelSettingsContracts.modelProfileInput.safeParse({
    id: saved.value?.id, name: form.name, provider: option.value.id, model: form.model, apiKey: form.apiKey || undefined,
    baseUrl: option.value.requiresBaseUrl ? form.baseUrl.trim() : undefined,
  })
  if (!parsed.success || (!parsed.data.apiKey && !reuseKey.value)) {
    error.value = '请核对配置名称、模型 ID、API 密钥和 HTTPS API 地址。'
    return
  }
  const knownIds = new Set(current.value.profiles.map(({ id }) => id))
  update('save', path, parsed.data, current.value.version, (value) => {
    const profile = value.profiles.find(({ id }) => id === parsed.data.id || !knownIds.has(id))
    if (profile) edit(profile)
    notice.value = '已保存模型配置。'
  })
}

function setDefault(id: string | null) {
  if (!current.value || blocked.value) return
  update('default', path + '/active', { id }, current.value.version, () => {
    notice.value = id ? '已设为默认草稿模型。' : '默认草稿已切回本地模型。'
  })
}

function testModel() {
  if (!current.value || !saved.value || !canCheck.value || blocked.value) return
  const payload = { id: saved.value.id, version: current.value.version }
  pending.value = 'check'
  checkResult.value = undefined
  void run(async () => {
    const result = await request<ModelCheckResult>(path + '/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (active()) {
      checkResult.value = result
      emit('saved')
    }
  }).finally(() => { pending.value = undefined })
}

onMounted(() => { heading.value?.focus(); load() })
</script>

<template>
  <section class="console-stack model-settings" aria-labelledby="model-settings-heading">
    <div class="console-section-heading">
      <h3 id="model-settings-heading" ref="heading" tabindex="-1">模型配置</h3>
      <UiButton size="small" variant="quiet" :disabled="blocked" @click="emit('close')">收起设置</UiButton>
    </div>
    <UiSpinner v-if="busy && !current" aria-label="正在读取模型配置" />
    <template v-if="current">
      <div class="console-actions">
        <UiButton ref="addButton" size="small" :tone="current.profiles.length ? 'default' : 'primary'"
          :disabled="blocked || editing === ''" @click="edit()">添加模型配置</UiButton>
        <UiButton v-if="current.defaultProfileId" size="small" variant="quiet" :disabled="blocked"
          :loading="pending === 'default'" @click="setDefault(null)">默认使用本地模型</UiButton>
      </div>
      <ul v-if="current.profiles.length" class="console-record-list">
        <li v-for="profile in current.profiles" :key="profile.id" class="model-profile-row">
          <div class="model-profile-label">
            <strong>{{ profile.name }}</strong>
            <span class="model-settings-detail">{{ providerName(profile.provider) }} · {{ profile.model }}</span>
          </div>
          <div class="console-actions">
            <UiBadge v-if="profile.id === current.defaultProfileId" tone="success">部署默认</UiBadge>
            <UiButton :id="'edit-model-profile-' + profile.id" size="small" variant="soft"
              :disabled="blocked" :aria-expanded="editing === profile.id"
              :aria-label="'编辑模型配置 ' + profile.name" @click="editing === profile.id ? closeForm() : edit(profile)">编辑</UiButton>
          </div>
        </li>
      </ul>
      <UiEmpty v-else-if="editing === null" description="暂无外部模型配置。" />
    </template>

    <form v-if="current && editing !== null" class="model-settings-form console-stack" @submit.prevent="save">
      <div class="console-section-heading">
        <h4 ref="formHeading" tabindex="-1">{{ saved ? '编辑模型配置' : '添加模型配置' }}</h4>
        <UiButton type="button" size="small" variant="quiet" :disabled="blocked" @click="closeForm">收起表单</UiButton>
      </div>
      <p v-if="saved" class="model-settings-detail">保存修改会影响使用这份配置的身份。</p>
      <UiField label="配置名称" for="model-config-name">
        <input id="model-config-name" class="ui-control" v-model="form.name" :disabled="blocked" required maxlength="80" />
      </UiField>
      <UiField label="模型提供方" for="model-config-provider">
        <select id="model-config-provider" class="ui-control" v-model="form.provider" :disabled="blocked || !!saved" required
          @change="changeProvider">
          <option value="" disabled>选择模型提供方</option>
          <option v-for="item in hostedModelCatalog" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </UiField>
      <UiField label="模型 ID" for="model-config-model">
        <input id="model-config-model" class="ui-control" v-model="form.model" :disabled="blocked" required maxlength="160" />
      </UiField>
      <UiField v-if="option?.requiresBaseUrl" label="API 基础地址" for="model-config-url">
        <input id="model-config-url" class="ui-control" v-model="form.baseUrl" :disabled="blocked"
          placeholder="https://provider.example/v1" required />
      </UiField>
      <UiField label="API 密钥" for="model-config-key">
        <input id="model-config-key" class="ui-control" v-model="form.apiKey" type="password" :disabled="blocked"
          :placeholder="reuseKey ? '已保存密钥，留空继续使用' : undefined" autocomplete="new-password" :required="!reuseKey" />
      </UiField>
      <div class="console-actions">
        <UiButton tone="primary" type="submit" :disabled="blocked" :loading="pending === 'save'">保存模型配置</UiButton>
        <UiButton v-if="saved" type="button" :disabled="blocked || !canCheck"
          :loading="pending === 'check'" @click="testModel">测试连接</UiButton>
        <UiButton v-if="saved && saved.id !== current.defaultProfileId" type="button" variant="quiet"
          :disabled="blocked || !canCheck" :loading="pending === 'default'" @click="setDefault(saved.id)">设为部署默认</UiButton>
      </div>
      <p v-if="canCheck" class="model-settings-detail">连接测试会向提供方发送固定消息，可能消耗模型额度。</p>
    </form>

    <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
    <UiAlert v-if="error" tone="error" role="alert">
      {{ error }}
      <UiButton size="small" variant="quiet" :disabled="blocked" @click="load">重新读取配置</UiButton>
    </UiAlert>
    <UiAlert v-if="checkResult && canCheck" :tone="checkResult.status === 'OK' ? 'success' : 'error'" role="status">
      {{ modelCheckLabels[checkResult.status] }}
      <p v-if="checkResult.reply" class="console-payload">{{ checkResult.reply }}</p>
      <UiButton v-if="checkResult.status === 'OK' && canStartSimulation && saved?.id === current?.defaultProfileId"
        size="small" variant="soft" @click="emit('simulate')">发起模拟验证</UiButton>
    </UiAlert>
  </section>
</template>

<style scoped>
.model-settings { gap: .75rem; min-inline-size: 0; }
.model-settings-detail, .model-profile-label { overflow-wrap: anywhere; }
.model-settings-detail { margin: 0; color: var(--console-muted); }
.model-profile-label { display: grid; gap: .25rem; }
.model-profile-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
.model-settings-form { max-width: 35rem; gap: .75rem; }
</style>
