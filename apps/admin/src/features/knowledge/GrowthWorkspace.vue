<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NEmpty, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { identityView } from '../../../../../packages/contracts/management.js'
import { characterPath, readAll, useConsoleTask } from '@rica/console-shared/console-data'
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
  <div class="growth-layout" :class="{ 'growth-layout--selected': selected }">
    <section class="console-card console-stack" aria-labelledby="growth-identities-heading">
      <div class="console-section-heading"><h3 id="growth-identities-heading">身份列表</h3></div>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NSpin v-else-if="busy" aria-label="正在加载身份" />
      <NEmpty v-else-if="!identities.length" description="创建身份后，这里会显示成长记录。" />
      <NAlert v-else-if="detailId && !selected" type="warning">找不到当前角色中的身份。</NAlert>
      <ul v-if="identities.length" class="console-select-list growth-identities">
        <li v-for="identity in identities" :key="identity.id">
          <button class="console-record" type="button" :aria-current="selected?.id === identity.id ? 'true' : undefined"
            @click="emit('open', identity.id)">
            <strong>{{ identity.profile?.displayName || identity.slug }}</strong>
            <NTag size="small" :type="identity.status === 'ACTIVE' ? 'success' : 'default'" :bordered="false">
              {{ identity.status === 'ACTIVE' ? '已启用' : '已暂停' }}
            </NTag>
          </button>
        </li>
      </ul>
    </section>
    <IdentityGrowth v-if="selected" :key="selected.id" :identity-id="selected.id" :character-id="characterId" :can-edit="canEdit"
      :identity-name="selected.profile?.displayName || selected.slug" @expired="emit('expired')" />
  </div>
</template>

<style scoped>
.growth-layout { display: grid; gap: 1rem; align-items: start; min-width: 0; }
.growth-identities { margin: 0; }
.growth-identities .console-record { padding: .875rem .75rem; align-items: center; }
@media (min-width: 66rem) {
  .growth-layout--selected { grid-template-columns: minmax(14rem, 1fr) minmax(0, 2.25fr); }
}
</style>
