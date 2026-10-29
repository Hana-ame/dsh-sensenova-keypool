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

// ── auto-continue on max-token truncation ────────────────────────────────

function truncatedSse(parts, finish = 'length') {
  const frames = parts.map((content, index) =>
    `data: {"choices":[{"delta":{"content":"${content}"}}]}`,
  )
  frames.push(`data: {"choices":[{"delta":{},"finish_reason":"${finish}"}],"usage":{"prompt_tokens":1,"completion_tokens":${parts.length},"total_tokens":${parts.length + 1}}}`)
  frames.push('data: [DONE]')
  return new Response(`${frames.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('a length-truncated answer is auto-continued with the partial text as context', async () => {
  const responses = [
    truncatedSse(['part one ', 'part two ']), // finish_reason: length
    truncatedSse(['part three'], 'stop'),
  ]
  const { adapter, calls } = adapterWith((url, init, callIndex) => responses[callIndex - 1] ?? sseResponse(), {
    autoContinueRounds: 4,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'write a long answer' }],
    sessionId: 'continue-session',
  }))

  // Two upstream requests, same key.
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-first-secret')
  assert.equal(calls[1].init.headers.authorization, 'Bearer sk-first-secret')

  // The continuation request carries the partial answer plus the prompt.
  const secondBody = JSON.parse(calls[1].init.body)
  const extra = secondBody.messages.slice(1)
  assert.equal(extra.length, 2)
  assert.deepEqual(extra[0], { role: 'assistant', content: 'part one part two ' })
  assert.equal(extra[1].role, 'user')
  assert.equal(extra[1].content, '继续')

  // All text arrives, merged usage is one chunk, final finish is stop.
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'part one part two part three')
  const usages = chunks.filter(c => c.type === 'usage')
  assert.equal(usages.length, 1)
  assert.equal(usages[0].usage.outputTokens, 3)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('auto-continue respects block index offsets per round', async () => {
  const responses = [
    truncatedSse(['first-']), // length
    truncatedSse(['second'], 'stop'),
  ]
  const { adapter } = adapterWith((url, init, callIndex) => responses[callIndex - 1] ?? sseResponse(), {
    autoContinueRounds: 4,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'offset-session',
  }))

  const starts = chunks.filter(c => c.type === 'block-start')
  assert.deepEqual(starts.map(c => c.index), [0, 1])
  const ends = chunks.filter(c => c.type === 'block-end')
  assert.deepEqual(ends.map(c => c.index), [0, 1])
})

test('auto-continue can be disabled via settings', async () => {
  const { adapter, calls } = adapterWith(() => truncatedSse(['cut ']), {
    autoContinue: false,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'no-continue-session',
  }))

  assert.equal(calls.length, 1)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

test('autoContinueRounds caps the number of continuation requests', async () => {
  let callCount = 0
  const { adapter, calls } = adapterWith(() => {
    callCount += 1
    return truncatedSse([`round-${callCount}-`])
  }, {
    autoContinueRounds: 2,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'capped-session',
  }))

  // First request + 2 continuation rounds.
  assert.equal(calls.length, 3)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

test('a truncated tool-call round does not auto-continue', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a\\"}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const { adapter, calls } = adapterWith(() => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }), {
    autoContinueRounds: 4,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'tool-truncated-session',
  }))

  assert.equal(calls.length, 1)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

test('non-streaming JSON truncation auto-continues too', async () => {
  const jsonRound = (content, finish) => new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: content.length, total_tokens: content.length + 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const { adapter, calls } = adapterWith((url, init, callIndex) =>
    callIndex === 1 ? jsonRound('json part one ', 'length') : jsonRound('json part two', 'stop'), {
    autoContinueRounds: 4,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'json-continue-session',
  }))

  assert.equal(calls.length, 2)
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'json part one json part two')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('a continuation-round transport failure keeps the partial answer', async () => {
  const { adapter } = adapterWith((url, init, callIndex) => {
    if (callIndex === 1) return truncatedSse(['partial '])
    return new Response('boom', { status: 503, headers: { 'content-type': 'application/json' } })
  }, {
    maxRetries: 0,
    autoContinueRounds: 4,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'drop-session',
  }))

  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'partial ')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

// ── truncation detection beyond the finish_reason string ──────────────────

/** One SSE round whose usage is chosen explicitly (cap/context classification). */
function usageSse({ parts = [], finish = 'stop', promptTokens = 1, completionTokens = 1 } = {}) {
  const frames = parts.map(content => `data: {"choices":[{"delta":{"content":"${content}"}}]}`)
  frames.push(
    `data: {"choices":[{"delta":{},"finish_reason":"${finish}"}],` +
      `"usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens},` +
      `"total_tokens":${promptTokens + completionTokens}}}`,
  )
  frames.push('data: [DONE]')
  return new Response(`${frames.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const SMALL_WINDOW_MODELS = [{
  id: 'sensenova-6.8-flash-lite',
  name: 'Lite',
  contextWindow: 1000,
  maxOutput: 384_000,
  reasoning: true,
  inputModalities: ['text'],
}]

test('a stop finish that consumed the whole output cap is auto-continued', async () => {
  // Some SenseNova backends cut the answer without reporting `length`; the
  // request cap being fully consumed is the real truncation signal.
  const responses = [
    usageSse({ parts: ['cut '], finish: 'stop', promptTokens: 10, completionTokens: 8 }),
    usageSse({ parts: ['rest'], finish: 'stop', promptTokens: 20, completionTokens: 4 }),
  ]
  const { adapter, calls } = adapterWith((url, init, callIndex) => responses[callIndex - 1] ?? sseResponse(), {
    autoContinueRounds: 4,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'write a long answer' }],
    maxTokens: 8,
    sessionId: 'saturated-session',
  }))

  assert.equal(calls.length, 2)
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'cut rest')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('a saturated stop finish never degrades the final reason to stop', async () => {
  // Every round is cut at the cap: the turn must end as max-tokens (truncated),
  // not as a natural stop, or the harness treats a cut answer as complete.
  const { adapter, calls } = adapterWith(
    () => usageSse({ parts: ['x'], finish: 'stop', promptTokens: 5, completionTokens: 8 }),
    { autoContinueRounds: 1 },
  )
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8,
    sessionId: 'saturated-cap-session',
  }))

  assert.equal(calls.length, 2)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

test('a truncated round that fills the context window surfaces CONTEXT_WINDOW_EXCEEDED', async () => {
  // Mirrors the real 262144-token SenseNova sessions: the answer is cut with a
  // tiny output because input+output already fill the window. Appending a
  // continuation cannot fit, so the harness must compact and retry the step.
  const { adapter, calls } = adapterWith(
    () => usageSse({ parts: ['tiny'], finish: 'length', promptTokens: 990, completionTokens: 10 }),
    {
      autoContinueRounds: 4,
      models: SMALL_WINDOW_MODELS,
    },
  )
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 64,
    sessionId: 'context-overflow-session',
  }))

  assert.equal(calls.length, 1)
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.match(finish.reason.failure.message, /compaction is required/)
})

test('a length stop below the cap but at the window edge is context overflow, not continuation', async () => {
  // pi-ai calls this a "recoverable length": the provider stopped well below
  // the requested cap because the window was already full.
  const { adapter, calls } = adapterWith(
    () => usageSse({ parts: ['tail'], finish: 'length', promptTokens: 995, completionTokens: 2 }),
    {
      autoContinueRounds: 4,
      models: SMALL_WINDOW_MODELS,
    },
  )
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 64,
    sessionId: 'window-edge-session',
  }))

  assert.equal(calls.length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a continuation rejected as an invalid request becomes a context overflow', async () => {
  // The round-0 body was accepted; a 400 on the grown continuation body means
  // the prompt no longer fits. Reporting an error lets compaction retry the
  // step instead of committing a cut answer as `stop`.
  const { adapter, calls } = adapterWith((url, init, callIndex) => {
    if (callIndex === 1) return truncatedSse(['partial '])
    return new Response(
      '{"error":{"message":"inference request is invalid","type":"invalid_request_error","code":"3"}}',
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }, {
    maxRetries: 0,
    autoContinueRounds: 4,
  })
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'invalid-continuation-session',
  }))

  assert.equal(calls.length, 2)
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a nameless tool-call stream never yields a degenerate tool-call block', async () => {
  // Mirrors the real failing sessions: upstream opens a tool-call block with no
  // name/id, the harness would assemble {name:"",arguments:""}, dispatch
  // "unknown tool ''", and the replay would 400 with function/name cannot be
  // empty. The adapter must drop the nameless block entirely.
  const sse = [
    'data: {"choices":[{"delta":{"content":"\\n\\n"}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"","arguments":""}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const { adapter } = adapterWith(() => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }))
  const chunks = await collect(adapter.stream({
    provider: 'sensenova-pool',
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'nameless-session',
  }))

  const toolStarts = chunks.filter(c => c.type === 'block-start' && c.blockType === 'tool-call')
  const toolEnds = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.equal(toolStarts.length, 0)
  assert.equal(toolEnds.length, 0)
  // The text is kept, the turn ends normally.
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, '\n\n')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})
