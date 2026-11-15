<script setup lang="ts">
import type { ConsolePage } from './console-location.js'

defineProps<{ hasCharacter: boolean; mainPage: ConsolePage; disabled: boolean }>()
const emit = defineEmits<{ select: [page: ConsolePage] }>()
</script>

<template>
  <nav class="console-navigation" aria-label="控制台导航">
    <button v-if="hasCharacter" type="button" :aria-current="mainPage === 'home' ? 'page' : undefined" :disabled="disabled"
      @click="emit('select', 'home')"><span class="i-lucide-layout-dashboard" aria-hidden="true" />工作台</button>
    <button v-if="hasCharacter" type="button" :aria-current="mainPage === 'review' ? 'page' : undefined" :disabled="disabled"
      @click="emit('select', 'review')"><span class="i-lucide-clipboard-check" aria-hidden="true" />审批</button>
    <button v-if="hasCharacter" type="button" :aria-current="mainPage === 'runs' ? 'page' : undefined" :disabled="disabled"
      @click="emit('select', 'runs')"><span class="i-lucide-activity" aria-hidden="true" />运行记录</button>
    <span class="console-nav-label">角色管理</span>
    <button type="button" :aria-current="mainPage === 'character' ? 'page' : undefined" :disabled="disabled"
      @click="emit('select', 'character')"><span class="i-lucide-users" aria-hidden="true" />角色与身份</button>
    <template v-if="hasCharacter">
      <button type="button" :aria-current="mainPage === 'accounts' ? 'page' : undefined" :disabled="disabled"
        @click="emit('select', 'accounts')"><span class="i-lucide-contact" aria-hidden="true" />平台账号池</button>
      <button type="button" :aria-current="mainPage === 'knowledge' ? 'page' : undefined" :disabled="disabled"
        @click="emit('select', 'knowledge')"><span class="i-lucide-book-open" aria-hidden="true" />记忆与身份成长</button>
      <button type="button" :aria-current="mainPage === 'planning' ? 'page' : undefined" :disabled="disabled"
        @click="emit('select', 'planning')"><span class="i-lucide-calendar-days" aria-hidden="true" />计划与承诺</button>
      <button type="button" :aria-current="mainPage === 'audit' ? 'page' : undefined" :disabled="disabled"
        @click="emit('select', 'members')"><span class="i-lucide-history" aria-hidden="true" />成员与审计</button>
      <span class="console-nav-label">部署管理</span>
      <button type="button" :aria-current="mainPage === 'plugins' ? 'page' : undefined" :disabled="disabled"
        @click="emit('select', 'plugins')"><span class="i-lucide-puzzle" aria-hidden="true" />插件中心</button>
      <button type="button" :aria-current="mainPage === 'health' ? 'page' : undefined" :disabled="disabled"
        @click="emit('select', 'health')"><span class="i-lucide-server" aria-hidden="true" />系统运行状况</button>
    </template>
  </nav>
</template>

<style scoped>
.console-navigation { display: flex; flex-direction: column; gap: .1875rem; padding: 1rem .625rem; min-width: 0;
  border-inline-end: 1px solid var(--console-line); background: var(--console-nav); }
.console-navigation button { display: flex; align-items: center; gap: .5rem; border: 0; border-radius: 3px; background: transparent;
  min-height: 2.25rem; padding: .4375rem .625rem; font: inherit; font-size: .8125rem;
  text-align: start; color: var(--console-muted); white-space: nowrap; cursor: pointer; }
.console-navigation button > span { flex: none; }
.console-navigation button:enabled:hover { background: var(--console-hover); }
.console-navigation button[aria-current] { color: var(--console-accent-text); background: var(--console-selected); font-weight: 650; }
.console-nav-label { color: var(--console-muted); padding: .625rem .625rem .125rem; font-size: .75rem; }
.console-navigation button:disabled { opacity: .65; cursor: default; }
.console-navigation button:focus-visible { outline-offset: -2px; }
@media (pointer: coarse) {
  .console-navigation button { min-height: 2.75rem; }
}
</style>
