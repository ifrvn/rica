import type { z } from '@hono/zod-openapi'
import type { membershipInput } from './management.js'

type ManagementRole = z.infer<typeof membershipInput>['role']

export function hasManagementRole(assigned: readonly ManagementRole[], required: readonly ManagementRole[]) {
  return assigned.includes('ADMIN') || required.some((role) => assigned.includes(role))
}
