/**
 * Codex / OpenAI Responses surface.
 *
 * Codex speaks the Responses API while SenseNova's gateway speaks Chat
 * Completions. This module contains both directions:
 *
 *   responsesToChat(body)        request conversion for the proxy
 *   encodeResponseEvents(chunks) Chat/DSH chunks → Responses SSE events
 *   collectResponse(chunks)      chunks → one non-streaming response object
 *
 * Only the parts Codex actually uses are implemented: message items, function
 * call items, output text deltas, usage, completion and failure. Reasoning
 * deltas are dropped rather than exposed as unsupported response items.
 *
 * @module src/responses
 */

import { randomUUID } from 'node:crypto'

const shortId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'input_image' || part.type === 'image_url') parts.push('[image omitted: this route is text-only]')
  }
  return parts.join('\n')
}

/**
 * Convert a Responses request body into an OpenAI chat body.
 *
 * @param {object} body - Responses API request
 * @param {string} [fallbackModel]
 * @returns {{body: object, model: string, stream: boolean}}
 */
export function responsesToChat(body, fallbackModel = 'sensenova-6.8-flash-lite') {
  const request = body !== null && typeof body === 'object' ? body : {}
  const model = String(request.model ?? fallbackModel)
  const messages = []
  const systemParts = []
  if (typeof request.instructions === 'string' && request.instructions.trim() !== '') {
    systemParts.push(request.instructions)
  }

  const input = request.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item })
        continue
      }
      if (item === null || typeof item !== 'object') continue

      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id ?? item.id ?? ''),
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        })
        continue
      }

      if (item.type === 'function_call') {
        const call = {
          id: String(item.call_id ?? item.id ?? ''),
          type: 'function',
          function: {
            name: String(item.name ?? ''),
            arguments: typeof item.arguments === 'string' && item.arguments !== '' ? item.arguments : '{}',
          },
        }
        const previous = messages[messages.length - 1]
        if (previous?.role === 'assistant') {
          previous.tool_calls = [...(previous.tool_calls ?? []), call]
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] })
        }
        continue
      }

      if (item.type === 'reasoning') continue

      const role = String(item.role ?? 'user')
      if (role === 'system' || role === 'developer') {
        const text = textFromContent(item.content)
        if (text !== '') systemParts.push(text)
        continue
      }
      if (role === 'assistant') {
        messages.push({ role: 'assistant', content: textFromContent(item.content) })
        continue
      }
      messages.push({ role: 'user', content: textFromContent(item.content) })
    }
  }

  if (systemParts.length > 0) messages.unshift({ role: 'system', content: systemParts.join('\n\n') })

  const chat = {
    model,
    messages,
    stream: request.stream === true,
  }
  if (typeof request.max_output_tokens === 'number') chat.max_tokens = request.max_output_tokens
  if (typeof request.temperature === 'number') chat.temperature = request.temperature
  if (typeof request.top_p === 'number') chat.top_p = request.top_p
  if (typeof request.reasoning?.effort === 'string') chat.reasoning_effort = request.reasoning.effort
  if (request.tool_choice !== undefined) chat.tool_choice = request.tool_choice
  if (typeof request.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = request.parallel_tool_calls

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    chat.tools = request.tools
      .filter(tool => tool !== null && typeof tool === 'object')
      .map(tool => {
        if (tool.type === 'function' && tool.function !== undefined) return tool
        return {
          type: 'function',
          function: {
            name: String(tool.name ?? ''),
            description: String(tool.description ?? ''),
            parameters: tool.parameters ?? { type: 'object', properties: {} },
          },
        }
      })
  }

  return { body: chat, model, stream: chat.stream }
}

function responseBase(id, model, status = 'in_progress') {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  }
}

/**
 * Encode DSH chunks as OpenAI Responses SSE event objects.
 *
 * @param {AsyncIterable<object>} chunks
 * @param {{model?: string}} [options]
 * @returns {AsyncGenerator<{event: string, data: object}>}
 */
export async function* encodeResponseEvents(chunks, options = {}) {
  const model = String(options.model ?? 'sensenova-6.8-flash-lite')
  const responseId = shortId('resp')
  const outputs = new Map()
  const order = []
  let sequence = 0
  let usage = undefined
  let failure = undefined
  let sawFinish = false
  let textItem = null
  let textPart = null

  const send = (event, data) => ({ event, data: { type: event, sequence_number: sequence++, ...data } })

  yield send('response.created', { response: responseBase(responseId, model) })
  yield send('response.in_progress', { response: responseBase(responseId, model) })

  function outputIndexFor(index) {
    return order.indexOf(index)
  }

  function itemFor(index, kind) {
    if (outputs.has(index)) return outputs.get(index)
    const entry = kind === 'tool-call'
      ? {
          index,
          item: {
            id: shortId('fc'),
            type: 'function_call',
            status: 'in_progress',
            call_id: '',
            name: '',
            arguments: '',
          },
          kind,
          text: '',
        }
      : {
          index,
          item: {
            id: shortId('msg'),
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
          kind,
          text: '',
        }
    outputs.set(index, entry)
    order.push(index)
    return entry
  }

  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue

    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'reasoning') continue
      const entry = itemFor(chunk.index, chunk.blockType === 'tool-call' ? 'tool-call' : 'text')
      const outputIndex = outputIndexFor(chunk.index)
      if (entry.kind === 'text') {
        textItem = entry
        const item = entry.item
        yield send('response.output_item.added', { output_index: outputIndex, item: { ...item } })
        textPart = { type: 'output_text', text: '', annotations: [] }
        yield send('response.content_part.added', {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part: { ...textPart },
        })
      } else {
        const item = entry.item
        yield send('response.output_item.added', { output_index: outputIndex, item: { ...item } })
      }
      continue
    }

    if (chunk.type === 'text-delta') {
      const entry = itemFor(chunk.index, 'text')
      entry.text += chunk.text
      if (textPart === null) textPart = { type: 'output_text', text: '', annotations: [] }
      yield send('response.output_text.delta', {
        item_id: entry.item.id,
        output_index: outputIndexFor(chunk.index),
        content_index: 0,
        delta: chunk.text,
      })
      continue
    }

    if (chunk.type === 'tool-call-delta') {
      const entry = itemFor(chunk.index, 'tool-call')
      if (chunk.id !== undefined && chunk.id !== '') entry.item.call_id = String(chunk.id)
      if (typeof chunk.name === 'string' && chunk.name !== '') entry.item.name = chunk.name
      if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') {
        entry.item.arguments += chunk.argumentsDelta
        yield send('response.function_call_arguments.delta', {
          item_id: entry.item.id,
          output_index: outputIndexFor(chunk.index),
          delta: chunk.argumentsDelta,
        })
      }
      continue
    }

    if (chunk.type === 'block-end') {
      const entry = outputs.get(chunk.index)
      if (entry === undefined) continue
      const outputIndex = outputIndexFor(chunk.index)
      if (entry.kind === 'text') {
        const text = typeof chunk.block?.text === 'string' ? chunk.block.text : entry.text
        entry.text = text
        entry.item.status = 'completed'
        entry.item.content = [{ type: 'output_text', text, annotations: [] }]
        yield send('response.output_text.done', {
          item_id: entry.item.id,
          output_index: outputIndex,
          content_index: 0,
          text,
        })
        yield send('response.content_part.done', {
          item_id: entry.item.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        })
        yield send('response.output_item.done', { output_index: outputIndex, item: { ...entry.item } })
      } else {
        entry.item.status = 'completed'
        entry.item.arguments = typeof chunk.block?.arguments === 'string'
          ? chunk.block.arguments
          : entry.item.arguments
        if (typeof chunk.block?.name === 'string') entry.item.name = chunk.block.name
        if (typeof chunk.block?.id === 'string') entry.item.call_id = chunk.block.id
        yield send('response.function_call_arguments.done', {
          item_id: entry.item.id,
          output_index: outputIndex,
          arguments: entry.item.arguments,
        })
        yield send('response.output_item.done', { output_index: outputIndex, item: { ...entry.item } })
      }
      continue
    }

    if (chunk.type === 'usage') {
      usage = chunk.usage
      continue
    }

    if (chunk.type === 'finish') {
      sawFinish = true
      if (chunk.reason?.kind === 'error') failure = chunk.reason.failure
      continue
    }
  }

  const output = order.map(index => outputs.get(index).item)
  if (failure !== undefined) {
    yield send('response.failed', {
      response: {
        ...responseBase(responseId, model, 'failed'),
        output,
        error: { code: failure.code ?? 'SERVER', message: failure.message ?? 'upstream error' },
      },
    })
    return
  }

  const response = {
    ...responseBase(responseId, model, 'completed'),
    output,
    ...(usage !== undefined
      ? {
          usage: {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            ...(usage.reasoningTokens !== undefined
              ? { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
              : {}),
          },
        }
      : {}),
  }
  yield send('response.completed', { response })
}

/**
 * Collect chunks into one non-streaming Responses object.
 *
 * @param {AsyncIterable<object>} chunks
 * @param {{model?: string}} [options]
 * @returns {Promise<object>}
 */
export async function collectResponse(chunks, options = {}) {
  const model = String(options.model ?? 'sensenova-6.8-flash-lite')
  const responseId = shortId('resp')
  const output = []
  const items = new Map()
  let usage
  let failure

  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'reasoning') continue
      const item = chunk.blockType === 'tool-call'
        ? { type: 'function_call', id: shortId('fc'), status: 'in_progress', call_id: '', name: '', arguments: '' }
        : { type: 'message', id: shortId('msg'), status: 'in_progress', role: 'assistant', content: [] }
      items.set(chunk.index, { item, text: '' })
      output.push(item)
    } else if (chunk.type === 'text-delta') {
      const entry = items.get(chunk.index)
      if (entry !== undefined) entry.text += chunk.text
    } else if (chunk.type === 'tool-call-delta') {
      const entry = items.get(chunk.index)
      if (entry !== undefined) {
        if (chunk.id) entry.item.call_id = String(chunk.id)
        if (chunk.name) entry.item.name = chunk.name
        entry.item.arguments += chunk.argumentsDelta ?? ''
      }
    } else if (chunk.type === 'block-end') {
      const entry = items.get(chunk.index)
      if (entry === undefined) continue
      entry.item.status = 'completed'
      if (entry.item.type === 'message') {
        const text = typeof chunk.block?.text === 'string' ? chunk.block.text : entry.text
        entry.item.content = [{ type: 'output_text', text, annotations: [] }]
      } else {
        if (typeof chunk.block?.arguments === 'string') entry.item.arguments = chunk.block.arguments
        if (typeof chunk.block?.name === 'string') entry.item.name = chunk.block.name
        if (typeof chunk.block?.id === 'string') entry.item.call_id = chunk.block.id
      }
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      failure = chunk.reason.failure
    }
  }

  if (failure !== undefined) {
    return {
      ...responseBase(responseId, model, 'failed'),
      output,
      error: { code: failure.code ?? 'SERVER', message: failure.message ?? 'upstream error' },
    }
  }

  return {
    ...responseBase(responseId, model, 'completed'),
    output,
    ...(usage !== undefined
      ? {
          usage: {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          },
        }
      : {}),
  }
}
