export type Readiness = {
  status: 'ready' | 'unavailable'
  checks: { postgres: boolean; redis: boolean }
}
