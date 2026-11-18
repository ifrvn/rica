import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import type { Page } from '@ricajs/console-shared/console-data'
import { request } from '@ricajs/console-shared/request'
import type { ActionView } from '../contracts/review.js'

type Decision = 'APPROVE' | 'REJECT'

export function useSimulationReview({ characterId, reviewStatus, busy, notice, revision, run }: {
  characterId: Ref<string>
  reviewStatus: Ref<string | undefined>
  busy: Ref<boolean>
  notice: Ref<string>
  revision: () => number
  run: (task: () => Promise<void>, scope?: number) => Promise<void>
}) {
  const reviewHistory = computed(() => ['HISTORY', 'APPROVE', 'REJECT'].includes(reviewStatus.value ?? ''))
  let reviewTimer: ReturnType<typeof setTimeout> | undefined
  onBeforeUnmount(() => clearTimeout(reviewTimer))

  const actions = ref<ActionView[]>([])
  const nextCursor = ref<string | null>(null)
  let queueLoaded = false
  const selected = ref<ActionView>()
  const reason = ref('')

  let pending: { signature: string; key: string } | undefined
  const path = computed(() => '/v1/characters/' + encodeURIComponent(characterId.value) + '/actions')

  function resetReview() {
    clearTimeout(reviewTimer)
    selected.value = undefined
    reason.value = ''
    pending = undefined
  }
  async function fetchQueue(current: number, append = false) {
    const query = new URLSearchParams()
    if (reviewHistory.value) query.set('status', reviewStatus.value!)
    if (append && nextCursor.value) query.set('cursor', nextCursor.value)
    const result = await request<Page<ActionView>>(path.value + (query.size ? '?' + query : ''))
    if (current !== revision()) return
    actions.value = append ? [...actions.value, ...result.items] : result.items
    nextCursor.value = result.nextCursor
    queueLoaded = true
  }

  async function loadQueue(append = false) {
    const current = revision()
    await run(async () => {
      await fetchQueue(current, append)
      const preview = selected.value
      if (current === revision() && !append && preview?.state === 'WAITING_APPROVAL'
        && !actions.value.some(({ id }) => id === preview.id)) selected.value = { ...preview, content: null }
    }, current)
  }
  async function fetchAction(id: string, current: number) {
    clearTimeout(reviewTimer)
    const action = await request<ActionView>(path.value + '/' + id)
    if (current !== revision()) return
    selected.value = action
    if (action.autoReviewPending) reviewTimer = setTimeout(() => {
      if (current === revision()) void run(async () => {
        await fetchAction(id, current)
        if (current === revision() && selected.value?.state !== 'WAITING_APPROVAL') await fetchQueue(current)
      }, current)
    }, 1500)
  }
  async function decide(decision: Decision) {
    const proposal = selected.value
    const note = reason.value.trim()
    if (busy.value || !proposal?.content || proposal.state !== 'WAITING_APPROVAL' || proposal.autoReviewPending) return
    const data = { decision, reviewDigest: proposal.reviewDigest, reason: note || undefined }
    const signature = JSON.stringify([proposal.id, proposal.version, data])
    if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
    const { key } = pending
    const current = revision()
    await run(async () => {
      const outcome = await request<{ status: 'READY' | 'REJECTED'; version: number }>(
        path.value + '/' + proposal.id + '/decisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'If-Match': '"run-v' + proposal.version + '"',
            'Idempotency-Key': key },
          body: JSON.stringify(data),
        },
      )
      if (current !== revision()) return
      actions.value = actions.value.filter(({ id }) => id !== proposal.id)
      selected.value = { ...proposal, content: null, state: outcome.status, version: outcome.version,
        review: { decision, at: new Date().toISOString(), reason: note || null } }
      reason.value = ''
      pending = undefined
      notice.value = outcome.status === 'READY' ? '已批准，等待模拟执行。' : '已拒绝模拟提案。'
    }, current)
  }

  function clearQueue() {
    actions.value = []
    nextCursor.value = null
    queueLoaded = false
  }

  function hideContent() {
    const action = selected.value
    if (action) selected.value = { ...action, content: null }
  }

  async function loadRoute(id: string | undefined, current: number) {
    if (!queueLoaded) await fetchQueue(current)
    if (current === revision() && id) await fetchAction(id, current)
  }

  return { actions, nextCursor, selected, reason, reviewHistory,
    loadQueue, loadRoute, fetchAction, decide, clearQueue, resetReview, hideContent }
}
