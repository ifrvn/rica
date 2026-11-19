<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { UiButton, UiCheckbox, UiField } from '@ricajs/console-shared/ui'
const props = defineProps<{ value: string; backgroundAssessments: boolean; busy: boolean }>()
const emit = defineEmits<{ close: []; save: [settings: { action: 'CONFIGURE_NEWBI'; endpoint: string; backgroundAssessments: boolean }] }>()
const endpoint = ref(props.value)
const backgroundAssessments = ref(props.backgroundAssessments)
const heading = ref<HTMLElement>()
onMounted(() => heading.value?.focus())
</script>

<template>
  <section aria-labelledby="newbi-settings-heading">
    <div class="console-section-heading">
      <h3 id="newbi-settings-heading" ref="heading" tabindex="-1">Newbi · Agent API 设置</h3>
      <UiButton size="small" variant="quiet" :disabled="busy" @click="emit('close')">收起设置</UiButton>
    </div>
    <form class="newbi-form console-stack" @submit.prevent="emit('save', { action: 'CONFIGURE_NEWBI', endpoint: endpoint.trim(), backgroundAssessments })">
      <UiField label="本机 API 地址" for="newbi-endpoint">
        <input class="ui-control" v-model="endpoint" placeholder="http://127.0.0.1:5000/agent-api/v1" :disabled="busy"
          v-bind="{ id: 'newbi-endpoint', required: true }" />
      </UiField>
      <UiCheckbox v-model="backgroundAssessments" :disabled="busy">后台读取并评估新讨论</UiCheckbox>
      <p class="newbi-settings-note">使用已启用的 Newbi 账号和外部模型。评估结果进入运行记录，发言仍由管理员发起。</p>
      <UiButton tone="primary" type="submit" :loading="busy">保存 Newbi 设置</UiButton>
    </form>
  </section>
</template>

<style scoped>
.newbi-form { max-width: 35rem; }
.newbi-settings-note { margin: 0; color: var(--console-muted); }
</style>
