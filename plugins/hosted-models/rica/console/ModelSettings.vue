<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { UiAlert, UiBadge, UiButton, UiDialog, UiEmpty, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import { hostedModelCatalog } from '../../providers/catalog.js'
import { modelSettingsContracts, type ModelCheckResult, type ModelSettingsView } from '../management/contracts.js'
import { modelCheckLabels } from './labels.js'

const props = defineProps<{ busy: boolean; canStartSimulation: boolean }>()
const emit = defineEmits<{ expired: []; saved: []; simulate: [] }>()
type Profile = ModelSettingsView['profiles'][number]

const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = '/v1/model-settings'
const current = ref<ModelSettingsView>()
const editing = ref<string | null>(null)
const removing = ref<string>()
const checkResult = ref<ModelCheckResult>()
const pending = ref<'save' | 'check' | 'default' | 'remove'>()
const form = reactive({ name: '', provider: '', model: '', baseUrl: '', apiKey: '' })
const heading = ref<HTMLElement>()
const addButton = ref<InstanceType<typeof UiButton>>()
const blocked = computed(() => props.busy || busy.value)
const saved = computed(() => current.value?.profiles.find(({ id }) => id === editing.value))
const removeTarget = computed(() => current.value?.profiles.find(({ id }) => id === removing.value))
const rows = computed(() => [...(current.value?.profiles ?? []), ...(editing.value === '' ? [null] : [])])
const option = computed(() => hostedModelCatalog.find(({ id }) => id === form.provider))
const providerName = (id: string) => hostedModelCatalog.find((p) => p.id === id)?.name ?? id
const reuseKey = computed(() => saved.value?.hasKey && saved.value.provider === form.provider
  && (!option.value?.requiresBaseUrl || saved.value.baseUrl === form.baseUrl.trim().replace(/\/+$/, '')))
const canCheck = computed(() => reuseKey.value && !form.apiKey && saved.value?.model === form.model.trim()
  && saved.value?.name === form.name.trim())

function load() {
  void run(async () => {
    const value = await request<ModelSettingsView>(path)
    if (!active()) return
    current.value = value
    if (editing.value && !value.profiles.some(({ id }) => id === editing.value)) closeForm()
  })
}

function edit(profile?: Profile) {
  editing.value = profile?.id ?? ''
  Object.assign(form, { name: profile?.name ?? '', provider: profile?.provider ?? '',
    model: profile?.model ?? '', baseUrl: profile?.baseUrl ?? '', apiKey: '' })
  checkResult.value = undefined
  error.value = ''
  notice.value = ''
  void nextTick(() => document.getElementById('model-config-name')?.focus())
}

function closeForm() {
  const id = editing.value
  editing.value = null
  form.apiKey = ''
  checkResult.value = undefined
  error.value = ''
  notice.value = ''
  void nextTick(() => {
    const target = (id && document.getElementById('edit-model-profile-' + id)) || addButton.value?.$el
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

function confirmRemoval(profile: Profile) {
  error.value = ''
  notice.value = ''
  removing.value = profile.id
}

function cancelRemoval() {
  removing.value = undefined
  error.value = ''
}

function removeProfile() {
  if (!current.value || !removeTarget.value || blocked.value) return
  const { id } = removeTarget.value
  const version = current.value.version
  let removed = false
  pending.value = 'remove'
  void run(async () => {
    const value = await request<ModelSettingsView>(path + '/' + encodeURIComponent(id), {
      method: 'DELETE', headers: { 'If-Match': '"' + version + '"' },
    })
    if (!active()) return
    current.value = value
    removing.value = undefined
    if (editing.value === id) closeForm()
    notice.value = '已移除模型配置。'
    removed = true
    emit('saved')
  }).finally(() => {
    pending.value = undefined
    if (removed) void nextTick(() => addButton.value?.$el.focus())
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
  <section class="model-settings" aria-labelledby="model-settings-heading">
    <div class="console-section-heading model-settings-toolbar">
      <h3 id="model-settings-heading" ref="heading" tabindex="-1">模型配置</h3>
      <div v-if="current" class="console-actions">
        <UiButton v-if="current.defaultProfileId" size="small" variant="quiet" :disabled="blocked"
          :loading="pending === 'default'" @click="setDefault(null)">默认使用本地模型</UiButton>
        <UiButton ref="addButton" size="small" :tone="editing === '' ? 'default' : 'primary'"
          :variant="editing === '' ? 'soft' : 'solid'" :disabled="blocked" :aria-expanded="editing === ''"
          :aria-controls="editing === '' ? 'model-settings-form' : undefined"
          @click="editing === '' ? closeForm() : edit()">
          {{ editing === '' ? '取消添加' : '添加模型' }}
        </UiButton>
      </div>
    </div>
    <UiSpinner v-if="busy && !current" aria-label="正在读取模型配置" />
    <template v-if="current">
      <ul v-if="rows.length" class="model-profile-list">
        <li v-for="profile in rows" :key="profile?.id ?? 'new'" class="model-profile"
          :class="{ 'model-profile-open': editing === (profile?.id ?? '') }">
          <div v-if="profile" class="model-profile-row">
            <div class="model-profile-label">
              <strong>{{ profile.name }}</strong>
              <span class="model-settings-detail">{{ providerName(profile.provider) }} · {{ profile.model }}</span>
            </div>
            <div class="console-actions">
              <UiBadge v-if="profile.id === current.defaultProfileId" tone="success">部署默认</UiBadge>
              <UiButton :id="'edit-model-profile-' + profile.id" size="small" variant="quiet"
                :disabled="blocked" :aria-expanded="editing === profile.id"
                :aria-controls="editing === profile.id ? 'model-settings-form' : undefined"
                :aria-label="(editing === profile.id ? '收起模型配置 ' : '编辑模型配置 ') + profile.name"
                @click="editing === profile.id ? closeForm() : edit(profile)">
                {{ editing === profile.id ? '收起' : '编辑' }}
              </UiButton>
              <UiButton size="small" variant="quiet" tone="error" :disabled="blocked"
                :aria-label="'移除模型配置 ' + profile.name" @click="confirmRemoval(profile)">移除</UiButton>
            </div>
          </div>

          <form v-if="editing === (profile?.id ?? '')" id="model-settings-form" class="model-settings-form"
            :aria-label="profile ? '编辑 ' + profile.name : '添加模型配置'" @submit.prevent="save">
            <div class="model-form-fields">
              <UiField label="配置名称" for="model-config-name">
                <input id="model-config-name" class="ui-control" v-model="form.name"
                  :disabled="blocked" required maxlength="80" />
              </UiField>
              <UiField v-if="!profile" label="模型提供方" for="model-config-provider">
                <select id="model-config-provider" class="ui-control" v-model="form.provider" :disabled="blocked" required
                  @change="changeProvider">
                  <option value="" disabled>选择模型提供方</option>
                  <option v-for="item in hostedModelCatalog" :key="item.id" :value="item.id">{{ item.name }}</option>
                </select>
              </UiField>
              <UiField label="模型 ID" for="model-config-model">
                <input id="model-config-model" class="ui-control" v-model="form.model" :disabled="blocked" required maxlength="160" />
              </UiField>
              <UiField label="API 密钥" for="model-config-key">
                <input id="model-config-key" class="ui-control" v-model="form.apiKey" type="password" :disabled="blocked"
                  :placeholder="reuseKey ? '留空继续使用已保存的密钥' : undefined" autocomplete="new-password" :required="!reuseKey" />
              </UiField>
              <UiField v-if="option?.requiresBaseUrl" label="API 基础地址" for="model-config-url">
                <input id="model-config-url" class="ui-control" v-model="form.baseUrl" :disabled="blocked"
                  placeholder="https://provider.example/v1" required />
              </UiField>
            </div>
            <div class="console-actions">
              <UiButton tone="primary" type="submit" :disabled="blocked" :loading="pending === 'save'">保存配置</UiButton>
              <UiButton v-if="saved" type="button" :disabled="blocked || !canCheck"
                :loading="pending === 'check'" aria-describedby="model-form-test-note" @click="testModel">测试连接</UiButton>
              <UiButton v-if="saved && saved.id !== current.defaultProfileId" type="button" variant="quiet"
                :disabled="blocked || !canCheck" :loading="pending === 'default'" @click="setDefault(saved.id)">设为部署默认</UiButton>
            </div>
            <p v-if="saved" id="model-form-test-note" class="model-settings-detail">
              修改将应用于引用此配置的身份。连接测试会发送固定消息，可能消耗模型额度。
            </p>
            <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
            <UiAlert v-if="error && !removeTarget" tone="error" role="alert">
              {{ error }}
              <UiButton type="button" size="small" variant="quiet" :disabled="blocked" @click="load">重新读取配置</UiButton>
            </UiAlert>
            <UiAlert v-if="checkResult && canCheck" :tone="checkResult.status === 'OK' ? 'success' : 'error'" role="status">
              {{ modelCheckLabels[checkResult.status] }}
              <p v-if="checkResult.reply" class="console-payload">{{ checkResult.reply }}</p>
              <UiButton v-if="checkResult.status === 'OK' && canStartSimulation && saved?.id === current.defaultProfileId"
                type="button" size="small" variant="soft" @click="emit('simulate')">发起模拟验证</UiButton>
            </UiAlert>
          </form>
        </li>
      </ul>
      <UiEmpty v-else description="暂无外部模型配置。" />
    </template>
    <UiAlert v-if="editing === null && notice" tone="success" role="status">{{ notice }}</UiAlert>
    <UiAlert v-if="editing === null && error && !removeTarget" tone="error" role="alert">
      {{ error }}
      <UiButton size="small" variant="quiet" :disabled="blocked" @click="load">重新读取配置</UiButton>
    </UiAlert>
    <UiDialog :open="!!removeTarget" title="移除模型配置" :busy="blocked"
      @update:open="open => { if (!open) cancelRemoval() }">
      <div class="model-removal-content">
        <p v-if="removeTarget" class="model-settings-detail model-removal-description">
          移除「{{ removeTarget.name }}」会删除它保存的 API 密钥。引用它的身份后续将使用本地模型。
          <template v-if="removeTarget.id === current?.defaultProfileId">部署默认也会切回本地模型。</template>
        </p>
        <UiAlert v-if="error" tone="error" role="alert">
          {{ error }}
          <UiButton type="button" size="small" variant="quiet" :disabled="blocked" @click="load">重新读取配置</UiButton>
        </UiAlert>
        <div class="console-actions model-removal-actions">
          <UiButton type="button" :disabled="blocked" @click="cancelRemoval">取消</UiButton>
          <UiButton type="button" tone="error" :disabled="blocked" :loading="pending === 'remove'" @click="removeProfile">确认移除</UiButton>
        </div>
      </div>
    </UiDialog>
  </section>
</template>

<style scoped>
.model-settings { display: grid; gap: .75rem; min-inline-size: 0; }
.model-settings-toolbar { margin: 0; align-items: center; flex-wrap: wrap; }
.model-profile-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--console-line); border-radius: .5rem; }
.model-profile + .model-profile { border-block-start: 1px solid var(--console-line); }
.model-profile-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; padding: .625rem .875rem; }
.model-profile-label { display: grid; gap: .125rem; min-inline-size: 0; overflow-wrap: anywhere; }
.model-settings-detail { margin: 0; color: var(--console-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.model-profile-open > .model-profile-row { background: var(--console-hover); }
.model-profile-open:first-child > .model-profile-row { border-start-start-radius: .5rem; border-start-end-radius: .5rem; }
.model-profile-row + .model-settings-form { border-block-start: 1px solid var(--console-line); }
.model-settings-form { display: grid; gap: .75rem; padding: .875rem; }
.model-settings-form > * { max-inline-size: 48rem; }
.model-form-fields { display: grid; gap: .75rem 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); }
.model-form-fields :deep(.ui-field) { padding-block-end: 0; }
.model-removal-content { display: grid; gap: 1rem; }
.model-removal-description { font-size: .875rem; line-height: 1.6; }
.model-removal-actions { justify-content: flex-end; border-block-start: 1px solid var(--console-line); padding-block-start: .875rem; }
</style>
