export class RequestError extends Error {
  constructor(readonly status: number) { super() }
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new RequestError(response.status)
  return response.json()
}
