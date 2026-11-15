<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import { deploymentPluginChange, deploymentPluginIds, type DeploymentPluginId, type DeploymentPluginsView } from '../../../../deployment-plugin-contracts.js'
import { useConsoleTask } from '@rica/console-shared/console-data'
import { request } from '@rica/console-shared/request'
import { pluginCards as cards, pluginServiceNames, registrationAvailable } from '../../app/plugin-integrations.js'
import { pluginNames as labels, usePluginStatus } from './plugin-status.js'
import type { PluginMetadata } from '../../../../../packages/contracts/plugin-status.js'

const props = defineProps<{ characterId: string; canConfigureModel: boolean; canStartSimulation: boolean; canReview: boolean }>()
const emit = defineEmits<{
  expired: []; accounts: []; health: []; simulate: []; deploymentChanged: [deployment: DeploymentPluginsView]
  review: [plugin: string, status: string]
}>()
const expired = () => emit('expired')
const { status, busy: loading, error: loadError, refresh } = usePluginStatus(props.characterId, expired, false)
const { busy, error, active, run } = useConsoleTask(expired)
const deployment = computed(() => status.value?.deployment)
const editing = ref<DeploymentPluginId>()
const changedPlugin = ref<DeploymentPluginId>()
const releasePreview = ref<DeploymentPluginId>()
const stages = { NOT_INSTALLED: '未安装', INSTALLED: '已安装 · 未启用', ENABLED: '已启用' } as const
const operations = { NOT_INSTALLED: 'INSTALL', INSTALLED: 'ENABLE', ENABLED: 'DISABLE' } as const
const release = computed(() => status.value?.release)
const upgrades = computed(() => new Map(release.value?.status === 'AVAILABLE'
  ? release.value.upgrades.map((item) => [item.id, item] as const) : []))
const versions = computed(() => new Map(release.value?.status === 'AVAILABLE'
  ? [...release.value.upgrades, ...release.value.aligned].map((item) => [item.id, item] as const) : []))
const releaseBlocked = computed(() => !!releasePreview.value
  && !!upgrades.value.get(releasePreview.value)?.components.some(({ problem }) => problem))
const upgradeQueue = computed(() => releasePreview.value
  ? cards[releasePreview.value].upgradeQueue?.(status.value)?.filter(({ count }) => count > 0) : undefined)
const upgradeProblems = {
  MISSING_COMPONENT: '目标发布缺少此组件',
  INCOMPATIBLE_CONTRACT: '宿主契约版本不兼容',
  DOWNGRADE: '目标发布会降级此组件',
}
const serviceNames: Record<string, string> = { api: '管理 API', worker: '认知 Worker', 'simulation-executor': '模拟执行器', ...pluginServiceNames }

function reportedVersion(id: DeploymentPluginId, entry: { service: string; current: PluginMetadata; target: PluginMetadata | null }) {
  if (deployment.value?.plugins[id] !== 'ENABLED') return '插件未启用'
  if (entry.current.kind === 'model' && deployment.value.configuredModel !== id) return '当前未选用此模型'
  const report = status.value?.services.find(({ service }) => service === entry.service)?.report
  if (!report) return '暂无近期运行报告'
  if (report.status === 'FAILED') return '最近运行报告失败'
  const observed = report.plugins.find(({ id, kind }) => id === entry.current.id && kind === entry.current.kind)
  if (!observed) return '近期报告未包含此组件'
  const version = '报告 v' + observed.version + ' · 契约 ' + observed.contractVersion
  return observed.version === entry.target?.version && observed.contractVersion === entry.target.contractVersion
    ? version + ' · 符合目标' : version + ' · 与目标不同'
}

function toggleRelease(id: DeploymentPluginId) {
  releasePreview.value = releasePreview.value === id ? undefined : id
  const focusId = releasePreview.value ? 'plugin-release-heading-' : 'plugin-release-toggle-'
  void nextTick(() => document.getElementById(focusId + id)?.focus())
}

function toggleEditor(id: DeploymentPluginId) {
  if (editing.value === id) {
    editing.value = undefined
    void nextTick(() => document.getElementById('configure-plugin-' + id)?.focus())
    return
  }
  editing.value = id
  error.value = ''
}

function update(id: DeploymentPluginId, data: unknown) {
  if (!deployment.value || !props.canConfigureModel || loading.value || busy.value) return
  changedPlugin.value = id
  const parsed = deploymentPluginChange.safeParse(data)
  if (!parsed.success) {
    error.value = cards[id].invalidSettings ?? '请检查插件配置。'
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
      ...registrationAvailable(updated) }
    emit('deploymentChanged', updated)
    if ((cards[id].inlineEditor || parsed.data.action === 'DISABLE') && editing.value === id) {
      editing.value = undefined
      void nextTick(() => document.getElementById('plugin-heading-' + id)?.focus())
    }
  })
}

function saveSettings(id: DeploymentPluginId, value: string) {
  const change = cards[id].settingsChange?.(value)
  if (change) update(id, change)
}

function changeStage(id: DeploymentPluginId) {
  const stage = deployment.value?.plugins[id]
  if (stage) update(id, { action: operations[stage], id })
}

</script>

<template>
  <div class="console-stack plugin-workspace">
    <div class="console-actions plugin-toolbar">
      <span v-if="release?.status === 'UNCONFIGURED'" class="plugin-release-note">尚未配置发布清单</span>
      <span v-else-if="release?.status === 'AVAILABLE' && !release.upgrades.length"
        class="plugin-release-note">部署组件目录与发布清单一致，可继续核对运行报告</span>
      <NButton size="small" quaternary :loading="loading" :disabled="busy" @click="refresh">刷新插件</NButton>
    </div>
    <NAlert v-if="loadError" type="error" role="alert">{{ loadError }}</NAlert>
    <NSpin v-else-if="loading && !deployment" aria-label="正在读取插件" />
    <NEmpty v-else-if="!deployment" description="暂无部署插件目录。" />
    <template v-else>
      <NAlert v-if="release?.status === 'UNAVAILABLE'" type="warning" role="status">发布清单暂不可用。部署维护者可核对清单文件，再刷新插件。</NAlert>
      <article v-for="id in deploymentPluginIds" :key="id" class="console-record-workspace plugin-card"
        :aria-labelledby="'plugin-heading-' + id">
        <div class="console-section-heading plugin-title">
          <div>
            <h3 :id="'plugin-heading-' + id" tabindex="-1">{{ labels[id] }}</h3>
            <p>{{ cards[id].description }}</p>
          </div>
          <NTag size="small" :bordered="false" :type="deployment.plugins[id] === 'ENABLED' ? 'success' : 'default'">
            {{ stages[deployment.plugins[id]] }}
          </NTag>
        </div>

        <ul class="plugin-components">
          <li v-for="component in cards[id].components(status)" :key="component.id">
            <strong>{{ component.label }}</strong>
            <small>{{ component.detail }}<template v-if="deployment.plugins[id] !== 'NOT_INSTALLED' && component.version"> · v{{ component.version }}</template></small>
          </li>
        </ul>

        <div v-if="deployment.plugins[id] === 'ENABLED'" class="plugin-integration">
          <span>{{ cards[id].summary(deployment) }}</span>
          <div class="console-actions">
            <NButton v-if="canConfigureModel" :id="'configure-plugin-' + id" size="small" secondary
              :aria-expanded="editing === id" :disabled="busy || loading" @click="toggleEditor(id)">
              {{ cards[id].configureLabel(deployment) }}
            </NButton>
            <NButton v-if="cards[id].accountLink?.(status)" size="small" secondary @click="emit('accounts')">前往平台账号池</NButton>
          </div>
        </div>

        <div v-if="canConfigureModel || (deployment.plugins[id] !== 'NOT_INSTALLED' && versions.has(id))" class="console-actions">
          <NButton v-if="canConfigureModel" size="small" :type="deployment.plugins[id] === 'ENABLED' ? 'warning' : 'primary'"
            :secondary="deployment.plugins[id] === 'ENABLED'" :disabled="busy || loading"
            :loading="busy && changedPlugin === id && editing !== id" @click="changeStage(id)">
            {{ deployment.plugins[id] === 'NOT_INSTALLED' ? '安装 ' + labels[id]
              : deployment.plugins[id] === 'INSTALLED' ? '启用 ' + labels[id] : '停用 ' + labels[id] }}
          </NButton>
          <NButton v-if="deployment.plugins[id] !== 'NOT_INSTALLED' && versions.has(id)"
            :id="'plugin-release-toggle-' + id" size="small" secondary
            :aria-expanded="releasePreview === id" :aria-controls="'plugin-release-' + id" @click="toggleRelease(id)">
            {{ releasePreview === id ? '收起版本检查' : upgrades.has(id) ? '检查升级' : '核对运行版本' }}
          </NButton>
        </div>

        <section v-if="releasePreview === id && deployment.plugins[id] !== 'NOT_INSTALLED'
          && release?.status === 'AVAILABLE' && versions.has(id)" :id="'plugin-release-' + id"
          class="plugin-config" :aria-labelledby="'plugin-release-heading-' + id">
          <div class="console-section-heading">
            <h3 :id="'plugin-release-heading-' + id" tabindex="-1">Rica {{ release.ricaVersion }} · {{ labels[id] }} 版本检查</h3>
          </div>
          <ul class="console-record-list">
            <li v-for="entry in versions.get(id)?.components" :key="entry.service + '/' + entry.current.id">
              <strong>{{ serviceNames[entry.service] ?? entry.service }} · {{ entry.current.id }}</strong>
              <span class="plugin-release-note">
                部署目录 v{{ entry.current.version }} · 契约 {{ entry.current.contractVersion }}
                <template v-if="entry.target"> → 目标 v{{ entry.target.version }} · 契约 {{ entry.target.contractVersion }}</template>
              </span>
              <span v-if="entry.problem">{{ upgradeProblems[entry.problem] }}</span>
              <span class="plugin-release-note">{{ reportedVersion(id, entry) }}</span>
            </li>
          </ul>
          <NAlert v-if="releaseBlocked" type="warning" title="当前发布有升级阻碍">
            请让部署维护者核对上述组件，修正发布清单或选择兼容的 Rica 版本。
          </NAlert>
          <template v-else-if="upgrades.has(id)">
            <template v-if="cards[id].upgradeQueue">
              <NAlert v-if="upgradeQueue?.length" type="warning" title="当前角色有发送结果需核对">
                等待在途发送完成，或核对未知结果后恢复或结案。部署前请逐个角色检查。
                <div class="console-actions">
                  <template v-for="queue in upgradeQueue" :key="queue.status">
                    <NButton v-if="canReview" size="small" secondary @click="emit('review', id, queue.status)">
                      {{ queue.count }} 条{{ queue.label }}
                    </NButton>
                    <span v-else>{{ queue.count }} 条{{ queue.label }}</span>
                  </template>
                </div>
              </NAlert>
              <p v-else-if="upgradeQueue" class="plugin-release-note">当前角色无在途或待核对发送。发布涉及整个部署，请逐个角色检查。</p>
              <NAlert v-else type="warning">暂无当前角色的发送状态，请刷新后核对。</NAlert>
            </template>
            <h4>升级步骤</h4>
            <ol class="plugin-release-steps">
              <li v-if="cards[id].upgradeStep">{{ cards[id].upgradeStep }}</li>
              <li>请部署维护者按发布说明更新 Rica 至 {{ release.ricaVersion }}，并重启相关进程。</li>
              <li>部署完成后刷新插件，核对组件版本，并到系统运行状况确认相关进程的最新报告。</li>
            </ol>
          </template>
          <div class="console-actions plugin-release-actions">
            <NButton tag="a" :href="release.releaseUrl" target="_blank" rel="noopener noreferrer" size="small"
              :type="releaseBlocked ? 'default' : 'primary'">
              打开发布说明
            </NButton>
            <NButton v-if="!releaseBlocked" size="small" secondary
              :disabled="busy || loading" @click="refresh">刷新组件版本</NButton>
            <NButton v-if="!releaseBlocked" size="small" quaternary @click="emit('health')">查看系统运行状况</NButton>
          </div>
        </section>

        <NAlert v-if="error && changedPlugin === id" type="error" role="alert">{{ error }}</NAlert>
        <component v-if="editing === id && deployment.plugins[id] === 'ENABLED' && cards[id].inlineEditor"
          :is="cards[id].editor" class="plugin-config" v-bind="cards[id].editorProps(deployment)"
          :busy="busy" @close="toggleEditor(id)" @save="saveSettings(id, $event)" />
      </article>
      <component v-if="editing && deployment.plugins[editing] === 'ENABLED' && !cards[editing].inlineEditor"
        :is="cards[editing].editor" :key="editing" class="console-record-workspace" v-bind="cards[editing].editorProps(deployment)"
        :can-start-simulation="canStartSimulation" @expired="expired" @close="editing && toggleEditor(editing)"
        @saved="refresh" @simulate="emit('simulate')" />
    </template>
  </div>
</template>

<style scoped>
.plugin-workspace { gap: 1rem; }
.plugin-toolbar { justify-content: flex-end; }
.plugin-release-note { color: var(--console-muted); font-size: .875rem; }
.plugin-card { display: grid; gap: 1rem; }
.plugin-title { align-items: flex-start; margin: 0; }
.plugin-title p { margin: .25rem 0 0; color: var(--console-muted); }
.plugin-components { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: .625rem; margin: 0; padding: 0; }
.plugin-components li, .plugin-component { display: grid; gap: .25rem; padding: .25rem .75rem; border-inline-start: 2px solid var(--console-line); }
.plugin-components code, .plugin-component small, .plugin-integration > span { color: var(--console-muted); overflow-wrap: anywhere; }
.plugin-integration { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .625rem; }
.plugin-config { border-top: 1px solid var(--console-line); padding-block-start: 1rem; }
.plugin-release-steps { display: grid; gap: .5rem; padding-inline-start: 1.25rem; }
.plugin-release-actions { margin-block-start: .75rem; }
</style>
