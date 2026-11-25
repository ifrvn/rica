<script setup lang="ts">
import { UiButton, UiField, UiBadge } from '@ricajs/console-shared/ui'
import type { AccountPreview } from './accounts.js'
const credential = defineModel<string>('credential', { required: true })
defineProps<{ busy: boolean; preview?: AccountPreview }>()
const emit = defineEmits<{ test: [] }>()
</script>

<template>
  <UiField label="Agent Key" for="workspace-newbi-key">
    <input class="ui-control" v-model="credential" type="password" :disabled="busy"
      v-bind="{ id: 'workspace-newbi-key', autocomplete: 'new-password' }" />
  </UiField>
  <UiButton type="button" variant="soft" :disabled="busy || !credential.trim()" @click="emit('test')">测试连接</UiButton>
  <div v-if="preview" class="newbi-preview" role="status">
    <img v-if="preview.avatarUrl" :src="preview.avatarUrl" alt="" referrerpolicy="no-referrer" />
    <strong>{{ preview.username }}</strong>
    <UiBadge tone="success">核验通过</UiBadge>
  </div>
</template>

<style scoped>
.newbi-preview { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-block: .75rem; }
.newbi-preview img { flex: none; width: 2.25rem; height: 2.25rem; border-radius: 50%; object-fit: cover; object-position: center; }
</style>
