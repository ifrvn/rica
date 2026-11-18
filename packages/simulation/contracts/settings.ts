import { z } from '@hono/zod-openapi'

const wallTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const settingsFields = z.strictObject({
  simulationDailyLimit: z.number().int().min(0).max(10_000),
  simulationCooldownMinutes: z.number().int().min(0).max(1_440),
  simulationQuietEnabled: z.boolean(),
  simulationQuietFrom: wallTime,
  simulationQuietUntil: wallTime,
  simulationQuietForChat: z.boolean(),
  simulationCatchUpMinutes: z.number().int().min(1).max(1_440),
  simulationProposalHours: z.number().int().min(1).max(168),
  simulationModelBudget: z.number().int().min(1_024).max(100_000_000).nullable(),
})
export const simulationSettingsInput = settingsFields.refine(
  (value) => value.simulationQuietFrom !== value.simulationQuietUntil,
  { path: ['simulationQuietUntil'] },
)
export const simulationSettingsView = z.strictObject({
  version: z.number().int().nonnegative(),
  timezone: z.string(),
  inheritedModelBudget: z.number().int().positive(),
  settings: simulationSettingsInput,
})
export type SimulationSettings = z.infer<typeof simulationSettingsInput>
export type SimulationSettingsView = z.infer<typeof simulationSettingsView>

export const defaultSimulationSettings: Readonly<SimulationSettings> = {
  simulationDailyLimit: 5,
  simulationCooldownMinutes: 60,
  simulationQuietEnabled: true,
  simulationQuietFrom: '22:00',
  simulationQuietUntil: '08:00',
  simulationQuietForChat: false,
  simulationCatchUpMinutes: 120,
  simulationProposalHours: 24,
  simulationModelBudget: null,
}
