<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ReviewDesk from './ReviewDesk.vue'
import type { Readiness } from '../../packages/contracts/health.js'

const readiness = ref<Readiness>()
const checking = ref(false)

async function refresh() {
  checking.value = true
  try {
    const response = await fetch('/health/ready', { signal: AbortSignal.timeout(5000) })
    if (response.status !== 200 && response.status !== 503) throw new Error('Unexpected HTTP status')
    readiness.value = await response.json()
  } catch {
    readiness.value = undefined
  } finally {
    checking.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <main>
    <h1>虚拟角色管理台</h1>
    <details>
      <summary>服务状态</summary>
      <div aria-live="polite">
        <p v-if="checking">正在检查…</p>
        <dl v-else-if="readiness">
          <dt>PostgreSQL</dt>
          <dd>{{ readiness.checks.postgres ? '已连接' : '未连接' }}</dd>
          <dt>Redis</dt>
          <dd>{{ readiness.checks.redis ? '已连接' : '未连接' }}</dd>
        </dl>
        <p v-else>无法连接 API</p>
      </div>
      <button :disabled="checking" @click="refresh">刷新状态</button>
    </details>
    <ReviewDesk />
  </main>
</template>

<style>
body { margin: 0; font-family: system-ui, sans-serif; color: #192638; background: #f2f5f9; }
main { max-width: 58rem; margin: 2rem auto; padding: clamp(1rem, 4vw, 2rem); background: #fff; border: 1px solid #d9e0e8; border-radius: 1rem; }
h1 { margin-top: 0; }
dl { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
dd { margin: 0; }
button { padding: 0.5rem 0.9rem; font: inherit; cursor: pointer; }
</style>
