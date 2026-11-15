<script setup lang="ts">
const checked = defineModel<boolean>({ required: true })
defineProps<{ disabled?: boolean }>()
</script>

<template>
  <label class="ui-checkbox"><input v-model="checked" type="checkbox" :disabled="disabled" /><span><slot /></span></label>
</template>
