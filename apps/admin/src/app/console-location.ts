export type ConsolePage = 'home' | 'character' | 'review' | 'runs' | 'outbox' | 'audit' | 'plugins' | 'health' | 'connector' | 'accounts' | 'members' | 'knowledge' | 'growth' | 'planning' | 'metrics'
export type ConsoleLocation = { characterId: string; page: ConsolePage; detail?: string; runQuery?: string; startSimulation?: boolean; connectorAccountId?: string; reviewPlugin?: string; reviewStatus?: string; auditTarget?: string; healthNode?: 'simulation-executor' }

export const runFilterKeys = ['state', 'identityId', 'accountId', 'from', 'through'] as const

const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu

export function readConsoleLocation(hash: string): ConsoleLocation | undefined {
  const separator = hash.indexOf('?')
  const path = separator < 0 ? hash : hash.slice(0, separator)
  const match = /^#\/characters\/([^/]+)\/(home|character|review|runs|outbox|audit|plugins|health|connector|accounts|members|knowledge|growth|planning|metrics)(?:\/([^/]+))?$/u.exec(path)
  if (!match) return
  const [, characterId, page, detail] = match
  if (!id.test(characterId) || (detail && (!id.test(detail) || (['home', 'character', 'outbox', 'plugins', 'health', 'members', 'metrics'].includes(page))))) return
  const query = new URLSearchParams(separator < 0 ? '' : hash.slice(separator + 1))
  const filters = new URLSearchParams()
  if (page === 'runs') {
    for (const key of runFilterKeys) {
      const value = query.get(key)
      if (value) filters.set(key, value)
    }
  }
  const runQuery = filters.toString()
  const connectorAccountId = query.get('accountId')
  const reviewPlugin = query.get('plugin')
  const reviewStatus = query.get('status')
  const auditTarget = query.get('targetId')
  return { characterId: characterId.toLowerCase(), page: page as ConsolePage, detail: detail?.toLowerCase(),
    ...(runQuery ? { runQuery } : {}),
    ...(page === 'runs' && !detail && query.get('start') === '1' ? { startSimulation: true } : {}),
    ...(page === 'connector' && connectorAccountId && id.test(connectorAccountId) ? { connectorAccountId } : {}),
    ...(page === 'connector' && reviewPlugin ? { reviewPlugin } : {}),
    ...(page === 'connector' && reviewStatus !== null ? { reviewStatus } : {}),
    ...(page === 'audit' && !detail && auditTarget && id.test(auditTarget) ? { auditTarget: auditTarget.toLowerCase() } : {}),
    ...(page === 'health' && query.get('node') === 'simulation-executor' ? { healthNode: 'simulation-executor' as const } : {}) }
}

export function consoleHash({ characterId, page, detail, runQuery, startSimulation, connectorAccountId, reviewPlugin, reviewStatus, auditTarget, healthNode }: ConsoleLocation) {
  const filters = new URLSearchParams(runQuery)
  if (page === 'runs' && !detail && startSimulation) filters.set('start', '1')
  if (page === 'connector' && connectorAccountId) filters.set('accountId', connectorAccountId)
  if (page === 'connector' && reviewPlugin) filters.set('plugin', reviewPlugin)
  if (page === 'connector' && reviewStatus !== undefined) filters.set('status', reviewStatus)
  return '#/characters/' + characterId + '/' + page + (detail ? '/' + detail : '')
    + ((page === 'runs' || page === 'connector') && filters.size ? '?' + filters.toString() : '')
    + (page === 'audit' && !detail && auditTarget ? '?targetId=' + encodeURIComponent(auditTarget) : '')
    + (page === 'health' && healthNode ? '?node=' + healthNode : '')
}
