export type ConsolePage = 'character' | 'review' | 'runs' | 'outbox' | 'audit' | 'plugins' | 'connector'
export type ConsoleLocation = { characterId: string; page: ConsolePage; detail?: string; runQuery?: string }

export const runFilterKeys = ['state', 'identityId', 'accountId', 'from', 'through'] as const

const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu

export function readConsoleLocation(hash: string): ConsoleLocation | undefined {
  const separator = hash.indexOf('?')
  const path = separator < 0 ? hash : hash.slice(0, separator)
  const match = /^#\/characters\/([^/]+)\/(character|review|runs|outbox|audit|plugins|connector)(?:\/([^/]+))?$/u.exec(path)
  if (!match) return
  const [, characterId, page, detail] = match
  if (!id.test(characterId) || (detail && (!id.test(detail) || (['character', 'outbox', 'plugins'].includes(page))))) return
  const query = new URLSearchParams(separator < 0 ? '' : hash.slice(separator + 1))
  const filters = new URLSearchParams()
  if (page === 'runs') {
    for (const key of runFilterKeys) {
      const value = query.get(key)
      if (value) filters.set(key, value)
    }
  }
  const runQuery = filters.toString()
  return { characterId: characterId.toLowerCase(), page: page as ConsolePage, detail: detail?.toLowerCase(),
    ...(runQuery ? { runQuery } : {}) }
}

export function consoleHash({ characterId, page, detail, runQuery }: ConsoleLocation) {
  return '#/characters/' + characterId + '/' + page + (detail ? '/' + detail : '')
    + (page === 'runs' && runQuery ? '?' + runQuery : '')
}
