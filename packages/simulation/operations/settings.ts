import { authorize, ManagementError, type Scope } from '@ricajs/persistence/management'
import type { Prisma, PrismaClient } from '@ricajs/persistence/prisma'
import { coreProfile } from '@ricajs/contracts/management'
import { simulationSettingsView, type SimulationSettings } from '../contracts/settings.js'

export async function readSimulationSettings(db: PrismaClient, scope: Scope) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope)
    const { simulationLimitsVersion: version, timezone, activeCore, ...settings } = await tx.character.findUniqueOrThrow({
      where: { id: scope.characterId },
      select: {
        simulationLimitsVersion: true, timezone: true, activeCore: { select: { hardProfile: true } },
        simulationDailyLimit: true, simulationCooldownMinutes: true, simulationQuietEnabled: true,
        simulationQuietFrom: true, simulationQuietUntil: true, simulationQuietForChat: true,
        simulationCatchUpMinutes: true, simulationProposalHours: true, simulationModelBudget: true,
      },
    })
    const inheritedModelBudget = coreProfile.shape.dailyModelBudget.safeParse(
      (activeCore?.hardProfile as { dailyModelBudget?: unknown } | null)?.dailyModelBudget,
    ).data ?? 10_000_000
    return simulationSettingsView.parse({ version, timezone, inheritedModelBudget, settings })
  }, { isolationLevel: 'RepeatableRead' })
}

export async function saveSimulationSettings(
  tx: Prisma.TransactionClient, characterId: string, expected: number, input: SimulationSettings,
) {
  const current = await tx.character.findUniqueOrThrow({
    where: { id: characterId },
    select: { simulationLimitsVersion: true, simulationQuietEnabled: true, simulationQuietFrom: true, simulationQuietUntil: true },
  })
  if (current.simulationLimitsVersion !== expected) {
    throw new ManagementError(412, 'STALE_VERSION', 'Simulation settings changed')
  }
  if (current.simulationQuietEnabled !== input.simulationQuietEnabled
    || current.simulationQuietFrom !== input.simulationQuietFrom || current.simulationQuietUntil !== input.simulationQuietUntil) {
    // Wake already deferred reminders so they can recompute their next eligible time.
    await tx.$executeRaw`
      UPDATE public.simulation_schedules SET next_at = statement_timestamp()
      WHERE character_id = ${characterId}::uuid AND kind = 'REMINDER' AND enabled
        AND due_at <= statement_timestamp() AND next_at > statement_timestamp() AND next_at > due_at
    `
  }
  return tx.character.update({
    where: { id: characterId },
    data: { ...input, simulationLimitsVersion: { increment: 1 } },
    select: { id: true, simulationLimitsVersion: true },
  })
}
