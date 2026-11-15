<script setup lang="ts">
defineProps<{ description?: string }>()
</script>

<template>
  <div class="ui-empty">{{ description }}<slot /></div>
</template>
