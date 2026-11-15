<script setup lang="ts">
defineProps<{ label: string; for?: string; invalid?: boolean; feedback?: string }>()
</script>

<template>
  <div class="ui-field" :data-invalid="invalid || undefined">
    <label :for="$props.for">{{ label }}</label>
    <slot />
    <div v-if="$slots.feedback || feedback" class="ui-field-feedback"><slot name="feedback">{{ feedback }}</slot></div>
  </div>
</template>
