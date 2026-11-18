import { z } from 'zod'
import type { HostedModel } from './catalog.js'
import type { HostedModelConfig } from './config.js'
import { readTokenUsage, type HostedUsageRecord, type RecordHostedUsage } from './usage.js'

export class HostedApiError extends Error {
  constructor(readonly code: 'REQUEST_FAILED' | 'HTTP_ERROR' | 'INVALID_OUTPUT', readonly status?: number) {
    super(code)
  }
}

const chatResult = z.object({
  choices: z.array(z.object({
    finish_reason: z.literal('stop'),
    message: z.object({ content: z.string(), refusal: z.null().optional() }),
  })).length(1),
})
const claudeResult = z.object({
  stop_reason: z.literal('end_turn'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})
const geminiResult = z.object({
  candidates: z.array(z.object({
    finishReason: z.literal('STOP'),
    content: z.object({ parts: z.array(z.object({ thought: z.boolean().optional(), text: z.string().optional() })) }),
  })).length(1),
})
const maxTokens = 2048

function request(id: HostedModel['id'], { url, model, key }: HostedModelConfig, system: string, input: string): {
  url: string
  headers: Record<string, string>
  body: object
} {
  const message = { role: 'user', content: input }
  if (id === 'anthropic') {
    return {
      url, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: maxTokens, system, messages: [message] },
    }
  }
  if (id === 'gemini') {
    return {
      url: url + encodeURIComponent(model) + ':generateContent',
      headers: { 'x-goog-api-key': key },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      },
    }
  }
  return {
    url, headers: { Authorization: 'Bearer ' + key },
    body: {
      model,
      ...(id === 'openai' ? { max_completion_tokens: maxTokens, store: false } : { max_tokens: maxTokens }),
      ...(id === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
      messages: [{ role: id === 'openai' ? 'developer' : 'system', content: system }, message],
    },
  }
}

function replyText(id: HostedModel['id'], result: unknown) {
  if (id === 'anthropic') {
    const parsed = claudeResult.safeParse(result)
    return parsed.success ? parsed.data.content.filter(({ type }) => type === 'text').map(({ text }) => text).join('') : undefined
  }
  if (id === 'gemini') {
    const parsed = geminiResult.safeParse(result)
    return parsed.success ? parsed.data.candidates[0].content.parts.filter(({ thought }) => !thought).map(({ text }) => text).join('') : undefined
  }
  const parsed = chatResult.safeParse(result)
  return parsed.success ? parsed.data.choices[0].message.content : undefined
}

export async function requestHostedReply(id: HostedModel['id'], config: HostedModelConfig, system: string, input: string, signal: AbortSignal,
  usage?: Pick<HostedUsageRecord, 'attribution' | 'purpose'> & { record: RecordHostedUsage },
) {
  const { url, headers, body } = request(id, config, system, input)
  const payload = JSON.stringify(body)
  const day = new Date().toISOString().slice(0, 10)
  const started = performance.now()
  const metric: HostedUsageRecord = {
    day, provider: id, model: config.model, purpose: usage?.purpose ?? 'DRAFT', attribution: usage?.attribution,
    sentBytes: 0, receivedBytes: 0, outcome: 'CONNECTION_FAILED', elapsedMs: 0,
  }
  async function readBody(response: Response) {
    const reader = response.body?.getReader()
    if (!reader) return
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        metric.receivedBytes += chunk.value.byteLength
        if (metric.receivedBytes > 4 * 1024 * 1024) {
          await reader.cancel()
          return
        }
        chunks.push(chunk.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      return
    } finally {
      reader.releaseLock()
    }
  }
  try {
    let response: Response
    try {
      signal.throwIfAborted()
      metric.sentBytes = Buffer.byteLength(payload)
      response = await fetch(url, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: payload, signal, redirect: 'error',
      })
    } catch {
      if (signal.aborted) metric.outcome = 'TIMED_OUT'
      throw new HostedApiError('REQUEST_FAILED')
    }
    const result = await readBody(response)
    metric.tokens = readTokenUsage(id, result)
    if (!response.ok) {
      metric.outcome = response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR'
      throw new HostedApiError('HTTP_ERROR', response.status)
    }
    const reply = replyText(id, result)?.trim()
    if (!reply) {
      metric.outcome = signal.aborted ? 'TIMED_OUT' : 'INVALID_OUTPUT'
      throw new HostedApiError('INVALID_OUTPUT')
    }
    metric.outcome = 'OK'
    return reply
  } finally {
    metric.elapsedMs = Math.round(performance.now() - started)
    if (usage) await usage.record(metric).catch(() => {
      console.warn(JSON.stringify({ service: 'hosted-models', event: 'usage_record_failed' }))
    })
  }
}
