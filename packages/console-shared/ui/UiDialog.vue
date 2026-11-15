<script setup lang="ts">
import { watch } from 'vue'
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ open: boolean; title: string; busy?: boolean; dismissOutside?: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean]; closed: [] }>()
let trigger: HTMLElement | undefined

watch(() => props.open, (open) => {
  if (open) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
}, { flush: 'sync', immediate: true })

function restoreFocus(event: Event) {
  event.preventDefault()
  if (trigger?.isConnected && !trigger.matches(':disabled')) trigger.focus()
  emit('closed')
  trigger = undefined
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay" />
      <div v-if="open" class="ui-dialog-layer">
        <DialogContent v-bind="$attrs" class="ui-dialog" :aria-describedby="undefined"
          @escape-key-down="event => { if (busy) event.preventDefault() }"
          @pointer-down-outside="event => { if (busy || !dismissOutside) event.preventDefault() }"
          @close-auto-focus="restoreFocus">
          <div class="ui-dialog-heading">
            <DialogTitle>{{ title }}</DialogTitle>
            <DialogClose v-if="!busy" class="ui-button" data-variant="quiet" aria-label="关闭" type="button">
              <span class="i-lucide-x" aria-hidden="true" />
            </DialogClose>
          </div>
          <slot />
        </DialogContent>
      </div>
    </DialogPortal>
  </DialogRoot>
</template>
