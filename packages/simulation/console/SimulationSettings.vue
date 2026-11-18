<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { UiAlert, UiButton, UiField, UiSpinner } from '@ricajs/console-shared/ui'
import { characterPath, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import {
  defaultSimulationSettings, simulationSettingsInput, type SimulationSettings, type SimulationSettingsView,
} from '../contracts/settings.js'

const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: [] }>()
const { active, busy, error, notice, run } = useConsoleTask(() => emit('expired'))
const path = computed(() => characterPath(props.characterId) + '/simulation-settings')
const current = ref<SimulationSettingsView>()
const form = ref<SimulationSettings>({ ...defaultSimulationSettings })
const parsed = computed(() => simulationSettingsInput.safeParse(form.value))
const dirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(current.value?.settings))
const customBudget = computed({
  get: () => form.value.simulationModelBudget !== null,
  set: (enabled) => { form.value.simulationModelBudget = enabled ? current.value?.inheritedModelBudget ?? 10_000_000 : null },
})

function load() {
  void run(async () => {
    const settings = await request<SimulationSettingsView>(path.value)
    if (!active()) return
    current.value = settings
    form.value = { ...settings.settings }
  })
}

function save() {
  const view = current.value
  const data = parsed.value
  if (!view || !data.success || !dirty.value || busy.value) return
  void run(async () => {
    const saved = await request<{ version: number }>(path.value, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"' + view.version + '"' },
      body: JSON.stringify(data.data),
    })
    if (!active()) return
    current.value = { ...view, version: saved.version, settings: data.data }
    form.value = { ...data.data }
    notice.value = '模拟限制已保存，待执行任务会在下次检查时使用新规则。'
  })
}

onMounted(load)
</script>

<template>
  <section class="console-card console-stack" aria-labelledby="simulation-settings-heading">
    <div class="console-section-heading">
      <h3 id="simulation-settings-heading">模拟限制</h3>
      <UiButton size="small" variant="quiet" :disabled="busy" @click="load">重新读取</UiButton>
    </div>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiSpinner v-if="busy && !current" aria-label="正在读取模拟限制" />
    <form v-if="current" class="console-stack" @submit.prevent="save">
      <p class="console-record-meta">设置应用于当前角色的模拟运行。角色时区 {{ current.timezone }}。</p>
      <fieldset class="settings-group" :disabled="busy">
        <legend>执行额度</legend>
        <div class="settings-grid">
          <UiField label="每个模拟账号每日执行次数" for="simulation-daily-limit" feedback="按角色时区的午夜重置。填 0 表示不限。">
            <input id="simulation-daily-limit" v-model.number="form.simulationDailyLimit" class="ui-control" type="number" min="0" max="10000" required>
          </UiField>
          <UiField label="同一联系人的最短回复间隔（分钟）" for="simulation-cooldown" feedback="同一账号跨会话共用间隔。填 0 表示不限。">
            <input id="simulation-cooldown" v-model.number="form.simulationCooldownMinutes" class="ui-control" type="number" min="0" max="1440" required>
          </UiField>
        </div>
      </fieldset>
      <fieldset class="settings-group" :disabled="busy">
        <legend>静默与调度</legend>
        <label><input v-model="form.simulationQuietEnabled" type="checkbox"> 启用静默时段</label>
        <div class="settings-grid">
          <UiField label="静默开始" for="simulation-quiet-from">
            <input id="simulation-quiet-from" v-model="form.simulationQuietFrom" class="ui-control" type="time" required>
          </UiField>
          <UiField label="静默结束" for="simulation-quiet-until">
            <input id="simulation-quiet-until" v-model="form.simulationQuietUntil" class="ui-control" type="time" required>
          </UiField>
        </div>
        <p v-if="form.simulationQuietFrom === form.simulationQuietUntil" class="console-record-meta">开始和结束时间须不同。</p>
        <label v-if="form.simulationQuietEnabled"><input v-model="form.simulationQuietForChat" type="checkbox"> 控制台手动群聊也遵守静默时段</label>
        <UiField label="每日定时任务补跑窗口（分钟）" for="simulation-catch-up" feedback="错过计划时间后，超出窗口的这一轮任务会跳过。">
          <input id="simulation-catch-up" v-model.number="form.simulationCatchUpMinutes" class="ui-control" type="number" min="1" max="1440" required>
        </UiField>
      </fieldset>
      <fieldset class="settings-group" :disabled="busy">
        <legend>提案与模型</legend>
        <UiField label="新提案有效期（小时）" for="simulation-proposal-hours" feedback="从草稿生成时起算。已生成提案沿用原有效期。">
          <input id="simulation-proposal-hours" v-model.number="form.simulationProposalHours" class="ui-control" type="number" min="1" max="168" required>
        </UiField>
        <label><input v-model="customBudget" type="checkbox"> 单独设置模拟每日模型预算</label>
        <UiField v-if="customBudget" label="每日模型预算（估算单位）" for="simulation-model-budget" feedback="按 UTC 午夜重置，按输入与预留输出估算。">
          <input id="simulation-model-budget" v-model.number="form.simulationModelBudget" class="ui-control" type="number" min="1024" max="100000000" required>
        </UiField>
        <p v-else class="console-record-meta">沿用角色预算，每天 {{ current.inheritedModelBudget.toLocaleString() }} 估算单位，按 UTC 午夜重置。</p>
      </fieldset>
      <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
      <div class="console-actions">
        <UiButton tone="primary" type="submit" :loading="busy" :disabled="!dirty || !parsed.success">保存设置</UiButton>
        <UiButton variant="quiet" :disabled="busy" @click="form = { ...defaultSimulationSettings }">恢复默认值</UiButton>
      </div>
    </form>
    <details v-if="current">
      <summary>其他执行条件</summary>
      <p>提案须通过审批，并保持账号、适配器和证据授权有效。同一账号同时只处理一个执行许可，结果未知时需先对账。写入本地回执的许可最长有效 30 秒。</p>
      <p>单条消息和回复各限 4,000 字符。模拟消息和草稿正文保留 30 天，运行证据引用保留 90 天。</p>
    </details>
  </section>
</template>

<style scoped>
.settings-group { display: grid; gap: .75rem; min-inline-size: 0; border: 1px solid var(--console-line); border-radius: 6px; padding: .75rem; }
.settings-group legend { font-weight: 650; }
.settings-group p { margin: 0; }
.settings-grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
</style>
