import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonToChunks, mapFinishReason, mapUsage, mergeUsage, parseSseStream } from '../src/stream.js'

function bodyOf(text) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('maps usage and finish reasons', () => {
  assert.deepEqual(mapUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('max_tokens'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('max_output_tokens'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason(undefined), { kind: 'stop' })
})

test('parses reasoning, text, tool calls and usage', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
    '',
    'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"hello "}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"world"}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a\\"}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  const chunks = await collect(parseSseStream(bodyOf(sse)))
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(reasoning, 'think more')
  assert.equal(text, 'hello world')

  const blockEnds = chunks.filter(c => c.type === 'block-end')
  assert.equal(blockEnds.length, 3)
  const toolEnd = blockEnds.find(c => c.block.type === 'tool-call')
  assert.equal(toolEnd.block.id, 'call_1')
  assert.equal(toolEnd.block.name, 'read_file')
  assert.equal(toolEnd.block.arguments, '{"path":"a"}')

  const usage = chunks.find(c => c.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 })
  const finish = chunks.find(c => c.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
})

test('closes text-only stream and infers stop', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
  const chunks = await collect(parseSseStream(bodyOf(sse)))
  assert.equal(chunks.filter(c => c.type === 'block-end')[0].block.text, 'ok')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('empty stream becomes EMPTY_RESPONSE', async () => {
  const chunks = await collect(parseSseStream(bodyOf('data: [DONE]\n\n')))
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('non-streaming JSON is projected into the same block protocol', () => {
  const chunks = [...jsonToChunks({
    choices: [{
      message: {
        reasoning_content: 'r',
        content: 'answer',
        tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  })]
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'answer')
  assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), 'r')
  assert.equal(chunks.find(c => c.type === 'usage').usage.outputTokens, 2)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('SSE frames split across chunks still parse', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"split"}}]}\n\ndata: [DONE]\n\n')
  let offset = 0
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + 7))
      offset += 7
    },
  })
  const chunks = await collect(parseSseStream(body))
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'split')
})

test('parseSseStream honors startIndex for continuation blocks', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"continued"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'
  const chunks = await collect(parseSseStream(bodyOf(sse), { startIndex: 3 }))
  const starts = chunks.filter(c => c.type === 'block-start')
  assert.deepEqual(starts.map(c => c.index), [3])
  const ends = chunks.filter(c => c.type === 'block-end')
  assert.deepEqual(ends.map(c => c.index), [3])
})

test('jsonToChunks honors startIndex for continuation blocks', () => {
  const chunks = [...jsonToChunks({
    choices: [{ message: { content: 'next' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }, { startIndex: 5 })]
  const starts = chunks.filter(c => c.type === 'block-start')
  assert.deepEqual(starts.map(c => c.index), [5])
})

test('mergeUsage sums token fields across rounds', () => {
  const merged = mergeUsage(
    { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    { inputTokens: 5, outputTokens: 7, totalTokens: 12, reasoningTokens: 2 },
  )
  assert.deepEqual(merged, { inputTokens: 15, outputTokens: 10, totalTokens: 25, reasoningTokens: 2 })
  assert.deepEqual(mergeUsage(undefined, { inputTokens: 1 }), { inputTokens: 1 })
  assert.deepEqual(mergeUsage({ inputTokens: 1 }, undefined), { inputTokens: 1 })
})

test('a tool-call delta without a function name never opens a block', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"hi "}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"","arguments":"{\\"a\\":1}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await collect(parseSseStream(bodyOf(sse)))
  const starts = chunks.filter(c => c.type === 'block-start')
  const dels = chunks.filter(c => c.type === 'tool-call-delta')
  const ends = chunks.filter(c => c.type === 'block-end')
  // Only the text block is opened; the nameless tool call is dropped entirely.
  assert.deepEqual(starts.map(c => c.blockType), ['text'])
  assert.equal(dels.length, 0)
  assert.equal(ends.length, 1)
  assert.deepEqual(ends[0].block, { type: 'text', text: 'hi ' })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('tool call name arriving after arguments materializes the block', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"read_tool","arguments":""}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await collect(parseSseStream(bodyOf(sse)))
  const starts = chunks.filter(c => c.type === 'block-start')
  const ends = chunks.filter(c => c.type === 'block-end')
  assert.deepEqual(starts.map(c => c.blockType), ['tool-call'])
  assert.equal(ends.length, 1)
  assert.equal(ends[0].block.type, 'tool-call')
  assert.equal(ends[0].block.name, 'read_tool')
  assert.equal(ends[0].block.arguments, '{"a":1}')
})

test('a nameless tool call with only argument deltas is dropped', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await collect(parseSseStream(bodyOf(sse)))
  const starts = chunks.filter(c => c.type === 'block-start')
  assert.equal(starts.length, 0)
  assert.equal(chunks.filter(c => c.type === 'block-end').length, 0)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('mid-stream error closes opened blocks and drops nameless tool calls', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"partial "}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
  ].join('\n')
  // No [DONE] and no error frame — the stream simply ends with trailing text,
  // which feeds the `!sawDone` tail path. Also exercise a real error frame.
  const chunks = await collect(parseSseStream(bodyOf(sse)))
  const ends = chunks.filter(c => c.type === 'block-end')
  assert.deepEqual(ends.map(c => c.block.type), ['text'])
  assert.deepEqual(ends[0].block, { type: 'text', text: 'partial ' })

  const errorSse = [
    'data: {"choices":[{"delta":{"content":"before "}}]}',
    '',
    'data: {"error":{"message":"mid-stream boom","type":"server_error"}}',
    '',
  ].join('\n')
  const errorChunks = await collect(parseSseStream(bodyOf(errorSse)))
  const errorEnds = errorChunks.filter(c => c.type === 'block-end')
  assert.deepEqual(errorEnds.map(c => c.block.type), ['text'])
  const finish = errorChunks.at(-1)
  assert.equal(finish.reason.kind, 'stop') // sawContent → commit partial, not error
  assert.equal(finish.reason.kind, 'stop')
})
