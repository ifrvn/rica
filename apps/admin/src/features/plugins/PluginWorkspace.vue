<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSpin, NTag } from 'naive-ui'
import { deploymentPluginChange, deploymentPluginIds, type DeploymentPluginId, type DeploymentPluginsView } from '../../../../../packages/contracts/deployment-plugins.js'
import { useConsoleTask } from '../../shared/console-data.js'
import { request } from '../../shared/request.js'
import { pluginNames as labels, usePluginStatus } from './plugin-status.js'
import ModelSettings from './ModelSettings.vue'

const props = defineProps<{ characterId: string; canConfigureModel: boolean }>()
const emit = defineEmits<{ expired: []; accounts: [] }>()
const expired = () => emit('expired')
const { status, busy: loading, error: loadError, refresh } = usePluginStatus(props.characterId, expired, false)
const { busy, error, active, run } = useConsoleTask(expired)
const deployment = computed(() => status.value?.deployment)
const editing = ref<DeploymentPluginId>()
const modelEditor = computed(() => {
  const id = editing.value
  return id && id !== 'newbi' && deployment.value?.plugins[id] === 'ENABLED' ? id : undefined
})
const changedPlugin = ref<DeploymentPluginId>()
const form = reactive({ endpoint: '', credential: '' })
const stages = { NOT_INSTALLED: '未安装', INSTALLED: '已安装 · 未启用', ENABLED: '已启用' } as const
const operations = { NOT_INSTALLED: 'INSTALL', INSTALLED: 'ENABLE', ENABLED: 'DISABLE' } as const
const newbiComponents = computed(() => status.value?.services.flatMap(({ catalog }) =>
  catalog.filter(({ kind }) => kind === 'platform-reader' || kind === 'platform-reply-executor')) ?? [])
const modelVersions = computed(() => new Map(status.value?.services.find(({ service }) => service === 'worker')
  ?.catalog.filter(({ kind }) => kind === 'model').map(({ id, version }) => [id, version])))

function toggleEditor(id: DeploymentPluginId) {
  if (editing.value === id) {
    editing.value = undefined
    void nextTick(() => document.getElementById('configure-plugin-' + id)?.focus())
    return
  }
  editing.value = id
  error.value = ''
  if (id === 'newbi') Object.assign(form, { endpoint: deployment.value?.newbi.endpoint ?? '', credential: '' })
  void nextTick(() => document.getElementById(id === 'newbi' ? 'newbi-settings-heading' : 'model-settings-heading')?.focus())
}

function update(id: DeploymentPluginId, data: unknown) {
  if (!deployment.value || !props.canConfigureModel || loading.value || busy.value) return
  changedPlugin.value = id
  const parsed = deploymentPluginChange.safeParse(data)
  if (!parsed.success) {
    error.value = '请核对本机 API 地址和 Agent 密钥格式。'
    return
  }
  const version = deployment.value.version
  void run(async () => {
    const updated = await request<DeploymentPluginsView>('/v1/deployment-plugins', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"' + version + '"' },
      body: JSON.stringify(parsed.data),
    })
    if (!active() || !status.value) return
    status.value = { ...status.value, deployment: updated,
      newbiRegistrationAvailable: updated.plugins.newbi === 'ENABLED' && updated.newbi.hasCredential }
    if (parsed.data.action === 'CONFIGURE_NEWBI' || (parsed.data.action === 'DISABLE' && editing.value === id)) {
      form.credential = ''
      editing.value = undefined
      void nextTick(() => document.getElementById('plugin-heading-' + id)?.focus())
    }
  })
}

function changeStage(id: DeploymentPluginId) {
  const stage = deployment.value?.plugins[id]
  if (stage) update(id, { action: operations[stage], id })
}

function saveNewbi() {
  update('newbi', { action: 'CONFIGURE_NEWBI', endpoint: form.endpoint.trim(), credential: form.credential.trim() || undefined })
}
</script>

<template>
  <div class="console-stack plugin-workspace">
    <div class="console-actions plugin-toolbar">
      <NButton size="small" quaternary :loading="loading" :disabled="busy" @click="refresh">刷新插件</NButton>
    </div>
    <NAlert v-if="loadError" type="error" role="alert">{{ loadError }}</NAlert>
    <NSpin v-else-if="loading && !deployment" aria-label="正在读取插件" />
    <NEmpty v-else-if="!deployment" description="暂无部署插件目录。" />
    <template v-else>
      <article v-for="id in deploymentPluginIds" :key="id" class="console-record-workspace plugin-card"
        :aria-labelledby="'plugin-heading-' + id">
        <div class="console-section-heading plugin-title">
          <div>
            <h3 :id="'plugin-heading-' + id" tabindex="-1">{{ labels[id] }}</h3>
            <p>{{ id === 'newbi' ? '平台连接器 · 读取与发送分别运行' : '模型提供方 · 用于公开模拟草稿' }}</p>
          </div>
          <NTag size="small" :bordered="false" :type="deployment.plugins[id] === 'ENABLED' ? 'success' : 'default'">
            {{ stages[deployment.plugins[id]] }}
          </NTag>
        </div>

        <ul v-if="id === 'newbi'" class="plugin-components">
          <li v-for="component in newbiComponents" :key="component.id">
            <strong>{{ component.kind === 'platform-reader' ? '读取平台消息' : '发送已获许可的回复' }}</strong>
            <code>{{ component.id }}<template v-if="deployment.plugins[id] !== 'NOT_INSTALLED'"> · v{{ component.version }}</template></code>
          </li>
        </ul>
        <div v-else class="plugin-component">
          <strong>生成回复草稿</strong>
          <small>认知 Worker · {{ labels[id] }}<template v-if="deployment.plugins[id] !== 'NOT_INSTALLED' && modelVersions.has(id)"> · v{{ modelVersions.get(id) }}</template></small>
        </div>

        <div v-if="deployment.plugins[id] === 'ENABLED'" class="plugin-integration">
          <template v-if="id === 'newbi'">
            <span>{{ deployment.newbi.hasCredential ? '可接入账号' : '等待配置 Agent API' }}</span>
            <div class="console-actions">
              <NButton v-if="canConfigureModel" :id="'configure-plugin-' + id" size="small" secondary
                :aria-expanded="editing === id" :disabled="busy || loading" @click="toggleEditor(id)">
                {{ deployment.newbi.hasCredential ? '查看 Agent API 设置' : '配置 Agent API' }}
              </NButton>
              <NButton v-if="status?.newbiRegistrationAvailable" size="small" secondary @click="emit('accounts')">前往平台账号池</NButton>
            </div>
          </template>
          <template v-else>
            <span>{{ deployment.configuredModel === id ? '已选为草稿模型' : '已注册到认知 Worker · 待配置' }}</span>
            <NButton v-if="canConfigureModel" :id="'configure-plugin-' + id" size="small" secondary
              :aria-expanded="editing === id" :disabled="busy || loading" @click="toggleEditor(id)">
              {{ deployment.configuredModel === id ? '查看 AI API 设置' : '配置 AI API' }}
            </NButton>
          </template>
        </div>

        <div v-if="canConfigureModel" class="console-actions">
          <NButton size="small" :type="deployment.plugins[id] === 'ENABLED' ? 'warning' : 'primary'"
            :secondary="deployment.plugins[id] === 'ENABLED'" :disabled="busy || loading"
            :loading="busy && changedPlugin === id && editing !== id" @click="changeStage(id)">
            {{ deployment.plugins[id] === 'NOT_INSTALLED' ? '安装 ' + labels[id]
              : deployment.plugins[id] === 'INSTALLED' ? '启用 ' + labels[id] : '停用 ' + labels[id] }}
          </NButton>
        </div>

        <NAlert v-if="error && changedPlugin === id" type="error" role="alert">{{ error }}</NAlert>
        <section v-if="editing === 'newbi' && id === 'newbi' && deployment.plugins[id] === 'ENABLED'"
          class="plugin-config" aria-labelledby="newbi-settings-heading">
          <div class="console-section-heading">
            <h3 id="newbi-settings-heading" tabindex="-1">Newbi · Agent API 设置</h3>
            <NButton size="small" quaternary :disabled="busy" @click="toggleEditor(id)">收起设置</NButton>
          </div>
          <NForm class="newbi-form" @submit.prevent="saveNewbi">
            <NFormItem label="本机 API 地址" :label-props="{ for: 'newbi-endpoint' }">
              <NInput v-model:value="form.endpoint" placeholder="http://127.0.0.1:5000/agent-api/v1" :disabled="busy"
                :input-props="{ id: 'newbi-endpoint', required: true }" />
            </NFormItem>
            <NFormItem label="Agent 密钥" :label-props="{ for: 'newbi-secret' }">
              <NInput v-model:value="form.credential" type="password" :disabled="busy"
                :placeholder="deployment.newbi.hasCredential && deployment.newbi.endpoint === form.endpoint ? '留空继续使用已保存密钥' : '输入 Agent 密钥'"
                :input-props="{ id: 'newbi-secret', autocomplete: 'new-password' }" />
            </NFormItem>
            <NButton type="primary" attr-type="submit" :loading="busy">保存 Newbi 设置</NButton>
          </NForm>
        </section>
      </article>
      <ModelSettings v-if="modelEditor" :key="modelEditor"
        class="console-record-workspace" :provider="modelEditor" :name="labels[modelEditor]"
        @expired="expired" @close="modelEditor && toggleEditor(modelEditor)" @saved="refresh" />
    </template>
  </div>
</template>

<style scoped>
.plugin-workspace { gap: 1rem; }
.plugin-toolbar { justify-content: flex-end; }
.plugin-card { display: grid; gap: 1rem; }
.plugin-title { align-items: flex-start; margin: 0; }
.plugin-title p { margin: .25rem 0 0; color: var(--console-muted); }
.plugin-components { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: .625rem; margin: 0; padding: 0; }
.plugin-components li, .plugin-component { display: grid; gap: .25rem; padding: .25rem .75rem; border-inline-start: 2px solid var(--console-line); }
.plugin-components code, .plugin-component small, .plugin-integration > span { color: var(--console-muted); overflow-wrap: anywhere; }
.plugin-integration { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .625rem; }
.plugin-config { border-top: 1px solid var(--console-line); padding-block-start: 1rem; }
.newbi-form { max-width: 35rem; }
</style>
