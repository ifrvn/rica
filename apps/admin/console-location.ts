export type ConsolePage = 'character' | 'review' | 'runs' | 'outbox' | 'audit'
export type ConsoleLocation = { characterId: string; page: ConsolePage; detail?: string }

const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu

export function readConsoleLocation(hash: string): ConsoleLocation | undefined {
  const match = /^#\/characters\/([^/]+)\/(character|review|runs|outbox|audit)(?:\/([^/]+))?$/u.exec(hash)
  if (!match) return
  const [, characterId, page, detail] = match
  if (!id.test(characterId) || (detail && (!id.test(detail) || (page === 'character' || page === 'outbox')))) return
  return { characterId: characterId.toLowerCase(), page: page as ConsolePage, detail: detail?.toLowerCase() }
}

export function consoleHash({ characterId, page, detail }: ConsoleLocation) {
  return '#/characters/' + characterId + '/' + page + (detail ? '/' + detail : '')
}
