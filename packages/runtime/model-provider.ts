import type { RunContinuity, RunTime } from '../persistence/run-continuity.js'

export const maxSimulatedTextLength = 4_000

export type ModelEvidence = Readonly<{ id: string; revision: number; content: string }>

type ModelInput = Readonly<{
  text: string
  evidence: readonly ModelEvidence[]
}>

export type WritingStyle = 'neutral' | 'formal' | 'casual' | 'concise'

export type ModelProvider = Readonly<{
  decide(input: ModelInput & Readonly<{ context: RunContinuity }>, signal: AbortSignal): Promise<unknown>
  write(input: ModelInput & Readonly<{ style: WritingStyle; time: RunTime }>, signal: AbortSignal): Promise<unknown>
}>
