import type { z } from '@hono/zod-openapi'
import type { newbiAccountCheckView, newbiAccountPreview, newbiAccountTest } from '../../management/contracts.js'
import { request } from '@ricajs/console-shared/request'

export type AccountPreview = z.infer<typeof newbiAccountPreview>

export const checkAccount = (base: string, id: string) =>
  request<z.infer<typeof newbiAccountCheckView>>(base + '/newbi/accounts/' + encodeURIComponent(id) + '/check', { method: 'POST' })

export const testAccount = (base: string, input: z.infer<typeof newbiAccountTest>) =>
  request<AccountPreview>(base + '/account-pool/newbi/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
