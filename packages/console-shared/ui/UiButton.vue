<script setup lang="ts">
withDefaults(defineProps<{
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'
  variant?: 'solid' | 'soft' | 'quiet' | 'text'
  size?: 'small' | 'tiny'
  type?: 'button' | 'submit' | 'reset'
  block?: boolean
  disabled?: boolean
  loading?: boolean
}>(), { type: 'button', tone: 'default', variant: 'solid' })
</script>

<template>
  <button class="ui-button" :type="type" :data-tone="tone" :data-variant="variant" :data-size="size"
    :data-block="block || undefined" :disabled="disabled || loading" :aria-busy="loading || undefined">
    <span v-if="loading" class="ui-progress" aria-hidden="true" />
    <slot />
  </button>
</template>
