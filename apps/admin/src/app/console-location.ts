import { runFilterKeys } from '@ricajs/simulation/console/run-filters'

export type ConsolePage = 'home' | 'character' | 'review' | 'activity' | 'runs' | 'outbox' | 'audit' | 'plugins' | 'health' | 'connector' | 'accounts' | 'members' | 'knowledge' | 'growth' | 'planning' | 'metrics' | 'simulation-settings' | 'model-usage'
export type ConsoleLocation = { characterId: string; page: ConsolePage; detail?: string; runQuery?: string; startSimulation?: boolean; connectorAccountId?: string; reviewPlugin?: string; reviewStatus?: string; auditTarget?: string; healthNode?: 'simulation-executor' }

const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu

export function readConsoleLocation(hash: string): ConsoleLocation | undefined {
  if (hash === '#/model-usage') return { characterId: '', page: 'model-usage' }
  const separator = hash.indexOf('?')
  const path = separator < 0 ? hash : hash.slice(0, separator)
  const match = /^#\/characters\/([^/]+)\/(home|character|review|activity|runs|outbox|audit|plugins|health|connector|accounts|members|knowledge|growth|planning|metrics|simulation-settings|model-usage)(?:\/([^/]+))?$/u.exec(path)
  if (!match) return
  const [, characterId, page, detail] = match
  if (!id.test(characterId) || (detail && (!id.test(detail) || (['home', 'character', 'outbox', 'plugins', 'health', 'members', 'metrics', 'simulation-settings', 'model-usage'].includes(page))))) return
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
    ...((page === 'connector' || page === 'activity') && reviewPlugin ? { reviewPlugin } : {}),
    ...((page === 'connector' || page === 'review') && reviewStatus !== null ? { reviewStatus } : {}),
    ...(page === 'audit' && !detail && auditTarget && id.test(auditTarget) ? { auditTarget: auditTarget.toLowerCase() } : {}),
    ...(page === 'health' && query.get('node') === 'simulation-executor' ? { healthNode: 'simulation-executor' as const } : {}) }
}

export function consoleHash({ characterId, page, detail, runQuery, startSimulation, connectorAccountId, reviewPlugin, reviewStatus, auditTarget, healthNode }: ConsoleLocation) {
  if (page === 'model-usage' && !characterId) return '#/model-usage'
  const filters = new URLSearchParams(runQuery)
  if (page === 'runs' && !detail && startSimulation) filters.set('start', '1')
  if (page === 'connector' && connectorAccountId) filters.set('accountId', connectorAccountId)
  if ((page === 'connector' || page === 'activity') && reviewPlugin) filters.set('plugin', reviewPlugin)
  if ((page === 'connector' || page === 'review') && reviewStatus !== undefined) filters.set('status', reviewStatus)
  return '#/characters/' + characterId + '/' + page + (detail ? '/' + detail : '')
    + ((page === 'runs' || page === 'connector' || page === 'review' || page === 'activity') && filters.size ? '?' + filters.toString() : '')
    + (page === 'audit' && !detail && auditTarget ? '?targetId=' + encodeURIComponent(auditTarget) : '')
    + (page === 'health' && healthNode ? '?node=' + healthNode : '')
}
