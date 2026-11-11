<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput } from 'naive-ui'
import type { ReconciliationView } from '../../../../../packages/contracts/action-review.js'
import { request, RequestError } from '../../shared/request.js'

const props = defineProps<{ characterId: string; actionId: string }>()
const emit = defineEmits<{ expired: []; resolved: [outcome: NonNullable<ReconciliationView['outcome']>] }>()
const path = '/v1/characters/' + encodeURIComponent(props.characterId)
  + '/actions/' + encodeURIComponent(props.actionId) + '/reconciliation'

const evidence = ref<ReconciliationView>()
const reason = ref('')
const busy = ref(false)
const error = ref('')
const stale = ref(false)
const canResolve = computed(() => evidence.value?.state === 'RECONCILING'
  && !!evidence.value.outcome && !!evidence.value.evidenceRef && !stale.value)
let pending: { signature: string; key: string } | undefined
let active = true
onBeforeUnmount(() => { active = false })

async function act(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await task()
  } catch (cause) {
    if (!active) return
    const status = cause instanceof RequestError ? cause.status : 0
    if (status === 401) {
      emit('expired')
      return
    }
    if ([403, 404, 409, 412].includes(status)) {
      evidence.value = undefined
      stale.value = true
    }
    error.value = ({
      403: '当前账号无权处置此运行。', 404: '找不到当前角色的对账记录。',
      409: '账本证据已变化，请重新核对。', 412: '运行版本已变化，请重新核对。',
      422: '请核对对账理由和账本证据。',
    } as Record<number, string>)[status] ?? '对账请求未完成，请重试。'
  } finally {
    busy.value = false
  }
}

function readEvidence() {
  void act(async () => {
    stale.value = true
    const latest = await request<ReconciliationView>(path)
    if (!active) return
    evidence.value = latest
    stale.value = false
  })
}

function resolve() {
  const current = evidence.value
  const note = reason.value.trim()
  if (!canResolve.value || !current?.outcome || !current.evidenceRef || !note) return
  const { outcome, evidenceRef, version } = current
  const body = JSON.stringify({ outcome, evidenceRef, reason: note })
  const signature = JSON.stringify([version, body])
  if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
  const key = pending.key
  void act(async () => {
    await request(path, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'If-Match': '"run-v' + version + '"', 'Idempotency-Key': key },
    })
    if (active) emit('resolved', outcome)
  })
}
</script>

<template>
  <section class="console-panel" aria-labelledby="reconciliation-heading">
      <div class="console-section-heading"><h3 id="reconciliation-heading">模拟对账</h3></div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NButton v-if="!canResolve" :loading="busy" :disabled="busy" @click="readEvidence">
      {{ stale || evidence ? '重新核对账本' : '核对账本' }}
    </NButton>
    <p v-if="evidence && evidence.state !== 'RECONCILING'">此运行已离开待对账状态，请刷新运行详情。</p>
    <p v-else-if="evidence && !canResolve && !stale">本地账本尚未封存证据，请稍后重新核对。</p>
    <NForm v-if="canResolve && evidence" @submit.prevent="resolve">
      <dl class="ledger">
        <div><dt>账本结论</dt><dd>{{ evidence.outcome === 'CONFIRMED' ? '确认已有模拟回执' : '确认未写入模拟回执' }}</dd></div>
        <div><dt>证据引用</dt><dd>{{ evidence.evidenceRef }}</dd></div>
      </dl>
      <p v-if="evidence.outcome === 'DEFINITELY_NOT_SENT'">结案后释放账号占用与预算，原提案进入「已拦截」。</p>
      <NFormItem label="对账理由" :label-props="{ for: 'reconciliation-reason' }">
        <NInput placeholder="例如：已核对封存账本，确认没有回执" v-model:value="reason" :input-props="{ id: 'reconciliation-reason' }" :maxlength="240" :disabled="busy" />
      </NFormItem>
      <div class="ledger-actions">
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !reason.trim()">提交对账结论</NButton>
        <NButton :disabled="busy" @click="readEvidence">重新核对账本</NButton>
      </div>
    </NForm>
  </section>
</template>

<style scoped>
.ledger { display: grid; gap: .5rem; }
.ledger > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .5rem; }
.ledger dd { margin: 0; overflow-wrap: anywhere; }
.ledger-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
</style>
