type Tone = 'default' | 'success' | 'warning' | 'error'
export type HealthNode = { id: string; label: string; description: string; state: string; tone: Tone; at?: string; diagnostic?: string }
