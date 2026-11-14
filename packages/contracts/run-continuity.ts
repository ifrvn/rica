export type RunTime = Readonly<{
  occurredAt: string
  now: string
  timezone: string
  localDate: string
  eventLocalDate: string
  localHour: number
}>

export type IdentityState = Readonly<{
  revision: number | null
  ruleVersion: number
  configurationVersion: number | null
  sharedEnergy: 'LOW' | 'NORMAL' | 'HIGH'
  motivation: { exploration: number; expression: number; social: number; rest: number }
  affect: { pleasure: number; arousal: number; energy: number }
}>

export type SubjectiveBelief = Readonly<{
  id: string
  version: number
  kind: 'OPINION' | 'PREFERENCE'
  statement: string
  confidence: number
  subjective: true
}>

export type Continuity = {
  runId: string
  characterId: string
  identityId: string
  accountId: string
  triggerId: string
  bindingVersion: number
  mode: 'SIMULATION'
  platform: string
  instanceKey: string
  conversationId: string | null
  contactId: string | null
  occurredAt: string
  now: string
  timezone: string
  recent: readonly { kind: string; occurredAt: string }[]
  nextCommitmentAt: string | null
  nextScheduleAt: string | null
  relationship: { confirmedInteractions: number; lastConfirmedAt: string | null } | null
  goals: readonly { id: string; version: number; origin: 'ADMIN' | 'SELF'; title: string; budget: number; priority: number; dueAt: string; nextStep: string | null }[]
  self: {
    coreVersion: number
    name: string | null
    fictionalBackground: string | null
    facts: readonly { id: string; revision: number; content: string }[]
  }
}

export type RunContinuity = Omit<Continuity, 'occurredAt' | 'now' | 'timezone'> & {
  time: RunTime
  identityState: IdentityState
  beliefs: readonly SubjectiveBelief[]
}
