import { onBeforeUnmount, ref } from 'vue'
import { request, RequestError } from './request.js'

export type Page<T> = { items: T[]; nextCursor: string | null }
export const characterPath = (id: string) => '/v1/characters/' + encodeURIComponent(id)
export const utcToday = () => new Date().toISOString().slice(0, 10)
export const formatTime = (value: string) => new Date(value).toLocaleString()

export function queryPath(path: string, params: Record<string, string | null | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value)
  return query.size ? path + '?' + query : path
}

export async function readAll<T>(path: string, active: () => boolean) {
  const rows: T[] = []
  let cursor: string | null = null
  do {
    const page: Page<T> = await request(queryPath(path, { limit: '100', cursor }))
    rows.push(...page.items)
    cursor = page.nextCursor
  } while (cursor && active())
  return rows
}

export function useConsoleTask(expired: () => void) {
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  let mounted = true
  let pending: { signature: string; key: string } | undefined
  onBeforeUnmount(() => { mounted = false })

  async function run(task: () => Promise<void>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    notice.value = ''
    try { await task() }
    catch (cause) {
      if (!mounted) return
      if (!(cause instanceof RequestError)) {
        error.value = '请求失败，请重试。'
        return
      }
      if (cause.status === 401) { expired(); return }
      error.value = ({
        LAST_ADMIN: '角色必须保留至少一名管理员。',
        UNKNOWN_USER: '请先通过命令行创建该本地账号。',
      } as Record<string, string>)[cause.code ?? ''] ?? ({
        403: '当前账号无权执行此操作。',
        404: '当前角色中找不到该资源，或暂无记录。',
        409: '当前状态有冲突，请刷新后核对。',
        412: '记录已更新。请重新读取并核对后提交。',
        422: '请核对绑定、用途和字段取值。',
      } as Record<number, string>)[cause.status] ?? '请求失败，请重试。'
    } finally { busy.value = false }
  }

  async function command(path: string, payload: object, method = 'POST', version?: number) {
    const body = JSON.stringify(payload)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (version !== undefined) headers['If-Match'] = '"' + version + '"'
    else {
      const signature = JSON.stringify([path, body])
      if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
      headers['Idempotency-Key'] = pending.key
    }
    const result = await request<{ id: string }>(path, { method, body, headers })
    pending = undefined
    return result
  }

  return { busy, error, notice, active: () => mounted, run, command }
}
