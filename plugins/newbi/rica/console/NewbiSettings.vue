<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { UiButton, UiField } from '@rica/console-shared/ui'
const props = defineProps<{ value: string; busy: boolean }>()
const emit = defineEmits<{ close: []; save: [endpoint: string] }>()
const endpoint = ref(props.value)
const heading = ref<HTMLElement>()
onMounted(() => heading.value?.focus())
</script>

<template>
  <section aria-labelledby="newbi-settings-heading">
    <div class="console-section-heading">
      <h3 id="newbi-settings-heading" ref="heading" tabindex="-1">Newbi · Agent API 设置</h3>
      <UiButton size="small" variant="quiet" :disabled="busy" @click="emit('close')">收起设置</UiButton>
    </div>
    <form class="newbi-form" @submit.prevent="emit('save', endpoint.trim())">
      <UiField label="本机 API 地址" for="newbi-endpoint">
        <input class="ui-control" v-model="endpoint" placeholder="http://127.0.0.1:5000/agent-api/v1" :disabled="busy"
          v-bind="{ id: 'newbi-endpoint', required: true }" />
      </UiField>
      <UiButton tone="primary" type="submit" :loading="busy">保存 Newbi 设置</UiButton>
    </form>
  </section>
</template>

<style scoped>
.newbi-form { max-width: 35rem; }
</style>
