<script setup lang="ts">
import { computed } from 'vue'
import { NSelect } from 'naive-ui'

const value = defineModel<string>('value', { required: true })
const props = defineProps<{ id: string; inherited?: string; invalid?: boolean; disabled?: boolean }>()
const cities: Record<string, string> = {
  'Asia/Hong_Kong': '香港', 'Asia/Shanghai': '上海', 'Asia/Taipei': '台北', 'Asia/Tokyo': '东京',
  'Asia/Singapore': '新加坡', 'America/New_York': '纽约', 'America/Los_Angeles': '洛杉矶',
  'Europe/London': '伦敦', 'Europe/Paris': '巴黎', 'UTC': '协调世界时',
}
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const zones = new Set(['UTC', browserZone, ...Object.keys(cities), ...(Intl.supportedValuesOf?.('timeZone') ?? [])])
const options = computed(() => [
  ...(props.inherited ? [{ value: '', label: '跟随角色时区 · ' + props.inherited }] : []),
  ...[...new Set([...zones, ...(value.value ? [value.value] : [])])].map((zone) => ({
    value: zone, label: cities[zone] ? cities[zone] + ' · ' + zone : zone.replaceAll('_', ' '),
  })),
])
</script>

<template>
  <NSelect v-model:value="value" filterable :disabled="disabled" :options="options" placeholder="选择时区"
    :filter="(query, option) => [option.label, option.value].some(text => String(text).toLowerCase().includes(query.toLowerCase()))"
    :input-props="{ id, 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? id + '-error' : undefined }" />
</template>
