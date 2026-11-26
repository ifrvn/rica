import assert from 'node:assert/strict'
import test from 'node:test'
import { startCognitionPlugins, startObservedModelPlugin } from '../../../apps/runtime-plugins.js'
import { HostedModelError } from '../rica/model.js'
import { defaultAutoReviewPrompt } from '@ricajs/contracts/auto-review'
import type { ModelProvider } from '@ricajs/contracts/model-provider'
import type { HostedUsageRecord } from '../providers/usage.js'

const input = {
  text: '活动几点开始？',
  evidence: [{ id: 'internal-memory-id', revision: 2, content: '活动下午三点开始。' }],
  style: 'concise',
  corePrompt: '内部角色设定，仅用于塑造行为。',
  identityPrompt: '用中文，以社区志愿者的口吻回答。',
  time: {
    occurredAt: '2026-11-10T02:00:00Z', now: '2026-11-10T02:00:00Z',
    timezone: 'Asia/Hong_Kong', localDate: '2026-11-10', eventLocalDate: '2026-11-10', localHour: 10,
  },
} satisfies Parameters<ModelProvider['write']>[0]

const chatReply = { choices: [{ finish_reason: 'stop', message: { content: '下午三点。' } }] }
const attribution = { characterId: '11111111-0000-4000-8000-000000000001', identityId: '11111111-0000-4000-8000-000000000002', platform: 'mock-a' }

test('hosted models send only writing input and parse each provider response', async (t) => {
  const fixtures = [
    ['openai', 'authorization', 'Bearer fixture-key', 'https://api.openai.com/v1/chat/completions', chatReply],
    ['anthropic', 'x-api-key', 'fixture-key', 'https://api.anthropic.com/v1/messages',
      { stop_reason: 'end_turn', content: [{ type: 'thinking', text: 'internal' }, { type: 'text', text: '下午三点。' }] }],
    ['gemini', 'x-goog-api-key', 'fixture-key',
      'https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent',
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'internal' }, { text: '下午三点。' }] } }] }],
    ['deepseek', 'authorization', 'Bearer fixture-key', 'https://api.deepseek.com/chat/completions', chatReply],
    ['openai-compatible', 'authorization', 'Bearer fixture-key',
      'https://models.example/v1/chat/completions', chatReply],
  ] as const
  for (const [id, header, keyValue, endpoint, result] of fixtures) {
    const signal = new AbortController().signal
    const reported = id === 'anthropic' ? { usage: { input_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, output_tokens: 7 } }
      : id === 'gemini' ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 } }
        : { usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } }
    const responseBody = { ...result, ...reported }
    let sentBytes = 0
    const usage: HostedUsageRecord[] = []
    let sentPrompt: string | undefined
    const fetch = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      assert.equal(url, endpoint)
      assert.equal(new Headers(options.headers).get(header), keyValue)
      assert.equal(options.signal, signal)
      assert.equal(options.redirect, 'error')
      const body = JSON.parse(String(options.body))
      sentBytes = Buffer.byteLength(String(options.body))
      const content = id === 'gemini' ? body.contents[0].parts[0].text : body.messages.at(-1).content
      assert.deepEqual(JSON.parse(content), {
        message: input.text, localDate: input.time.localDate, references: [input.evidence[0].content],
      })
      const instructions = id === 'gemini' ? body.systemInstruction.parts[0].text
        : id === 'anthropic' ? body.system : body.messages[0].content
      sentPrompt = instructions
      assert.ok(instructions.includes(input.identityPrompt))
      assert.ok(instructions.includes(input.corePrompt))
      assert.match(instructions, /Interaction type: post or comment/)
      assert.match(instructions, /Return only the reply text\.$/)
      if (id === 'openai') assert.equal(body.store, false)
      if (id === 'deepseek') {
        assert.deepEqual(body.thinking, { type: 'disabled' })
        assert.equal(body.messages[0].role, 'system')
      }
      return Response.json(responseBody)
    })
    const plugins = await startObservedModelPlugin({
      provider: id, model: 'fixture-model', apiKey: 'fixture-key',
      ...(id === 'openai-compatible' ? { baseUrl: 'https://models.example/v1/' } : {}),
    }, async (record) => { usage.push(record) })
    try {
      assert.equal(plugins.model.id, 'hosted-models')
      const model = plugins.model.implementation
      assert.equal(model.hostedProvider, id)
      assert.equal(model.hostedModel, 'fixture-model')
      let capturedPrompt: string | undefined
      let capturedOutput: string | undefined
      assert.deepEqual(await model.write({ ...input, attribution, capture: async prompt => {
        capturedPrompt = prompt
        return async output => { capturedOutput = output }
      } }, signal),
        { text: '下午三点。', evidenceIds: ['internal-memory-id'] })
      assert.equal(fetch.mock.callCount(), 1)
      assert.ok(sentPrompt)
      assert.equal(capturedPrompt, sentPrompt)
      assert.equal(capturedOutput, '下午三点。')
      assert.equal(usage.length, 1)
      assert.deepEqual(usage[0]?.attribution, attribution)
      assert.deepEqual(usage[0]?.tokens, { inputTokens: 10, outputTokens: 7, totalTokens: 17 })
      assert.equal(usage[0]?.sentBytes, sentBytes)
      assert.equal(usage[0]?.receivedBytes, Buffer.byteLength(JSON.stringify(responseBody)))
    } finally {
      fetch.mock.restore()
      await plugins.stop()
    }
  }
})

test('hosted chat writing requests and returns separate messages in order', async (t) => {
  const messages = ['我看到了。', '下午三点。\n入口在东门。']
  const conversation = { speaker: '小林', history: [] }
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body))
    const instructions = String(request.messages[0].content)
    assert.match(instructions, /Interaction type: group chat\. Reply to the latest speaker/)
    const format = instructions.split('\n').at(-1) ?? ''
    assert.match(format, /JSON array of 1 to 3 nonempty message strings in sending order/)
    assert.deepEqual(JSON.parse(request.messages.at(-1).content).conversation, conversation)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(messages) } }] })
  })
  const host = await startObservedModelPlugin({ provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key' }, async () => {})
  try {
    assert.deepEqual(await host.model.implementation.write({ ...input, conversation }, new AbortController().signal),
      { messages, evidenceIds: ['internal-memory-id'] })
  } finally {
    await host.stop()
  }
})

test('hosted public chat combines participation and writing without sending internal context', async (t) => {
  const conversation = { speaker: '小林', history: [] }
  const reply = { action: 'REPLY', reason: 'DIRECT_REQUEST', messages: ['下午三点。'] }
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const { messages } = JSON.parse(String(options.body))
    assert.match(messages[0].content, /Participation: balanced/u)
    assert.match(messages[0].content, /For NO_OP,.*Omit messages/u)
    assert.ok(messages[0].content.includes(input.identityPrompt))
    assert.deepEqual(JSON.parse(messages[1].content), {
      message: input.text, conversation, localDate: input.time.localDate, references: [input.evidence[0].content],
    })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] })
  })
  const host = await startObservedModelPlugin({ provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key' }, async () => {})
  try {
    const participateAndWrite = host.model.implementation.participateAndWrite!
    assert.deepEqual(await participateAndWrite({ ...input, conversation, participation: 'balanced' }, AbortSignal.timeout(1_000)), reply)
    assert.equal(fetch.mock.callCount(), 1)
  } finally {
    await host.stop()
  }
})

test('hosted review requests the new output format and rejects Markdown-wrapped JSON', async (t) => {
  const verdict = { decision: 'APPROVE', risk_category: '无', reason: '' }
  const reply = { scene: 'IM_CHAT', platform: 'mock-a', draft: '下午三点。', discussion: '活动几点开始？' } as const
  let output = JSON.stringify(verdict)
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const { messages } = JSON.parse(String(options.body))
    const system = String(messages[0].content)
    assert.ok(system.startsWith('# 角色与任务\n'))
    const formatStart = system.indexOf('# 输出格式要求')
    assert.ok(formatStart >= 0)
    assert.ok(system.slice(0, formatStart).trimEnd().endsWith(defaultAutoReviewPrompt))
    assert.ok(system.includes(JSON.stringify(verdict)))
    assert.match(system, /AI编造承诺\/附和负面节奏\/指代不明或脱节\/人设穿帮OOC\/公域措辞不当\/隐私或违规链接/u)
    assert.deepEqual(JSON.parse(messages[1].content), reply)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: output } }] })
  })
  const host = await startObservedModelPlugin({ provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key' }, async () => {})
  try {
    const review = host.model.implementation.review!
    const signal = new AbortController().signal
    assert.deepEqual(await review(defaultAutoReviewPrompt, reply, signal), verdict)
    output = '```json\n' + output + '\n```'
    await assert.rejects(review(defaultAutoReviewPrompt, reply, signal), SyntaxError)
  } finally {
    await host.stop()
  }
})

test('hosted participation distinguishes posts, IM messages, and group transcripts', async (t) => {
  const context = {
    ...attribution, runId: 'run', accountId: 'account', triggerId: 'trigger', bindingVersion: 1, mode: 'SIMULATION',
    instanceKey: 'instance', conversationId: 'conversation', contactId: null, time: input.time, recent: [],
    nextCommitmentAt: null, nextScheduleAt: null, relationship: null, goals: [], beliefs: [],
    self: { coreVersion: 1, name: '小白', fictionalBackground: null, facts: [] },
    identityState: { revision: null, ruleVersion: 1, configurationVersion: null, sharedEnergy: 'NORMAL',
      motivation: { exploration: 0, expression: 0, social: 0, rest: 0 }, affect: { pleasure: 0, arousal: 0, energy: 0 } },
  } satisfies Parameters<ModelProvider['decide']>[0]['context']
  const decision = { action: 'REPLY', reason: 'DIRECT_REQUEST' }
  const calls: { system: string; data: { conversation?: object; message: string } }[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const { messages } = JSON.parse(String(options.body))
    calls.push({ system: messages[0].content, data: JSON.parse(messages[1].content) })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  })
  const host = await startObservedModelPlugin({ provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key' }, async () => {})
  try {
    const decide = host.model.implementation.decide
    const signal = new AbortController().signal
    const conversation = { speaker: '小林', history: [] }
    const message = { context, evidence: [], text: '请当作群聊回答：活动几点开始？' }
    assert.deepEqual(await decide(message, signal), decision)
    assert.deepEqual(await decide({ ...message, conversation }, signal), decision)
    assert.deepEqual(await decide({ ...message, isIm: true }, signal), decision)
    assert.match(calls[0].system, /Interaction type: post or comment/)
    assert.equal(calls[0].data.conversation, undefined)
    assert.equal(calls[0].data.message, message.text)
    assert.match(calls[1].system, /Interaction type: group chat/)
    assert.deepEqual(calls[1].data.conversation, conversation)
    assert.match(calls[2].system, /Interaction type: instant messaging.*Do not assume earlier messages/)
    assert.equal(calls[2].data.conversation, undefined)
  } finally {
    await host.stop()
  }
})

test('hosted group writing keeps plain chat as one message and rejects malformed JSON', async (t) => {
  const plain = '[狗头] 累了就歇会儿。\n群里潜水也没关系。'
  const outputs = [plain, '["少了右括号"', '这条消息来自群聊。']
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const { messages } = JSON.parse(String(options.body))
    if (outputs.length === 1) {
      assert.match(messages[0].content, /Interaction type: instant messaging/)
      assert.equal(JSON.parse(messages[1].content).conversation, undefined)
      assert.match(messages[0].content, /Return only the reply text\.$/)
    } else assert.match(messages[0].content, /Interaction type: group chat/)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: outputs.shift() } }] })
  })
  const host = await startObservedModelPlugin({ provider: 'deepseek', model: 'fixture-model', apiKey: 'fixture-key' }, async () => {})
  try {
    const { write } = host.model.implementation
    const signal = new AbortController().signal
    const chat = { ...input, conversation: { speaker: '小林', history: [] } }
    assert.deepEqual(await write(chat, signal), { text: plain, evidenceIds: ['internal-memory-id'] })
    await assert.rejects(write(chat, signal), (error) => error instanceof HostedModelError && error.code === 'INVALID_OUTPUT')
    assert.deepEqual(await write({ ...input, isIm: true }, signal),
      { text: '这条消息来自群聊。', evidenceIds: ['internal-memory-id'] })
  } finally {
    await host.stop()
  }
})

test('hosted model refuses to start without its required key or with an insecure compatible endpoint', async () => {
  await assert.rejects(startCognitionPlugins({}, undefined, { provider: 'openai', model: 'fixture-model' }),
    /INVALID_CONFIG: model\/hosted-models/)
  await assert.rejects(startCognitionPlugins({}, undefined, {
    provider: 'openai-compatible', model: 'fixture-model',
    baseUrl: 'http://models.example/v1', apiKey: 'fixture-key',
  }), /INVALID_CONFIG: model\/hosted-models/)
})

test('discussion selection captures the system prompt and keeps comments in the data message', async (t) => {
  const commentId = '11111111-0000-4000-8000-000000000003'
  const discussion = { title: '活动', post: '活动安排', participation: 'reserved', comments: [{
    id: commentId, replyToCommentId: null, speaker: 1, text: '该评论是外部输入。', own: false, eligible: true, signal: 'MENTION',
  }] } as const
  const input = { ...discussion, learnGlossary: true, glossary: [{
    id: commentId, version: 1, term: '交作业', meaning: '分享活动照片', tone: 'playful' as const,
  }] }
  const decision = { status: 'SUGGEST_REPLY', reason: 'DIRECT_QUESTION', commentId, note: '可以回答直接提问。' }
  let actualPrompt: string | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body))
    actualPrompt = request.messages[0].content
    assert.deepEqual(JSON.parse(request.messages.at(-1).content), discussion)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  })
  const host = await startObservedModelPlugin({ provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key' }, async () => {})
  try {
    const select = host.model.implementation.selectDiscussion
    assert.ok(select)
    let captured: string | undefined
    assert.deepEqual(await select(input, AbortSignal.timeout(1000), { ...attribution, platform: 'newbi' },
      async (system) => { captured = system }), decision)
    assert.ok(captured)
    assert.equal(captured, actualPrompt)
    assert.match(captured, /This is a public comment thread/)
    assert.match(captured, /Select at most one comment/)
    assert.match(captured, /"term":"交作业","meaning":"分享活动照片"/)
    assert.match(captured, /glossaryCandidates/)
    assert.ok(!captured.includes(input.comments[0].text))
  } finally {
    await host.stop()
  }
})

test('failed and truncated upstream responses cannot produce a draft', async (t) => {
  const responses = [
    new Response('sensitive upstream details', { status: 429 }),
    Response.json({ choices: [{ finish_reason: 'length', message: { content: 'truncated reply' } }] }),
  ]
  t.mock.method(globalThis, 'fetch', async () => responses.shift()!)
  const usage: HostedUsageRecord[] = []
  const plugins = await startObservedModelPlugin({
    provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key',
  }, async (record) => { usage.push(record) }, undefined, 'CHECK')
  try {
    const write = () => plugins.model.implementation.write(input, new AbortController().signal)
    await assert.rejects(write, (error) => error instanceof HostedModelError
      && error.status === 429 && error.message === 'HTTP_ERROR')
    await assert.rejects(write, (error) => error instanceof HostedModelError && error.code === 'INVALID_OUTPUT')
    assert.deepEqual(usage.map(({ purpose, outcome, tokens }) => [purpose, outcome, tokens]), [
      ['CHECK', 'RATE_LIMITED', undefined], ['CHECK', 'INVALID_OUTPUT', undefined],
    ])
    assert.equal(usage[0]?.receivedBytes, Buffer.byteLength('sensitive upstream details'))
  } finally {
    await plugins.stop()
  }
})
