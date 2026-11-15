import { z } from '@hono/zod-openapi'

export const usernameInput = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u)
export const passwordInput = z.string().min(12).max(128)
export const localUserPassword = z.strictObject({ password: passwordInput, currentPassword: passwordInput })
export const localUserCreate = localUserPassword.extend({ username: usernameInput })
export type LocalUser = { username: string; canCreate: boolean }
