import { runReplayView, simulationBacklogView } from '../contracts/simulation-observability.js'
import type { PrismaClient } from './generated/client.js'
import { authorize, ManagementError, type Scope } from './management.js'

export async function replaySimulationRun(db: PrismaClient, scope: Scope, runId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_replay_run_with_time(${scope.characterId}::uuid, ${runId}::uuid) AS view
    `
    if (!row?.view) throw new ManagementError(404, 'NOT_FOUND', 'Simulation run not found')
    return runReplayView.parse(row.view)
  }, { isolationLevel: 'RepeatableRead' })
}

export async function readSimulationBacklog(db: PrismaClient, scope: Scope) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN', 'AUDITOR'])
    const [row] = await tx.$queryRaw<{ view: unknown }[]>`
      SELECT public.rica_simulation_backlog(${scope.characterId}::uuid) AS view
    `
    return simulationBacklogView.parse(row?.view)
  }, { isolationLevel: 'RepeatableRead' })
}
