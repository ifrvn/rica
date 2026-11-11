import assert from 'node:assert/strict'
import test from 'node:test'
import { startCognitionPlugins } from '../../apps/runtime-plugins.js'
import { HostedModelError } from './hosted-models.js'
import type { ModelProvider } from './model-provider.js'

const input = {
  text: '活动几点开始？',
  evidence: [{ id: 'internal-memory-id', revision: 2, content: '活动下午三点开始。' }],
  style: 'concise',
  identityPrompt: '用中文，以社区志愿者的口吻回答。',
  time: {
    occurredAt: '2026-11-10T02:00:00Z', now: '2026-11-10T02:00:00Z',
    timezone: 'Asia/Hong_Kong', localDate: '2026-11-10', eventLocalDate: '2026-11-10', localHour: 10,
  },
} satisfies Parameters<ModelProvider['write']>[0]

const chatReply = { choices: [{ finish_reason: 'stop', message: { content: '下午三点。' } }] }

test('built-in model plugins send only writing input and parse their provider replies', async (t) => {
  const fixtures = [
    ['openai', 'authorization', 'Bearer fixture-key', 'https://api.openai.com/v1/chat/completions', chatReply],
    ['anthropic', 'x-api-key', 'fixture-key', 'https://api.anthropic.com/v1/messages',
      { stop_reason: 'end_turn', content: [{ type: 'thinking', text: 'internal' }, { type: 'text', text: '下午三点。' }] }],
    ['gemini', 'x-goog-api-key', 'fixture-key',
      'https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent',
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'internal' }, { text: '下午三点。' }] } }] }],
    ['openai-compatible', 'authorization', 'Bearer fixture-key',
      'https://models.example/v1/chat/completions', chatReply],
  ] as const
  for (const [id, header, keyValue, endpoint, result] of fixtures) {
    const signal = new AbortController().signal
    let responseBody: unknown = result
    const fetch = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      assert.equal(url, endpoint)
      assert.equal(new Headers(options.headers).get(header), keyValue)
      assert.equal(options.signal, signal)
      assert.equal(options.redirect, 'error')
      const body = JSON.parse(String(options.body))
      const content = id === 'gemini' ? body.contents[0].parts[0].text : body.messages.at(-1).content
      assert.deepEqual(JSON.parse(content), {
        message: input.text, localDate: input.time.localDate, references: [input.evidence[0].content],
      })
      const instructions = id === 'gemini' ? body.systemInstruction.parts[0].text
        : id === 'anthropic' ? body.system : body.messages[0].content
      assert.ok(instructions.includes(input.identityPrompt))
      if (id === 'openai') assert.equal(body.store, false)
      return Response.json(responseBody)
    })
    const plugins = await startCognitionPlugins({}, undefined, {
      provider: id, model: 'fixture-model', apiKey: 'fixture-key',
      ...(id === 'openai-compatible' ? { baseUrl: 'https://models.example/v1/' } : {}),
    })
    try {
      const model = plugins.model.implementation
      assert.equal(model.hostedModel, 'fixture-model')
      assert.equal(await model.decide({ text: input.text } as Parameters<ModelProvider['decide']>[0], signal), 'REPLY')
      assert.equal(fetch.mock.callCount(), 0)
      assert.deepEqual(await model.write(input, signal), { text: '下午三点。', evidenceIds: ['internal-memory-id'] })
      assert.equal(fetch.mock.callCount(), 1)
      if (id === 'openai') {
        const followUp = { kind: 'COMMITMENT', title: '整理报名问题', task: '整理活动报名问题', dueAt: '2026-11-11T02:00:00Z' }
        const output = { text: '我明天会整理活动报名问题。', followUp }
        responseBody = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }
        assert.deepEqual(await model.write({ ...input, suggestFollowUp: true }, signal), {
          ...output, evidenceIds: ['internal-memory-id'],
        })
      }
    } finally {
      fetch.mock.restore()
      await plugins.stop()
    }
  }
})

test('hosted model refuses to start without its required key or with an insecure compatible endpoint', async () => {
  await assert.rejects(startCognitionPlugins({}, undefined, { provider: 'openai', model: 'fixture-model' }),
    /INVALID_CONFIG: model\/openai/)
  await assert.rejects(startCognitionPlugins({}, undefined, {
    provider: 'openai-compatible', model: 'fixture-model',
    baseUrl: 'http://models.example/v1', apiKey: 'fixture-key',
  }), /INVALID_CONFIG: model\/openai-compatible/)
})

test('failed and truncated upstream responses cannot produce a draft', async (t) => {
  const responses = [
    new Response('sensitive upstream details', { status: 429 }),
    Response.json({ choices: [{ finish_reason: 'length', message: { content: 'truncated reply' } }] }),
  ]
  t.mock.method(globalThis, 'fetch', async () => responses.shift()!)
  const plugins = await startCognitionPlugins({}, undefined, {
    provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key',
  })
  try {
    const write = () => plugins.model.implementation.write(input, new AbortController().signal)
    await assert.rejects(write, (error) => error instanceof HostedModelError
      && error.status === 429 && error.message === 'HTTP_ERROR')
    await assert.rejects(write, (error) => error instanceof HostedModelError && error.code === 'INVALID_OUTPUT')
  } finally {
    await plugins.stop()
  }
})
