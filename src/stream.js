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

/**
 * Merge two `mapUsage` snapshots by summing token fields. Used when one LLM
 * turn is assembled from several upstream requests (auto-continue on
 * max-token truncation): each request reports its own usage, and the harness
 * only reads the last `usage` chunk, so the adapter must emit one merged total.
 *
 * @param {object | undefined} a
 * @param {object | undefined} b
 * @returns {object | undefined}
 */
export function mergeUsage(a, b) {
  if (a === undefined || a === null || typeof a !== 'object') return b
  if (b === undefined || b === null || typeof b !== 'object') return a
  const keys = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ]
  const merged = { ...a }
  for (const key of keys) {
    const av = Number(a[key] ?? 0)
    const bv = Number(b[key] ?? 0)
    if (Number.isFinite(av) && Number.isFinite(bv) && (av !== 0 || bv !== 0)) {
      merged[key] = av + bv
    }
  }
  return merged
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
  constructor(emit, startIndex = 0) {
    this.emit = emit
    this.blocks = new Map()
    this.pending = new Map()
    this.nextIndex = startIndex
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

  /**
   * Record the identity of a tool call. The block is only opened (block-start
   * emitted) once a function name is known: a tool-call without a name is
   * unusable — the harness would try to dispatch `unknown tool ""`, store a
   * degenerate block, and replay `function.name: ""` back, which the upstream
   * rejects with 400 (function/name cannot be empty). Ids are buffered in
   * `pending` until a name arrives; a nameless call is dropped at closeAll().
   */
  toolStart(key, id, name) {
    const existing = this.blocks.get(key)
    if (existing !== undefined) {
      if (typeof id === 'string' && id !== '') existing.id = id
      if (typeof name === 'string' && name !== '') existing.name = name
      return
    }
    if (typeof name !== 'string' || name === '') {
      if (!this.pending.has(key)) this.pending.set(key, { id: '', name: '', args: '' })
      if (typeof id === 'string' && id !== '') this.pending.get(key).id = id
      return
    }
    const block = this.open(key, 'tool-call')
    block.name = name
    const pending = this.pending.get(key)
    if (typeof id === 'string' && id !== '') block.id = id
    else if (pending !== undefined && pending.id !== '') block.id = pending.id
    if (pending !== undefined && pending.args !== '') {
      // Arguments arrived before the name on this call: materialize them now
      // so the buffered fragment is not lost.
      block.args = pending.args
      this.emit({
        type: 'tool-call-delta',
        index: block.index,
        id: block.id,
        name: block.name,
        argumentsDelta: pending.args,
      })
    }
    if (pending !== undefined) this.pending.delete(key)
  }

  toolArgs(key, delta) {
    if (typeof delta !== 'string' || delta === '') return
    const existing = this.blocks.get(key)
    if (existing !== undefined) {
      existing.args += delta
      this.emit({
        type: 'tool-call-delta',
        index: existing.index,
        id: existing.id,
        ...(existing.name !== '' ? { name: existing.name } : {}),
        argumentsDelta: delta,
      })
      return
    }
    // The block is not opened yet. Buffer the arguments fragment so that if a
    // name arrives on a later delta the call materializes with its full
    // arguments; a call that stays nameless is dropped by closeAll() and never
    // leaks a degenerate tool-call block to the harness.
    let pending = this.pending.get(key)
    if (pending === undefined) {
      pending = { id: '', name: '', args: '' }
      this.pending.set(key, pending)
    }
    pending.args += delta
    if (pending.name === '') return
    const block = this.open(key, 'tool-call')
    block.name = pending.name
    if (pending.id !== '') block.id = pending.id
    block.args = pending.args
    this.pending.delete(key)
    this.emit({
      type: 'tool-call-delta',
      index: block.index,
      id: block.id,
      name: block.name,
      argumentsDelta: block.args,
    })
  }

  closeAll() {
    for (const block of this.blocks.values()) {
      if (block.kind === 'text' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      } else if (block.kind === 'reasoning' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      } else if (block.kind === 'tool-call' && block.name !== '') {
        this.emit({
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args === '' ? '{}' : block.args },
        })
      }
      // Nameless tool-call blocks are skipped: a degenerate call must not reach
      // the harness (dispatch would fail, and replay would 400 on empty name).
    }
    this.blocks.clear()
    this.pending.clear()
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
 * @param {{signal?: AbortSignal, startIndex?: number}} [options] - `startIndex`
 *   offsets the emitted block indexes so a continuation request's blocks do not
 *   reuse indexes the harness has already assembled.
 * @returns {AsyncGenerator<object>}
 */
export async function* parseSseStream(body, options = {}) {
  const signal = options.signal
  const startIndex = Number.isSafeInteger(options.startIndex) && options.startIndex > 0 ? options.startIndex : 0
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const outbox = []
  const sink = new BlockSink(chunk => outbox.push(chunk), startIndex)
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
    // Close any blocks that were already opened so partial text/reasoning is
    // not lost and a half-streamed tool call is finalized by what arrived.
    sink.closeAll()
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
 * @param {{startIndex?: number}} [options]
 * @returns {Generator<object>}
 */
export function* jsonToChunks(json, options = {}) {
  const startIndex = Number.isSafeInteger(options?.startIndex) && options.startIndex > 0 ? options.startIndex : 0
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
  const sink = new BlockSink(chunk => outbox.push(chunk), startIndex)
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
