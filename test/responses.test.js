import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectResponse,
  encodeResponseEvents,
  responsesToChat,
} from '../src/responses.js'

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

const chunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Hello ' },
  { type: 'text-delta', index: 0, text: 'Codex' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello Codex' } },
  { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('converts Responses input, tools and function results to chat', () => {
  const { body, model, stream } = responsesToChat({
    model: 'sensenova-6.8-flash-lite',
    instructions: 'be brief',
    stream: true,
    max_output_tokens: 100,
    reasoning: { effort: 'high' },
    tools: [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
    ],
  })

  assert.equal(model, 'sensenova-6.8-flash-lite')
  assert.equal(stream, true)
  assert.equal(body.max_tokens, 100)
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tools[0].function.name, 'shell')
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'be brief')
  assert.equal(body.messages[1].content, 'hi')
  assert.equal(body.messages[2].role, 'assistant')
  assert.equal(body.messages[2].tool_calls[0].id, 'c1')
  assert.equal(body.messages[3].role, 'tool')
  assert.equal(body.messages[3].tool_call_id, 'c1')
})

test('encodes a completed Responses stream', async () => {
  const events = await collect(encodeResponseEvents((async function* () { yield* chunks })(), {
    model: 'sensenova-6.8-flash-lite',
  }))
  const names = events.map(event => event.event)
  assert.equal(names[0], 'response.created')
  assert.ok(names.includes('response.output_text.delta'))
  assert.ok(names.includes('response.output_text.done'))
  assert.equal(names.at(-1), 'response.completed')

  const deltas = events.filter(event => event.event === 'response.output_text.delta')
  assert.equal(deltas.map(event => event.data.delta).join(''), 'Hello Codex')

  const completed = events.at(-1).data.response
  assert.equal(completed.status, 'completed')
  assert.equal(completed.output[0].content[0].text, 'Hello Codex')
  assert.equal(completed.usage.total_tokens, 6)
})

test('collects a non-streaming Responses object', async () => {
  const response = await collectResponse((async function* () { yield* chunks })(), {
    model: 'sensenova-6.8-flash-lite',
  })
  assert.equal(response.object, 'response')
  assert.equal(response.status, 'completed')
  assert.equal(response.output[0].type, 'message')
  assert.equal(response.output[0].content[0].text, 'Hello Codex')
})
