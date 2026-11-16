import { z } from '@hono/zod-openapi'

export const newbiEndpoint = z.string().max(160).transform((value, ctx) => {
  if (URL.canParse(value)) {
    const url = new URL(value)
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/agent-api/v1') {
      return url.href
    }
  }
  ctx.addIssue({ code: 'custom', message: 'Expected a loopback Newbi Agent API endpoint' })
  return z.NEVER
})

export const newbiCredential = z.string().regex(/^nbi_agent_[A-Za-z0-9_-]{43}$/u)
