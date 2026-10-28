import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SensenovaKeyPoolAdapter } from '../src/adapter.js'

function tempState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sn-adapter-')), 'state.json')
}

function settings(overrides = {}) {
  return {
    baseURL: 'https://token.sensenova.cn/v1',
    chatPath: '/chat/completions',
    mode: 'auto',
    defaultKey: 'k1',
    keys: [
      { alias: 'k1', key: 'sk-first-secret', masked: 'sk-f…cret' },
      { alias: 'k2', key: 'sk-second-secret', masked: 'sk-s…cret' },
    ],
    timeoutMs: 5_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    retryableCodes: ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT'],
    maxRequestImageBytes: 20_971_520,
    models: [
      {
        id: 'sensenova-6.8-flash-lite',
        name: 'Lite',
        contextWindow: 1_048_576,
        maxOutput: 384_000,
        reasoning: true,
        inputModalities: ['text', 'image'],
      },
    ],
    defaultModel: 'sensenova-6.8-flash-lite',
    statePath: tempState(),
    gateway: { enabled: false, path: '/x', token: '' },
    ...overrides,
  }
}

function sseResponse(text = 'ok') {
  return new Response(
    `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function adapterWith(handler, extra = {}, deps = {}) {
  const calls = []
  const config = settings(extra)
  const adapter = new SensenovaKeyPoolAdapter({
    settingsSource: { current: () => config },
    warn: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return handler(url, init, calls.length)
    },
    ...deps,
  })
  return { adapter, calls, config }
}

test('one session always uses one key; another session gets the next key', async () => {
  const { adapter, calls } = adapterWith(() => sseResponse())
  const base = { provider: 'sensenova-pool', model: 'sensenova-6.8-flash-lite', messages: [{ role: 'user', content: 'hi' }] }

  await collect(adapter.stream({ ...base, sessionId: 'session-a' }))
  await collect(adapter.stream({ ...base, sessionId: 'session-a' }))
  await collect(adapter.stream({ ...base, sessionId: 'session-b' }))
  await collect(adapter.stream({ ...base, sessionId: 'session-b' }))

  assert.equal(calls.length, 4)
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-first-secret')
  assert.equal(calls[1].init.headers.authorization, 'Bearer sk-first-secret')
  assert.equal(calls[2].init.headers.authorization, 'Bearer sk-second-secret')
  assert.equal(calls[3].init.headers.authorization, 'Bearer sk-second-secret')
  assert.equal(calls[0].url, 'https://token.sensenova.cn/v1/chat/completions')
  assert.equal(calls[0].init.headers['user-agent'].startsWith('deepseek-harness'), true)
})

test('an explicit @alias pins that session', async () => {
  const { adapter, calls } = adapterWith(() => sseResponse())
  const base = { provider: 'sensenova-pool', messages: [{ role: 'user', content: 'hi' }] }
  await collect(adapter.stream({ ...base, model: 'sensenova-6.8-flash-lite@k2', sessionId: 'manual-session' }))
  await collect(adapter.stream({ ...base, model: 'sensenova-6.8-flash-lite', sessionId: 'manual-session' }))

  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-second-secret')
  assert.equal(calls[1].init.headers.authorization, 'Bearer sk-second-secret')
  assert.equal(JSON.parse(calls[0].init.body).model, 'sensenova-6.8-flash-lite')
})

test('429 does not switch keys and surfaces the failure', async () => {
  const { adapter, calls } = adapterWith(() => new Response('{"error":{"message":"slow down","type":"rate_limit"}}', {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '1' },
  }))
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'limited-session',
  }))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-first-secret')
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
  assert.equal(finish.reason.failure.status, 429)

  // The next turn still uses the same key: binding, not rotation.
  await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi again' }],
    sessionId: 'limited-session',
  }))
  assert.equal(calls[1].init.headers.authorization, 'Bearer sk-first-secret')
})

test('429 is retried up to maxRetries in the configured scope, on the same key', async () => {
  const { adapter, calls } = adapterWith(() => new Response('{"error":{"message":"tpm exhausted","type":"quota_exceeded_error","code":"8"}}', {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '1' },
  }), {
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    retryableCodes: ['RATE_LIMIT'],
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'retry-session',
  }))

  // One initial dispatch plus three retries, all on the session's first key.
  assert.equal(calls.length, 4)
  assert.deepEqual(
    calls.map(call => call.init.headers.authorization),
    ['Bearer sk-first-secret', 'Bearer sk-first-secret', 'Bearer sk-first-secret', 'Bearer sk-first-secret'],
  )
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
})

test('a failure outside retryableCodes is not retried', async () => {
  const { adapter, calls } = adapterWith(() => new Response('{"error":{"message":"nope"}}', {
    status: 429,
    headers: { 'content-type': 'application/json' },
  }), {
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    retryableCodes: ['SERVER'],
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'scope-session',
  }))

  assert.equal(calls.length, 1)
  assert.equal(chunks.at(-1).reason.failure.code, 'RATE_LIMIT')
})

test('disabled keys are excluded from the pool', async () => {
  const { adapter, calls } = adapterWith(() => sseResponse(), {
    keys: [
      { alias: 'k1', key: 'sk-disabled', masked: 'sk-d…led', enabled: false },
      { alias: 'k2', key: 'sk-enabled', masked: 'sk-e…led', enabled: true },
    ],
  })
  await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'enabled-only',
  }))
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-enabled')
})

test('unknown explicit alias fails without dispatching', async () => {
  const { adapter, calls } = adapterWith(() => sseResponse())
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite@missing',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 's1',
  }))
  assert.equal(calls.length, 0)
  assert.equal(chunks.at(-1).reason.failure.code, 'CONFIG')
})

test('non-streaming JSON response is accepted', async () => {
  const { adapter } = adapterWith(() => new Response(JSON.stringify({
    choices: [{ message: { content: 'json answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))

  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 's1',
  }))
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'json answer')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('a user image block is encoded to an image_url data URL on the wire', async () => {
  const { adapter, calls } = adapterWith(() => sseResponse('seen'), {}, {
    resolveAttachments: () => ({
      readImageRequest: async () => ({
        mediaType: 'image/jpeg',
        data: new Uint8Array([1, 2, 3]),
        bytes: 3,
        width: 1,
        height: 1,
      }),
    }),
  })

  await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'what is this' }, { type: 'image', attachment: { attachmentId: 'img-1' } }],
    }],
    sessionId: 'image-session',
  }))

  const body = JSON.parse(calls[0].init.body)
  const content = body.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'what is this')
  assert.equal(content[1].type, 'image_url')
  assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/)
})
