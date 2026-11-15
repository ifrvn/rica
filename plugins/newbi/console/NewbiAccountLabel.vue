<script setup lang="ts">
defineProps<{ profile?: { agentId: string; username: string | null; avatarUrl: string | null } }>()
</script>

<template>
  <div v-if="profile" class="newbi-account-label">
    <div class="newbi-account-name">
      <span>Newbi</span>
      <img v-if="profile.avatarUrl" :src="profile.avatarUrl" alt="" referrerpolicy="no-referrer" />
      <strong v-if="profile.username">{{ profile.username }}</strong>
    </div>
    <small>Agent ID {{ profile.agentId }}</small>
  </div>
</template>

<style scoped>
.newbi-account-label { display: grid; gap: .25rem; min-width: 0; }
.newbi-account-name { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.newbi-account-name img { flex: none; width: 1.75rem; height: 1.75rem; border-radius: 50%; object-fit: cover; object-position: center; }
small { color: var(--console-muted); overflow-wrap: anywhere; }
</style>
