import { z } from 'zod'
import type { HostedModel } from './catalog.js'
import type { HostedModelConfig } from './config.js'

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

export async function requestHostedReply(id: HostedModel['id'], config: HostedModelConfig, system: string, input: string, signal: AbortSignal) {
  const { url, headers, body } = request(id, config, system, input)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal, redirect: 'error',
    })
  } catch {
    throw new HostedApiError('REQUEST_FAILED')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new HostedApiError('HTTP_ERROR', response.status)
  }
  const result: unknown = await response.json().catch(() => undefined)
  const reply = replyText(id, result)?.trim()
  if (!reply) throw new HostedApiError('INVALID_OUTPUT')
  return reply
}
