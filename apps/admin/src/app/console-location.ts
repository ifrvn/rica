export type ConsolePage = 'home' | 'character' | 'review' | 'runs' | 'outbox' | 'audit' | 'plugins' | 'health' | 'connector' | 'accounts' | 'members' | 'knowledge' | 'growth' | 'planning' | 'metrics'
export type ConsoleLocation = { characterId: string; page: ConsolePage; detail?: string; runQuery?: string; connectorAccountId?: string }

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
  return { characterId: characterId.toLowerCase(), page: page as ConsolePage, detail: detail?.toLowerCase(),
    ...(runQuery ? { runQuery } : {}),
    ...(page === 'connector' && connectorAccountId && id.test(connectorAccountId) ? { connectorAccountId } : {}) }
}

export function consoleHash({ characterId, page, detail, runQuery, connectorAccountId }: ConsoleLocation) {
  return '#/characters/' + characterId + '/' + page + (detail ? '/' + detail : '')
    + (page === 'runs' && runQuery ? '?' + runQuery : '')
    + (page === 'connector' && connectorAccountId ? '?accountId=' + encodeURIComponent(connectorAccountId) : '')
}
