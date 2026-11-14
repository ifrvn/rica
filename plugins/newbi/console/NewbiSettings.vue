<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NForm, NFormItem, NInput } from 'naive-ui'
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
      <NButton size="small" quaternary :disabled="busy" @click="emit('close')">收起设置</NButton>
    </div>
    <NForm class="newbi-form" @submit.prevent="emit('save', endpoint.trim())">
      <NFormItem label="本机 API 地址" :label-props="{ for: 'newbi-endpoint' }">
        <NInput v-model:value="endpoint" placeholder="http://127.0.0.1:5000/agent-api/v1" :disabled="busy"
          :input-props="{ id: 'newbi-endpoint', required: true }" />
      </NFormItem>
      <NButton type="primary" attr-type="submit" :loading="busy">保存 Newbi 设置</NButton>
    </NForm>
  </section>
</template>

<style scoped>
.newbi-form { max-width: 35rem; }
</style>
