<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import type { PluginMetadata } from '../../../../../packages/contracts/plugin-status.js'
import { usePluginStatus } from './plugin-status.js'

const props = defineProps<{ characterId: string; canConfigureModel: boolean }>()
const emit = defineEmits<{ expired: []; accounts: []; configureModel: [] }>()
const { status, busy, error, refresh } = usePluginStatus(props.characterId, () => emit('expired'))
const api = computed(() => status.value?.services.find(({ service }) => service === 'api'))
const worker = computed(() => status.value?.services.find(({ service }) => service === 'worker'))
const newbi = computed(() => status.value?.services.flatMap(({ catalog }) =>
  catalog.filter(({ kind }) => kind === 'platform-reader' || kind === 'platform-reply-executor')) ?? [])

const labels: Record<string, string> = {
  simulated: '本地模拟模板', openai: 'OpenAI', anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini', 'openai-compatible': 'OpenAI 兼容服务',
}

function loadState(plugin: PluginMetadata, service?: NonNullable<typeof api.value>) {
  if (service?.report?.status !== 'READY') return '载入状态未知'
  return service.report.plugins.some(({ id, kind }) => id === plugin.id && kind === plugin.kind)
    ? '已载入' : '可选'
}
</script>

<template>
  <div class="console-stack">
    <div class="console-actions plugin-toolbar">
      <NButton size="small" quaternary :loading="busy" @click="refresh">刷新插件</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin v-else-if="busy && !status" aria-label="正在读取插件" />
    <NEmpty v-else-if="!status?.services.length" description="暂无插件目录。" />
    <template v-else>
      <section v-if="newbi.length" class="console-record-workspace" aria-labelledby="newbi-plugin">
        <div class="console-section-heading">
          <h3 id="newbi-plugin"><span class="i-lucide-plug" aria-hidden="true" /> Newbi</h3>
          <NTag size="small" :bordered="false" :type="status.newbiRegistrationAvailable ? 'success' : 'default'">
            {{ status.newbiRegistrationAvailable ? '可接入账号' : '等待部署配置' }}
          </NTag>
        </div>
        <ul class="plugin-components">
          <li v-for="plugin in newbi" :key="plugin.id">
            <strong>{{ plugin.kind === 'platform-reader' ? '读取平台消息' : '发送获许可的回复' }}</strong>
            <small>{{ plugin.id }} · v{{ plugin.version }} · 契约 {{ plugin.contractVersion }}</small>
          </li>
        </ul>
        <NButton v-if="status.newbiRegistrationAvailable" size="small" secondary @click="emit('accounts')">前往平台账号池</NButton>
      </section>

      <section v-if="worker" class="console-record-workspace" aria-labelledby="model-plugin">
        <div class="console-section-heading">
          <h3 id="model-plugin"><span class="i-lucide-sparkles" aria-hidden="true" /> 草稿模型</h3>
          <NButton v-if="canConfigureModel" size="small" type="primary" @click="emit('configureModel')">配置 AI API</NButton>
        </div>
        <ul class="plugin-components">
          <li v-for="plugin in worker.catalog.filter(({ kind }) => kind === 'model')" :key="plugin.id">
            <strong>{{ labels[plugin.id] ?? plugin.id }}</strong>
            <small>{{ loadState(plugin, worker) }} · v{{ plugin.version }}</small>
          </li>
        </ul>
      </section>

      <section v-if="api" class="console-record-workspace" aria-labelledby="simulation-plugin">
        <div class="console-section-heading">
          <h3 id="simulation-plugin"><span class="i-lucide-flask-conical" aria-hidden="true" /> 模拟平台</h3>
        </div>
        <ul class="plugin-components">
          <li v-for="plugin in api.catalog" :key="plugin.id">
            <strong>{{ plugin.id }}</strong>
            <small>{{ loadState(plugin, api) }} · v{{ plugin.version }} · 契约 {{ plugin.contractVersion }}</small>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.plugin-toolbar { justify-content: flex-end; }
.plugin-components { list-style: none; margin: 0; padding: 0; }
.plugin-components li { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .35rem 1rem; padding: .7rem 0; }
.plugin-components li + li { border-top: 1px solid var(--console-line); }
.plugin-components small { color: var(--console-muted); overflow-wrap: anywhere; }
</style>
