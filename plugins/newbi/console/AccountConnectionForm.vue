<script setup lang="ts">
import { NButton, NFormItem, NInput, NTag } from 'naive-ui'
import type { AccountPreview } from './accounts.js'
const credential = defineModel<string>('credential', { required: true })
defineProps<{ busy: boolean; preview?: AccountPreview }>()
const emit = defineEmits<{ test: [] }>()
</script>

<template>
  <NFormItem label="Agent Key" :label-props="{ for: 'workspace-newbi-key' }">
    <NInput v-model:value="credential" type="password" :disabled="busy"
      :input-props="{ id: 'workspace-newbi-key', autocomplete: 'new-password' }" />
  </NFormItem>
  <NButton attr-type="button" secondary :disabled="busy || !credential.trim()" @click="emit('test')">测试连接</NButton>
  <div v-if="preview" class="newbi-preview" role="status">
    <img v-if="preview.avatarUrl" :src="preview.avatarUrl" alt="" referrerpolicy="no-referrer" />
    <strong>{{ preview.username }}</strong>
    <NTag size="small" type="success">核验通过</NTag>
  </div>
</template>

<style scoped>
.newbi-preview { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-block: .75rem; }
.newbi-preview img { flex: none; width: 2.25rem; height: 2.25rem; border-radius: 50%; object-fit: cover; object-position: center; }
</style>
