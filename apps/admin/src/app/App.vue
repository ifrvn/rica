<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { darkTheme, NButton, NConfigProvider, NGlobalStyle, NTag, zhCN, type GlobalThemeOverrides } from 'naive-ui'
import {
  DropdownMenuContent, DropdownMenuItemIndicator, DropdownMenuPortal, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuTrigger,
  PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger,
} from 'reka-ui'
import ReviewDesk from './ReviewDesk.vue'
import type { Readiness } from '../../../../packages/contracts/health.js'
import { palettes, readAppearance, saveAppearance } from './appearance.js'
import '../styles/console-theme.css'

const appearance = ref(readAppearance())
const systemPreference = window.matchMedia('(prefers-color-scheme: dark)')
const systemMode = ref<'light' | 'dark'>(systemPreference.matches ? 'dark' : 'light')
const effectiveMode = computed(() => appearance.value.mode === 'system' ? systemMode.value : appearance.value.mode)
const nextMode = computed(() => {
  if (appearance.value.mode === 'system') return systemMode.value === 'dark' ? 'light' : 'dark'
  return appearance.value.mode === systemMode.value ? 'system' : systemMode.value
})
const modes = {
  system: { label: '跟随系统', icon: 'i-lucide-monitor' },
  light: { label: '浅色', icon: 'i-lucide-sun' },
  dark: { label: '深色', icon: 'i-lucide-moon' },
} as const
const modeLabel = computed(() => '外观：' + modes[appearance.value.mode].label + '，点击切换至' + modes[nextMode.value].label)

function updateSystemMode(event: MediaQueryListEvent) {
  systemMode.value = event.matches ? 'dark' : 'light'
}

const theme = computed<GlobalThemeOverrides>(() => {
  const [primary, hover] = palettes[appearance.value.palette][effectiveMode.value]
  return {
    common: {
      primaryColor: primary, primaryColorHover: hover, primaryColorPressed: hover, primaryColorSuppl: hover,
      textColorBase: 'var(--console-text)', bodyColor: 'var(--console-page)', cardColor: 'var(--console-surface)',
      popoverColor: 'var(--console-surface)', borderRadius: '5px',
    },
    Card: { borderRadius: '5px', borderColor: 'var(--console-line)' },
  }
})

watchEffect(() => {
  document.documentElement.dataset.consolePalette = appearance.value.palette
  document.documentElement.dataset.consoleMode = effectiveMode.value
  saveAppearance(appearance.value)
})

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

onMounted(() => {
  systemPreference.addEventListener('change', updateSystemMode)
  void refresh()
})
onBeforeUnmount(() => systemPreference.removeEventListener('change', updateSystemMode))
</script>

<template>
  <NConfigProvider :locale="zhCN" :theme="effectiveMode === 'dark' ? darkTheme : null" :theme-overrides="theme">
    <NGlobalStyle />
    <div class="admin-shell">
      <header class="masthead">
        <div class="masthead-inner">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">R</span>
            <h1>Rica 控制台</h1>
          </div>
          <div id="masthead-role" />
          <div class="masthead-actions" flex="~ wrap" items="center" gap="2">
            <DropdownMenuRoot>
              <DropdownMenuTrigger type="button" class="appearance-icon"
                :aria-label="'切换主题，当前为' + palettes[appearance.palette].label" title="切换主题">
                <span class="i-lucide-palette" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="theme-menu" align="end" :side-offset="8" :collision-padding="12" aria-label="主题颜色">
                  <DropdownMenuRadioGroup :model-value="appearance.palette">
                    <DropdownMenuRadioItem v-for="(palette, key) in palettes" :key="key" :value="key" class="theme-option"
                      :style="{ color: palette.text[effectiveMode] }" @select="appearance.palette = key">
                      <span class="theme-swatch" :style="{ backgroundColor: palette.light[0] }" aria-hidden="true" />
                      <span>{{ palette.label }}</span>
                      <DropdownMenuItemIndicator class="i-lucide-check theme-indicator" aria-hidden="true" />
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
            <button type="button" class="appearance-icon" :aria-label="modeLabel" :title="modeLabel" @click="appearance.mode = nextMode">
              <span :class="modes[appearance.mode].icon" aria-hidden="true" />
            </button>
            <PopoverRoot>
              <PopoverTrigger class="service-trigger" type="button" aria-label="服务状态">
                <span class="service-dot" :data-tone="serviceStatus.tone" aria-hidden="true" />
                <span aria-live="polite">{{ serviceStatus.label }}</span>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent class="service-panel" align="end" :side-offset="8" :collision-padding="12" aria-label="服务状态详情">
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
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
            <div id="masthead-account" />
          </div>
        </div>
      </header>
      <main class="admin-content">
        <ReviewDesk />
      </main>
    </div>
  </NConfigProvider>
</template>

<style src="../styles/console-layout.css"></style>

<style>
body { margin: 0; }
.admin-shell { min-height: 100vh; background: var(--console-page); color: var(--console-text); }
.masthead { background: var(--console-surface); border-bottom: 1px solid var(--console-line); }
.masthead-inner { display: flex; flex-wrap: wrap; padding: .75rem clamp(1rem, 4vw, 2.5rem); min-height: 3.75rem; box-sizing: border-box; align-items: center; justify-content: space-between; gap: .75rem; }
.brand { display: flex; align-items: center; gap: .75rem; }
.brand h1 { margin: 0; font-size: 1rem; font-weight: 650; }
.brand-mark { color: var(--console-accent-text); font-size: 1.5rem; font-weight: 760; line-height: 1; }
.masthead-actions { margin-inline-start: auto; min-width: 0; }
#masthead-role:empty, #masthead-account:empty { display: none; }
.appearance-icon, .service-trigger {
  font: inherit; color: var(--console-text); background: var(--console-surface); border: 1px solid var(--console-field);
  border-radius: 5px; min-height: 2rem; padding-inline: .5rem;
}
.appearance-icon { display: grid; place-items: center; width: 2rem; padding: 0; border-color: transparent; cursor: pointer; font-size: 1rem; }
.appearance-icon:hover, .appearance-icon[data-state='open'] { background: var(--console-hover); }
.service-trigger { display: inline-flex; align-items: center; border-color: var(--console-line); cursor: pointer; }
.service-trigger:hover { background: var(--console-hover); }
.service-dot { width: .42rem; aspect-ratio: 1; border-radius: 50%; margin-inline-end: .45rem; background: #82908f; }
.service-dot[data-tone='success'] { background: var(--console-good); }
.service-dot[data-tone='warning'] { background: #ad710c; }
.service-dot[data-tone='error'] { background: #bd454c; }
.service-panel, .theme-menu { z-index: 20;
  background: var(--console-surface); color: var(--console-text); border: 1px solid var(--console-line);
  border-radius: 6px; box-shadow: 0 .5rem 1.5rem #0002; }
.service-panel { min-width: 11.5rem; display: grid; gap: .75rem; padding: .875rem; }
.theme-menu { min-width: 9.25rem; padding: .25rem; }
.theme-option { display: grid; grid-template-columns: .875rem 1fr 1rem; align-items: center; gap: .625rem;
  min-height: 2.25rem; padding: .25rem .5rem; border-radius: 4px; cursor: pointer; font-size: .875rem; }
.theme-option[data-highlighted] { background: var(--console-hover); outline: none; }
.theme-swatch { width: .875rem; height: .875rem; border-radius: 3px; }
.theme-indicator { justify-self: end; }
.service-panel p, .service-checks, .service-checks dd { margin: 0; }
.service-checks { display: grid; gap: .5rem; }
.service-checks div { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.service-panel > .n-button { justify-self: end; }
@media (min-width: 44rem) and (max-width: 56rem) {
  .masthead-inner { padding-inline: 1rem; gap: .5rem; }
}
@media (max-width: 42rem) {
  .masthead-inner { gap: .5rem; }
  .brand { gap: .5rem; }
  .brand h1 { font-size: .925rem; }
}
@media (pointer: coarse) {
  .appearance-icon { width: 2.75rem; min-height: 2.75rem; }
  .theme-option { min-height: 2.75rem; }
}
</style>
