import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createGateway } from '../src/gateway.js'

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()))
}

function upstreamServer(seen) {
  return http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push({ url: req.url, authorization: req.headers.authorization, body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":" codex"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n')
    res.end('data: [DONE]\n\n')
  })
}

function fakeAdapter(baseURL, seenKeys) {
  const settings = {
    baseURL,
    chatPath: '/chat/completions',
    timeoutMs: 5_000,
    defaultModel: 'sensenova-6.8-flash-lite',
    gateway: { enabled: true, path: '/gw/v1', token: '' },
  }
  return {
    _ensure: () => ({ settings }),
    pickKey: ({ sessionId, alias }) => {
      seenKeys.push({ sessionId, alias })
      return { alias: alias ?? 'k1', key: 'sk-test-key' }
    },
    listModels: async () => [
      { provider: 'sensenova-pool', id: 'sensenova-6.8-flash-lite', name: 'x' },
    ],
    status: () => ({ route: 'sensenova-pool', poolSize: 1 }),
  }
}

async function withGateway(fn) {
  const seen = []
  const keys = []
  const upstream = upstreamServer(seen)
  const upstreamPort = await listen(upstream)
  const adapter = fakeAdapter(`http://127.0.0.1:${upstreamPort}/v1`, keys)
  const server = http.createServer(createGateway({ adapter, warn: () => {} }))
  const port = await listen(server)
  try {
    await fn({ base: `http://127.0.0.1:${port}/gw/v1`, seen, keys })
  } finally {
    await close(server)
    await close(upstream)
  }
}

test('chat completions proxy streams upstream SSE with the picked key', async () => {
  await withGateway(async ({ base, seen, keys }) => {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sensenova-session': 'gateway-session',
        'x-sensenova-key': 'k2',
      },
      body: JSON.stringify({
        model: 'sensenova-6.8-flash-lite@k2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /hello/)
    assert.match(text, /\[DONE\]/)
    assert.equal(seen[0].url, '/v1/chat/completions')
    assert.equal(seen[0].authorization, 'Bearer sk-test-key')
    assert.equal(seen[0].body.model, 'sensenova-6.8-flash-lite')
    assert.deepEqual(keys[0], { sessionId: 'gateway-session', alias: 'k2' })
  })
})

test('responses proxy emits Codex-compatible SSE events', async () => {
  await withGateway(async ({ base, seen }) => {
    const response = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sensenova-session': 'codex-local',
        'x-sensenova-key': 'k1',
      },
      body: JSON.stringify({
        model: 'sensenova-6.8-flash-lite',
        instructions: 'be brief',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        stream: true,
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /event: response\.created/)
    assert.match(text, /event: response\.output_text\.delta/)
    assert.match(text, /event: response\.completed/)
    assert.match(text, /hello codex/)
    assert.equal(seen[0].body.messages[0].role, 'system')
    assert.equal(seen[0].body.messages[0].content, 'be brief')
    assert.equal(seen[0].body.tools[0].function.name, 'shell')
  })
})

test('non-streaming chat returns the upstream JSON object', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }],
    }))
  })
  const upstreamPort = await listen(upstream)
  const adapter = fakeAdapter(`http://127.0.0.1:${upstreamPort}/v1`, [])
  const server = http.createServer(createGateway({ adapter, warn: () => {} }))
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/gw/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sensenova-6.8-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    const json = await response.json()
    assert.equal(json.choices[0].message.content, 'plain')
  } finally {
    await close(server)
    await close(upstream)
  }
})
