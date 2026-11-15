<script setup lang="ts">
defineProps<{ tone?: 'default' | 'success' | 'warning' | 'error' | 'info'; title?: string }>()
</script>

<template>
  <div class="ui-alert" :data-tone="tone" :role="tone === 'error' ? 'alert' : undefined">
    <strong v-if="title">{{ title }}</strong>
    <slot />
  </div>
</template>
