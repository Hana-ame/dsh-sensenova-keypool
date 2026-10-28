/**
 * OpenAI stream/JSON → DSH StreamChunk projection.
 *
 * The upstream sends either SSE frames (`data: {...}` … `data: [DONE]`) or a
 * single JSON answer. Both are translated into the harness's indexed block
 * protocol:
 *
 *   block-start → text-delta/reasoning-delta/tool-call-delta → block-end
 *   usage → finish
 *
 * Blocks are opened lazily and closed in first-seen order, so an answer that
 * starts with thinking but later emits text still assembles correctly.
 *
 * @module src/stream
 */

import { randomUUID } from 'node:crypto'
import { UpstreamError } from './upstream.js'

export function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  const total = Number(usage.total_tokens ?? 0)
  const mapped = {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
  }
  if (Number.isFinite(total) && total > 0) mapped.totalTokens = total
  const cacheRead = Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens ??
      0,
  )
  if (Number.isFinite(cacheRead) && cacheRead > 0) mapped.cacheReadTokens = cacheRead
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0)
  if (Number.isFinite(cacheWrite) && cacheWrite > 0) mapped.cacheWriteTokens = cacheWrite
  const reasoning = Number(
    usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens ??
      0,
  )
  if (Number.isFinite(reasoning) && reasoning > 0) mapped.reasoningTokens = reasoning
  return mapped
}

export function mapFinishReason(reason) {
  switch (String(reason ?? '')) {
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'stop':
    case 'end_turn':
    case 'eos':
      return { kind: 'stop' }
    default:
      return { kind: 'stop' }
  }
}

function errorFromPayload(payload) {
  const error = payload?.error ?? payload
  const message = typeof error === 'string'
    ? error
    : String(error?.message ?? payload?.message ?? 'upstream error')
  const type = String(error?.type ?? error?.code ?? '')
  let code = 'SERVER'
  if (/rate|quota/i.test(type) || /rate.?limit|quota/i.test(message)) code = 'RATE_LIMIT'
  else if (/auth|credential|invalid.?key/i.test(type) || /auth|api.?key/i.test(message)) code = 'INVALID_CREDENTIAL'
  else if (/timeout/i.test(type)) code = 'TIMEOUT'
  return new UpstreamError(message, code, { retryable: code === 'RATE_LIMIT' || code === 'SERVER' || code === 'TIMEOUT' })
}

class BlockSink {
  constructor(emit) {
    this.emit = emit
    this.blocks = new Map()
    this.nextIndex = 0
  }

  open(key, kind) {
    const existing = this.blocks.get(key)
    if (existing !== undefined) return existing
    const block = {
      index: this.nextIndex,
      kind,
      text: '',
      args: '',
      id: kind === 'tool-call' ? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}` : '',
      name: '',
    }
    this.nextIndex += 1
    this.blocks.set(key, block)
    this.emit({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  text(key, delta) {
    if (typeof delta !== 'string' || delta === '') return
    const block = this.open(key, 'text')
    block.text += delta
    this.emit({ type: 'text-delta', index: block.index, text: delta })
  }

  reasoning(key, delta) {
    if (typeof delta !== 'string' || delta === '') return
    const block = this.open(key, 'reasoning')
    block.text += delta
    this.emit({ type: 'reasoning-delta', index: block.index, text: delta })
  }

  toolStart(key, id, name) {
    const block = this.open(key, 'tool-call')
    if (typeof id === 'string' && id !== '') block.id = id
    if (typeof name === 'string' && name !== '') block.name = name
  }

  toolArgs(key, delta) {
    if (typeof delta !== 'string' || delta === '') return
    const block = this.open(key, 'tool-call')
    block.args += delta
    this.emit({
      type: 'tool-call-delta',
      index: block.index,
      id: block.id,
      ...(block.name !== '' ? { name: block.name } : {}),
      argumentsDelta: delta,
    })
  }

  closeAll() {
    for (const block of this.blocks.values()) {
      if (block.kind === 'text' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      } else if (block.kind === 'reasoning' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      } else if (block.kind === 'tool-call') {
        this.emit({
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args === '' ? '{}' : block.args },
        })
      }
    }
    this.blocks.clear()
  }
}

function feedDelta(sink, delta, callIndex) {
  if (delta === null || typeof delta !== 'object') return
  const thinking = delta.reasoning_content ?? delta.reasoning
  if (typeof thinking === 'string' && thinking !== '') sink.reasoning('reasoning', thinking)
  if (typeof delta.content === 'string' && delta.content !== '') sink.text('text', delta.content)
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      if (call === null || typeof call !== 'object') continue
      const key = `tool:${call.index ?? call.id ?? callIndex()}`
      sink.toolStart(key, call.id, call.function?.name)
      sink.toolArgs(key, call.function?.arguments)
    }
  }
  // Legacy function_call deltas.
  if (delta.function_call !== null && typeof delta.function_call === 'object') {
    const key = `tool:legacy`
    sink.toolStart(key, undefined, delta.function_call.name)
    sink.toolArgs(key, delta.function_call.arguments)
  }
}

/**
 * Parse an SSE response body into DSH chunks.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {{signal?: AbortSignal}} [options]
 * @returns {AsyncGenerator<object>}
 */
export async function* parseSseStream(body, options = {}) {
  const signal = options.signal
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const outbox = []
  const sink = new BlockSink(chunk => outbox.push(chunk))
  let buffer = ''
  let sawContent = false
  let sawDone = false
  let usage = undefined
  let finishReason = undefined
  let toolIndex = 0
  const nextToolIndex = () => toolIndex++

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted === true) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const result = processFrame(frame)
        while (outbox.length > 0) yield outbox.shift()
        if (sawDone) break
      }
      if (sawDone) break
    }

    if (!sawDone && buffer.trim() !== '') {
      processFrame(buffer)
      while (outbox.length > 0) yield outbox.shift()
    }

    sink.closeAll()
    while (outbox.length > 0) yield outbox.shift()

    if (usage !== undefined) yield { type: 'usage', usage }
    if (finishReason !== undefined) {
      yield { type: 'finish', reason: finishReason }
    } else if (sawContent) {
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'EMPTY_RESPONSE', message: 'SenseNova stream closed without content' },
        },
      }
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // already closed
    }
    while (outbox.length > 0) yield outbox.shift()
    if (signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller cancelled' } } }
      return
    }
    const failure = error instanceof UpstreamError
      ? { code: error.code, message: error.message, ...(error.status !== undefined ? { status: error.status } : {}) }
      : { code: 'TRANSPORT', message: String(error?.message ?? error) }
    // Partial content already streamed must not be followed by a retryable
    // error finish: that invites the harness to replay the same turn.
    yield { type: 'finish', reason: sawContent ? { kind: 'stop' } : { kind: 'error', failure } }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }

  function processFrame(frame) {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith(':')) continue
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') {
        sawDone = true
        return
      }
      if (data === '') continue

      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      if (payload?.error !== undefined || payload?.type === 'error') {
        throw errorFromPayload(payload)
      }

      const choice = payload?.choices?.[0]
      if (payload?.usage !== undefined) usage = mapUsage(payload.usage) ?? usage

      if (choice === undefined) continue

      const delta = choice.delta
      if (delta !== undefined && delta !== null) {
        feedDelta(sink, delta, nextToolIndex)
        if (
          (typeof delta.content === 'string' && delta.content !== '') ||
          (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') ||
          (typeof delta.reasoning === 'string' && delta.reasoning !== '') ||
          (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
          (delta.function_call !== null && delta.function_call !== undefined)
        ) sawContent = true
      } else if (choice.message !== null && typeof choice.message === 'object') {
        // A provider that ignored `stream:true` and sent a full message.
        const message = choice.message
        if (typeof message.reasoning_content === 'string') sink.reasoning('reasoning', message.reasoning_content)
        if (typeof message.content === 'string') sink.text('text', message.content)
        if (Array.isArray(message.tool_calls)) {
          for (const call of message.tool_calls) {
            const key = `tool:${call.index ?? call.id ?? nextToolIndex()}`
            sink.toolStart(key, call.id, call.function?.name)
            sink.toolArgs(key, call.function?.arguments)
          }
        }
        if ((message.content ?? '') !== '' || Array.isArray(message.tool_calls)) sawContent = true
      }

      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = mapFinishReason(choice.finish_reason)
      }
    }
  }
}

/**
 * Project a non-streaming OpenAI JSON answer into chunks.
 *
 * @param {object} json
 * @returns {Generator<object>}
 */
export function* jsonToChunks(json) {
  if (json === null || typeof json !== 'object') {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'empty upstream body' } },
    }
    return
  }
  if (json.error !== undefined) {
    const error = errorFromPayload(json)
    yield { type: 'finish', reason: { kind: 'error', failure: { code: error.code, message: error.message } } }
    return
  }

  const outbox = []
  const sink = new BlockSink(chunk => outbox.push(chunk))
  const choice = json.choices?.[0]
  const message = choice?.message
  if (message !== null && typeof message === 'object') {
    if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
      sink.reasoning('reasoning', message.reasoning_content)
    }
    if (typeof message.content === 'string' && message.content !== '') sink.text('text', message.content)
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const key = `tool:${call.index ?? call.id ?? 0}`
        sink.toolStart(key, call.id, call.function?.name)
        sink.toolArgs(key, call.function?.arguments)
      }
    }
  }
  sink.closeAll()
  while (outbox.length > 0) yield outbox.shift()

  const usage = mapUsage(json.usage)
  if (usage !== undefined) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: choice?.finish_reason !== undefined ? mapFinishReason(choice.finish_reason) : { kind: 'stop' },
  }
}
