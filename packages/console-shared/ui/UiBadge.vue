<script setup lang="ts">
defineProps<{ tone?: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info' }>()
</script>

<template>
  <span class="ui-badge" :data-tone="tone"><slot /></span>
</template>
