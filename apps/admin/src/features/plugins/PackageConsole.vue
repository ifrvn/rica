<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { pluginConsoleEntry, type PluginConsoleEntry } from '@ricajs/contracts/plugin-console'
import { characterPath, useConsoleTask } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import { UiAlert, UiButton, UiSpinner } from '@ricajs/console-shared/ui'
import PackageConsoleCard from './PackageConsoleCard.vue'

const props = defineProps<{ characterId: string }>()
const emit = defineEmits<{ expired: [] }>()
const entries = ref<PluginConsoleEntry[]>([])
const { active, busy, error, run } = useConsoleTask(() => emit('expired'))
const load = () => run(async () => {
  const result = pluginConsoleEntry.array().parse(await request(characterPath(props.characterId) + '/package-console'))
  if (active()) entries.value = result
})
onMounted(load)
</script>

<template>
  <UiAlert v-if="error" tone="error" role="alert">
    无法读取扩展插件。<UiButton size="small" @click="load">重试</UiButton>
  </UiAlert>
  <UiSpinner v-if="busy" aria-label="正在读取扩展插件" />
  <PackageConsoleCard v-for="entry in entries" :key="entry.id" :entry="entry" :character-id="characterId" @expired="emit('expired')" />
</template>
