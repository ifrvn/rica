<script setup lang="ts">
import { reactive, ref } from 'vue'
import { pluginConsoleContent, type PluginConsoleEntry } from '@ricajs/contracts/plugin-console'
import { characterPath, queryPath, readAll, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import { UiAlert, UiButton, UiField } from '@ricajs/console-shared/ui'

const props = defineProps<{ entry: PluginConsoleEntry; characterId: string }>()
const emit = defineEmits<{ expired: [] }>()
const { active, busy, command, error, notice, run } = useConsoleTask(() => emit('expired'))
const base = characterPath(props.characterId)
const path = base + '/plugins/' + props.entry.id
const accountId = ref('')
type Account = { id: string; platform: string; remoteAccountId: string; status: string }
const accounts = ref<Account[]>()
const summary = ref<{ label: string; value: string }[]>()
const details = ref<typeof summary.value>()
const form = reactive({ instanceKey: '', remoteAccountId: '', data: Object.fromEntries(
  (props.entry.accountFields ?? []).map(({ key }) => [key, '']),
) })
async function load() {
  await run(async () => {
    if (props.entry.summaryPath) {
      const result = pluginConsoleContent.parse(await request(path + props.entry.summaryPath))
      if (active()) summary.value = result.fields
    }
    if (props.entry.accountDetailPath) {
      const rows = await readAll<Account>(base + '/accounts', active)
      if (active()) accounts.value = rows.filter(row => row.platform === props.entry.id && row.status !== 'REVOKED')
    }
  })
}
async function readDetails() {
  if (!props.entry.accountDetailPath || !accountId.value) return
  const url = queryPath(path + props.entry.accountDetailPath, { accountId: accountId.value })
  await run(async () => {
    details.value = undefined
    const result = pluginConsoleContent.parse(await request(url))
    if (active()) details.value = result.fields
  })
}
async function register() {
  await run(async () => {
    await command(base + '/account-pool', { platform: props.entry.id, instanceKey: form.instanceKey.trim(),
      remoteAccountId: form.remoteAccountId.trim(), data: { ...form.data } })
    if (!active()) return
    form.instanceKey = form.remoteAccountId = ''
    for (const key of Object.keys(form.data)) form.data[key] = ''
    notice.value = '账号已加入账号池，可在账号页关联身份。'
  })
}
</script>

<template>
  <section class="console-card console-stack">
    <h3>{{ entry.title }}</h3>
    <UiAlert v-if="error" tone="error" role="alert">{{ error }}</UiAlert>
    <UiAlert v-if="notice" tone="success" role="status">{{ notice }}</UiAlert>
    <div v-if="entry.summaryPath || entry.accountDetailPath">
      <UiButton size="small" :loading="busy" @click="load">读取插件信息</UiButton>
    </div>
    <dl v-if="summary?.length" class="package-fields">
      <div v-for="(row, index) in summary" :key="index"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
    </dl>
    <p v-else-if="summary">暂无摘要。</p>
    <form v-if="accounts?.length" class="console-stack" @submit.prevent="readDetails">
      <UiField label="已绑定账号" :for="'package-account-' + entry.id">
        <select :id="'package-account-' + entry.id" v-model="accountId" :disabled="busy" @change="details = undefined">
          <option value="">选择账号</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.remoteAccountId }}</option>
        </select>
      </UiField>
      <div><UiButton type="submit" size="small" :disabled="!accountId || busy">查看账号详情</UiButton></div>
    </form>
    <p v-else-if="accounts">暂无已绑定账号。</p>
    <dl v-if="details?.length" class="package-fields">
      <div v-for="(row, index) in details" :key="index"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
    </dl>
    <p v-else-if="details">暂无账号详情。</p>
    <form v-if="entry.accountFields" class="console-form-grid" @submit.prevent="register">
      <UiField label="实例标识" :for="'package-instance-' + entry.id">
        <input :id="'package-instance-' + entry.id" v-model="form.instanceKey" required :disabled="busy" />
      </UiField>
      <UiField label="远端账号 ID" :for="'package-remote-' + entry.id">
        <input :id="'package-remote-' + entry.id" v-model="form.remoteAccountId" required :disabled="busy" />
      </UiField>
      <UiField v-for="field in entry.accountFields" :key="field.key" :label="field.label" :for="'package-' + entry.id + '-' + field.key">
        <input :id="'package-' + entry.id + '-' + field.key" v-model="form.data[field.key]"
          :type="field.kind === 'secret' ? 'password' : 'text'" :autocomplete="field.kind === 'secret' ? 'new-password' : undefined"
          maxlength="2000" :disabled="busy" />
      </UiField>
      <div><UiButton type="submit" :disabled="busy">添加插件账号</UiButton></div>
    </form>
  </section>
</template>

<style scoped>
.package-fields { display: grid; gap: .5rem; overflow-wrap: anywhere; }
.package-fields dt { font-weight: 600; }
.package-fields dd { margin: 0; }
</style>
