import type { z } from '@hono/zod-openapi'
import type { reconciliationInput, ReconciliationView } from '../contracts/action-review.js'
import { authorize, ManagementError, type Scope } from './management.js'
import type { Prisma, PrismaClient } from './generated/client.js'

async function evidence(tx: Prisma.TransactionClient, characterId: string, actionId: string) {
  const [view] = await tx.$queryRaw<ReconciliationView[]>`
    SELECT * FROM public.rica_simulation_reconciliation(${characterId}::uuid, ${actionId}::uuid)
  `
  if (!view) throw new ManagementError(404, 'NOT_FOUND', 'Simulation attempt not found')
  return view
}

export async function readSimulationReconciliation(db: PrismaClient, scope: Scope, actionId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN'])
    return evidence(tx, scope.characterId, actionId)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function resolveSimulationReconciliation(
  tx: Prisma.TransactionClient, scope: Scope, actionId: string, version: number,
  input: z.infer<typeof reconciliationInput>,
) {
  const current = await evidence(tx, scope.characterId, actionId)
  if (current.version !== version) throw new ManagementError(412, 'STALE_VERSION', 'Simulation version has changed')
  const [result] = await tx.$queryRaw<{ state: string; version: number }[]>`
    SELECT * FROM public.rica_resolve_simulation(
      ${scope.characterId}::uuid, ${actionId}::uuid, ${version}::int, ${input.outcome},
      ${input.evidenceRef}, ${scope.actor.id}, ${input.reason}
    )
  `
  if (!result) throw new ManagementError(409, 'RECONCILIATION_CONFLICT', 'The local ledger does not support this resolution')
  return { id: actionId, status: result.state, version: result.version }
}
