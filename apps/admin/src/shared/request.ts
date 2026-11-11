export class RequestError extends Error {
  constructor(readonly status: number, readonly code?: string) { super() }
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const code = body?.error?.code
    throw new RequestError(response.status, typeof code === 'string' ? code : undefined)
  }
  return response.json()
}
