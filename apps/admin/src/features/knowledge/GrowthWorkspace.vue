<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NEmpty, NFormItem, NSelect, NSpin } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { identityView } from '../../../../../packages/contracts/management.js'
import { characterPath, readAll, useConsoleTask } from '../../shared/console-data.js'
import IdentityGrowth from './IdentityGrowth.vue'

type Identity = z.infer<typeof identityView>
const props = defineProps<{ characterId: string; detailId?: string; canEdit: boolean }>()
const emit = defineEmits<{ expired: []; open: [id: string] }>()
const { busy, error, active, run } = useConsoleTask(() => emit('expired'))
const identities = ref<Identity[]>([])
const selected = computed(() => identities.value.find(({ id }) => id === props.detailId))
onMounted(() => {
  void run(async () => {
    const rows = await readAll<Identity>(characterPath(props.characterId) + '/identities', active)
    if (!active()) return
    identities.value = rows
    if (!props.detailId && rows[0]) emit('open', rows[0].id)
  })
})
</script>

<template>
  <section class="console-workspace console-stack" aria-label="身份成长记录">
    <div class="growth-identity-picker">
      <NFormItem label="身份" :label-props="{ for: 'growth-identity' }">
        <NSelect placeholder="搜索或选择身份" filterable :value="selected?.id ?? null" :disabled="busy"
          :options="identities.map(({ id, profile, slug }) => ({ value: id, label: profile?.displayName || slug }))"
          :input-props="{ id: 'growth-identity' }" @update:value="emit('open', $event)" />
      </NFormItem>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NSpin v-else-if="busy" />
      <NEmpty v-else-if="!identities.length" description="暂无身份。" />
      <NAlert v-else-if="detailId && !selected" type="warning">找不到当前角色中的身份。</NAlert>
    </div>
    <IdentityGrowth v-if="selected" :key="selected.id" :identity-id="selected.id" :character-id="characterId" :can-edit="canEdit"
      @expired="emit('expired')" />
  </section>
</template>

<style scoped>
.growth-identity-picker { max-width: 24rem; }
</style>
