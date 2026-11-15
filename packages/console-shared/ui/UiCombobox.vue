<script setup lang="ts" generic="T extends string | null">
import { computed, onMounted, ref } from 'vue'
import {
  ComboboxAnchor, ComboboxCancel, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxPortal, ComboboxRoot,
  ComboboxTrigger, ComboboxViewport,
} from 'reka-ui'

type Option = { value: NonNullable<T>; label: string; disabled?: boolean }
const props = defineProps<{
  modelValue: T
  options: readonly Option[]
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
  inputAttrs?: Record<string, unknown>
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T]; blur: [event: FocusEvent] }>()
const host = ref<HTMLElement>()
const portalTarget = ref<HTMLElement>()
const selected = computed(() => props.options.find(({ value }) => value === props.modelValue))

onMounted(() => { portalTarget.value = host.value?.closest<HTMLElement>('[role="dialog"]') ?? undefined })

function choose(option: Option | null | undefined) {
  if (option && !option.disabled) emit('update:modelValue', option.value)
  else if (option === null && props.clearable) emit('update:modelValue', null as T)
}
</script>

<template>
  <div ref="host" class="ui-combobox">
    <ComboboxRoot :model-value="selected ?? null" :disabled="disabled" :reset-model-value-on-clear="clearable"
      by="value" open-on-click @update:model-value="choose">
      <ComboboxAnchor class="ui-combo-anchor">
        <ComboboxInput v-bind="inputAttrs" class="ui-control" :placeholder="placeholder" :disabled="disabled"
          :display-value="(option?: Option) => option?.label ?? ''" @blur="emit('blur', $event)" />
        <ComboboxCancel v-if="clearable && selected" class="ui-combo-action ui-combo-clear" type="button" tabindex="0"
          :aria-label="'清除选择 · ' + selected.label" :disabled="disabled">×</ComboboxCancel>
        <ComboboxTrigger class="ui-combo-action" type="button" aria-label="显示选项" :disabled="disabled">
          <span class="i-lucide-chevron-down" aria-hidden="true" />
        </ComboboxTrigger>
      </ComboboxAnchor>
      <ComboboxPortal :to="portalTarget">
        <ComboboxContent class="ui-combo-menu" position="popper" position-strategy="fixed" :side-offset="4" :collision-padding="12">
          <ComboboxViewport class="ui-combo-options">
            <ComboboxEmpty class="ui-combo-empty">没有匹配选项</ComboboxEmpty>
            <ComboboxItem v-for="option in options" :key="option.value" :value="option" :text-value="option.label"
              :disabled="option.disabled" :aria-disabled="option.disabled || undefined"
              class="ui-combo-option">{{ option.label }}</ComboboxItem>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>
  </div>
</template>
