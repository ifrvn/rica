import type { RunContinuity, RunTime } from './run-continuity.js'

export const maxSimulatedTextLength = 4_000

export class ModelProviderError extends Error {
  constructor(readonly code: 'HTTP_ERROR' | 'REQUEST_FAILED' | 'INVALID_OUTPUT', readonly status?: number) {
    super(code)
  }
}

export type ModelEvidence = Readonly<{ id: string; revision: number; content: string }>

type ModelInput = Readonly<{
  text: string
  evidence: readonly ModelEvidence[]
}>

export type WritingStyle = 'neutral' | 'formal' | 'casual' | 'concise'

export type ModelPluginOption = Readonly<{ id: string; name: string; requiresBaseUrl: boolean }>

export type ModelProvider = Readonly<{
  hostedModel?: string
  decide(input: ModelInput & Readonly<{ context: RunContinuity }>, signal: AbortSignal): Promise<unknown>
  write(input: ModelInput & Readonly<{ style: WritingStyle; time: RunTime; identityPrompt?: string; suggestFollowUp?: boolean }>, signal: AbortSignal): Promise<unknown>
}>
