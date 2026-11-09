<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NConfigProvider, NGlobalStyle, NPopover, NTag, zhCN, type GlobalThemeOverrides } from 'naive-ui'
import ReviewDesk from './ReviewDesk.vue'
import type { Readiness } from '../../packages/contracts/health.js'

const theme: GlobalThemeOverrides = {
  common: {
    primaryColor: '#17675d',
    primaryColorHover: '#237d70',
    primaryColorPressed: '#12534c',
    primaryColorSuppl: '#237d70',
    textColorBase: '#182627',
    borderRadius: '8px',
  },
  Card: { borderRadius: '12px', borderColor: '#dfe7e6' },
  Tag: { textColorWarning: '#80510b', colorWarning: '#fbefd7' },
}

const readiness = ref<Readiness>()
const checking = ref(false)
const serviceStatus = computed(() => {
  if (checking.value) return { label: '正在检查', tone: 'default' } as const
  if (!readiness.value) return { label: '无法连接 API', tone: 'error' } as const
  return readiness.value.status === 'ready'
    ? { label: '服务正常', tone: 'success' } as const
    : { label: '服务未就绪', tone: 'warning' } as const
})

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
  <NConfigProvider :locale="zhCN" :theme-overrides="theme">
    <NGlobalStyle />
    <div class="admin-shell">
      <header class="masthead">
        <div class="masthead-inner">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">R</span>
            <h1>Rica 控制台</h1>
          </div>
          <NPopover trigger="click" placement="bottom-end">
            <template #trigger>
              <NButton secondary size="small" aria-label="服务状态">
                <span class="service-dot" :data-tone="serviceStatus.tone" aria-hidden="true" />
                <span aria-live="polite">{{ serviceStatus.label }}</span>
              </NButton>
            </template>
            <div class="service-panel">
              <dl v-if="readiness" class="service-checks">
                <div>
                  <dt>PostgreSQL</dt>
                  <dd><NTag size="small" :bordered="false" :type="readiness.checks.postgres ? 'success' : 'error'">{{ readiness.checks.postgres ? '已连接' : '未连接' }}</NTag></dd>
                </div>
                <div>
                  <dt>Redis</dt>
                  <dd><NTag size="small" :bordered="false" :type="readiness.checks.redis ? 'success' : 'error'">{{ readiness.checks.redis ? '已连接' : '未连接' }}</NTag></dd>
                </div>
              </dl>
              <p v-else aria-live="polite">{{ serviceStatus.label }}</p>
              <NButton size="small" :loading="checking" @click="refresh">刷新状态</NButton>
            </div>
          </NPopover>
        </div>
      </header>
      <main class="admin-content">
        <ReviewDesk />
      </main>
    </div>
  </NConfigProvider>
</template>

<style>
body { margin: 0; }
.admin-shell { min-height: 100vh; background: #f4f7f7; }
.masthead { background: #fff; border-bottom: 1px solid #e0e8e7; }
.masthead-inner, .admin-content { width: min(72rem, 100% - 3rem); margin-inline: auto; }
.masthead-inner { display: flex; min-height: 4.25rem; align-items: center; justify-content: space-between; gap: 1rem; }
.brand { display: flex; align-items: center; gap: .75rem; }
.brand h1 { margin: 0; font-size: 1rem; font-weight: 650; }
.brand-mark { display: grid; width: 2.125rem; aspect-ratio: 1; place-items: center; border-radius: .625rem;
  background: #17675d; color: #fff; font-size: 1.1rem; font-weight: 700; }
.service-dot { width: .42rem; aspect-ratio: 1; border-radius: 50%; margin-inline-end: .45rem; background: #82908f; }
.service-dot[data-tone='success'] { background: #247765; }
.service-dot[data-tone='warning'] { background: #ad710c; }
.service-dot[data-tone='error'] { background: #bd454c; }
.service-panel { min-width: 11.5rem; display: grid; gap: .75rem; }
.service-panel p, .service-checks, .service-checks dd { margin: 0; }
.service-checks { display: grid; gap: .5rem; }
.service-checks div { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.service-panel > .n-button { justify-self: end; }
.admin-content { padding-block: 2rem 3rem; }
@media (max-width: 42rem) {
  .masthead-inner, .admin-content { width: calc(100% - 2rem); }
  .masthead-inner { gap: .5rem; }
  .brand { gap: .5rem; }
  .brand h1 { font-size: .925rem; }
  .admin-content { padding-block: 1.25rem 2rem; }
}
</style>
