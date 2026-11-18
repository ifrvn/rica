export type MemoryCandidate = {
  id: string
  content: string
  revision: number
  importance: number
  confidence: number
  createdAt: Date
  scope: 'CORE' | 'IDENTITY' | 'ACCOUNT' | 'CONVERSATION'
  sameConversation: boolean
}

export type RankedMemory = MemoryCandidate & {
  score: number
  estimatedTokens: number
}
