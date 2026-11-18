<script setup lang="ts">
import { computed, ref } from 'vue'
import { UiAlert, UiBadge, UiButton, UiDialog } from '@ricajs/console-shared/ui'
import { formatTime, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import { simulationPlatformId } from '@ricajs/contracts/management'
import type { z } from '@hono/zod-openapi'
import type { DeploymentPluginsView } from '../../../../deployment-plugin-contracts.js'
import type { PluginStatus } from './plugin-status.js'

type Platform = z.infer<typeof simulationPlatformId>
const props = defineProps<{ status: PluginStatus; deployment: DeploymentPluginsView; canConfigure: boolean }>()
const emit = defineEmits<{ expired: []; changed: [value: DeploymentPluginsView]; refresh: [] }>()
const { busy, error, run } = useConsoleTask(() => emit('expired'))
const editing = ref(false)
const inherit = ref(true)
const choices = ref<Platform[]>([])
const notice = ref('')
const localDefault = computed(() => !props.deployment.configuredModel || props.deployment.plugins['hosted-models'] !== 'ENABLED')
const names = { api: '管理 API', worker: '认知 Worker', 'simulation-executor': '模拟执行器' }
const sources = { BUILT_IN_DEFAULT: '内置默认', ENVIRONMENT: '环境变量', DEPLOYMENT_SETTINGS: '插件中心' }
const reports = computed(() => Object.entries(names).map(([id, label]) => {
  const report = props.status.services.find(({ service }) => service === id)?.report
  const platforms = report?.plugins.filter(({ kind }) => kind === 'platform') ?? []
  const expected = props.deployment.simulationPlatforms
  const aligned = expected
    ? report?.simulationPlatformSource === 'DEPLOYMENT_SETTINGS' && expected.length === platforms.length
      && expected.every(id => platforms.some(p => p.id === id))
    : report?.simulationPlatformSource !== 'DEPLOYMENT_SETTINGS'
  return { id, label, report, platforms, aligned }
}))
const fallback = computed(() => props.status.services.find(({ service }) => service === 'worker')?.catalog.find(({ id }) => id === 'simulated'))
const workerReport = computed(() => reports.value.find(({ id }) => id === 'worker')?.report)

function edit() {
  error.value = ''
  notice.value = ''
  inherit.value = props.deployment.simulationPlatforms === undefined
  choices.value = [...(props.deployment.simulationPlatforms ?? simulationPlatformId.options)]
  editing.value = true
}

function save() {
  void run(async () => {
    const updated = await request<DeploymentPluginsView>('/v1/deployment-plugins', {
      method: 'PUT',
      headers: { 'If-Match': '"' + props.deployment.version + '"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'CONFIGURE_SIMULATED_PLATFORMS', platforms: inherit.value ? null : choices.value }),
    })
    editing.value = false
    notice.value = '已保存。重启管理 API、认知 Worker 和模拟执行器后生效。'
    emit('changed', updated)
  })
}

function useLocal() {
  notice.value = ''
  void run(async () => {
    const { version } = await request<{ version: number }>('/v1/model-settings')
    await request('/v1/model-settings/active', {
      method: 'PUT', headers: { 'If-Match': '"' + version + '"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: null }),
    })
    notice.value = '已将本地模拟模型设为部署默认。'
    emit('refresh')
  })
}
</script>

<template>
  <article class="console-record-workspace console-stack" aria-labelledby="built-in-model-heading">
    <div class="console-section-heading">
      <div>
        <h3 id="built-in-model-heading">本地模拟模型</h3>
        <p v-if="fallback">{{ fallback.id }} · v{{ fallback.version }}</p>
      </div>
      <UiBadge>内置组件</UiBadge>
    </div>
    <p>用于本地决策、私聊写作，以及外部模型未配置或停用时的公开写作。宿主依赖此组件。</p>
    <p>部署默认写作模型 {{ localDefault ? '本地模拟模型' : deployment.configuredModel }}</p>
    <p>认知 Worker 最近报告 {{ workerReport?.status === 'FAILED' ? '失败'
      : workerReport?.plugins.find(({ kind }) => kind === 'model')?.id ?? '暂无模型报告' }}</p>
    <div v-if="canConfigure && !localDefault" class="console-actions">
      <UiButton size="small" variant="soft" :disabled="busy" @click="useLocal">设为部署默认</UiButton>
    </div>
  </article>
  <article class="console-record-workspace console-stack" aria-labelledby="built-in-platform-heading">
    <div class="console-section-heading">
      <h3 id="built-in-platform-heading">模拟平台</h3>
      <UiBadge>内置组件</UiBadge>
    </div>
    <p>配置来源 {{ deployment.simulationPlatforms ? '插件中心' : '各进程的环境变量或内置默认' }}
      <template v-if="deployment.simulationPlatforms"> · 启用 {{ deployment.simulationPlatforms.join('、') || '无' }}</template></p>
    <ul class="console-record-list">
      <li v-for="{ id, label, report, platforms, aligned } in reports" :key="id">
        <strong>{{ label }}</strong>
        <span v-if="!report">暂无近期报告</span>
        <span v-else-if="report.status === 'FAILED'">运行报告失败 · {{ report.diagnostic }}</span>
        <template v-else>
          <span>{{ platforms.map(p => p.id + ' v' + p.version).join('、') || '无已启用适配器' }}</span>
          <span>{{ report.simulationPlatformSource ? sources[report.simulationPlatformSource] : '配置来源未报告' }} · {{ formatTime(report.observedAt) }}</span>
          <UiBadge v-if="!aligned" tone="warning">配置尚未生效</UiBadge>
        </template>
      </li>
    </ul>
    <div v-if="canConfigure" class="console-actions">
      <UiButton size="small" variant="soft" :disabled="busy" @click="edit">配置模拟平台</UiButton>
    </div>
    <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
    <UiAlert v-if="error && !editing" tone="error" role="alert">{{ error }}</UiAlert>
    <UiDialog v-model:open="editing" title="配置模拟平台" :busy="busy">
      <form class="console-stack" @submit.prevent="save">
        <label><input v-model="inherit" type="checkbox" :disabled="busy"> 使用启动环境配置</label>
        <fieldset v-if="!inherit" :disabled="busy">
          <legend>启用的适配器</legend>
          <label v-for="id in simulationPlatformId.options" :key="id"><input v-model="choices" type="checkbox" :value="id"> {{ id }} </label>
        </fieldset>
        <p>保存后需要重启三个相关进程。停用适配器会阻止新运行，尚未执行的提案也可能失效。</p>
        <UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
        <div class="console-actions"><UiButton type="submit" tone="primary" :loading="busy">保存设置</UiButton></div>
      </form>
    </UiDialog>
  </article>
</template>
