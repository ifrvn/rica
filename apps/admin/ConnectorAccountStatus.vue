
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import type { z } from '@hono/zod-openapi'
import type { newbiInboxView } from '../../packages/contracts/newbi-pilot.js'
import { request, RequestError } from './request.js'

type Inbox = z.infer<typeof newbiInboxView>
const props = defineProps<{ characterId: string; accountId: string; accountStatus: string; canReview: boolean }>()
const emit = defineEmits<{ expired: []; proposals: [] }>()
const inbox = ref<Inbox>()
const busy = ref(false)
const error = ref('')
let active = true

const kinds = { POST_REPLIED: '帖子收到回复', COMMENT_REPLIED: '评论收到回复', AGENT_MENTIONED: '被提及' }
const format = (value: string) => new Date(value).toLocaleString()

async function load() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await request<Inbox>('/v1/characters/' + encodeURIComponent(props.characterId)
      + '/newbi/accounts/' + encodeURIComponent(props.accountId) + '/events')
    if (active) inbox.value = result
  } catch (cause) {
    if (!active) return
    inbox.value = undefined
    if (cause instanceof RequestError && cause.status === 401) emit('expired')
    else error.value = '无法读取当前账号的状态，请刷新后重试。'
  } finally {
    busy.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => { active = false })
</script>

<template>
  <section class="console-panel" aria-labelledby="connector-read-heading">
    <div class="console-section-heading">
      <h3 id="connector-read-heading">连接器读取状态</h3>
      <NButton size="small" quaternary :disabled="busy" @click="load">刷新读取状态</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin v-else-if="busy && !inbox" />
    <template v-if="inbox">
      <div class="connector-actions">
        <NTag size="small" :type="inbox.readError ? 'warning' : 'default'">
          {{ accountStatus === 'ACTIVE' ? inbox.readError ? '最近读取失败'
            : inbox.lastSucceededAt ? '最近读取成功' : '尚未读取' : '当前绑定未启用' }}
        </NTag>
        <NButton v-if="canReview" size="small" @click="emit('proposals')">查看此账号的提案与回执</NButton>
      </div>
      <dl>
        <div><dt>Agent ID</dt><dd>{{ inbox.agentId }}</dd></div>
        <div><dt>最近成功读取</dt><dd>{{ inbox.lastSucceededAt ? format(inbox.lastSucceededAt) : '无记录' }}</dd></div>
        <div v-if="inbox.readError"><dt>最近错误码</dt><dd><code>{{ inbox.readError }}</code></dd></div>
        <div v-if="accountStatus === 'ACTIVE' && inbox.nextPollAt"><dt>允许下次读取</dt><dd>{{ format(inbox.nextPollAt) }}</dd></div>
      </dl>
      <NAlert v-if="inbox.historyLostCount" type="warning" role="status">
        事件游标已重置 {{ inbox.historyLostCount }} 次。{{ inbox.lastHistoryLostAt ? '最近一次 ' + format(inbox.lastHistoryLostAt) : '' }}
      </NAlert>
      <NEmpty v-if="inbox.items?.length === 0" description="暂无已读取事件。" />
      <ul v-if="inbox.items?.length" class="connector-events" aria-label="最近读取事件">
        <li v-for="event in inbox.items" :key="event.seq">
          <strong>{{ kinds[event.type] }}</strong>
          <time :datetime="event.occurredAt">{{ format(event.occurredAt) }}</time>
          <span>帖子 {{ event.postId }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.connector-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
dl { display: grid; gap: .4rem; }
dl > div { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: .5rem; }
dd { margin: 0; overflow-wrap: anywhere; }
.connector-events { list-style: none; margin: .5rem 0 0; padding: 0; }
.connector-events li { display: flex; flex-wrap: wrap; gap: .5rem; padding: .5rem 0; border-top: 1px solid #e0e8e7; overflow-wrap: anywhere; }
</style>
