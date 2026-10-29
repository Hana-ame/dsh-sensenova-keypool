/**
 * DSH request messages → OpenAI Chat Completions body.
 *
 * This module deliberately owns only the wire projection. Key choice, retry,
 * streaming and the local gateway live elsewhere, so this mapping can be
 * tested without a network or a harness.
 *
 * Image blocks (DSH `type: 'image'`) are projected to OpenAI `image_url`
 * parts with a data URL built from the durable attachment service. The DSH
 * runtime strips images to placeholder text for text-only routes, so this
 * projection only runs for models that declare image input.
 *
 * @module src/messages
 */

import { parseModelId } from './catalog.js'

/** Default per-image byte target before base64 expansion. */
export const DEFAULT_IMAGE_MAX_BYTES = 20_971_520 // 20 MiB

/** Join text blocks, ignoring non-text protocol blocks. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted: this route is text-only]')
    else if (block.type === 'file') parts.push('[file omitted: read it through the file tool]')
  }
  return parts.join('\n')
}

function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  const calls = []
  for (const block of content) {
    if (block?.type !== 'tool-call') continue
    const name = String(block.name ?? '')
    if (name === '') continue
    calls.push({
      id: String(block.id ?? ''),
      type: 'function',
      function: {
        name,
        arguments: typeof block.arguments === 'string' && block.arguments !== '' ? block.arguments : '{}',
      },
    })
  }
  return calls
}

function toolCallIdOf(message) {
  return String(
    message?.toolCallId ??
      message?.tool_call_id ??
      message?.source?.callId ??
      message?.toolCallID ??
      message?.id ??
      '',
  )
}

/**
 * Build the OpenAI `image_url` data URL for one durable image block.
 *
 * @param {object} block - DSH `type: 'image'` block.
 * @param {object} deps
 * @param {object} [deps.attachments] - durable attachment store.
 * @param {AbortSignal} [deps.signal]
 * @param {number} [deps.maxRequestImageBytes]
 * @returns {Promise<{url?: string, placeholder?: string}>}
 */
async function imageUrlOf(block, deps) {
  const attachments = deps?.attachments
  if (typeof attachments?.readImageRequest !== 'function') {
    return { placeholder: '[image omitted: attachment service unavailable]' }
  }
  const request = await attachments.readImageRequest(
    block.attachment,
    {
      width: 1024,
      height: 1024,
      maxBytes: Number(deps?.maxRequestImageBytes) > 0 ? Number(deps.maxRequestImageBytes) : DEFAULT_IMAGE_MAX_BYTES,
    },
    deps?.signal,
  )
  return {
    url: `data:${request.mediaType};base64,${Buffer.from(request.data).toString('base64')}`,
  }
}

/**
 * Project one user-message content list into OpenAI content: a plain string
 * when there are no images, otherwise a parts array with `text` and
 * `image_url` entries.
 *
 * @param {unknown} content
 * @param {object} deps - image projection dependencies (attachments/signal/maxBytes).
 * @returns {Promise<string | object[]>}
 */
async function userContentOf(content, deps) {
  if (!Array.isArray(content)) return textOf(content)
  const text = []
  const images = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      text.push(block.text)
    } else if (block.type === 'image') {
      if (block.offloaded === true) {
        text.push('[image omitted: offloaded]')
        continue
      }
      const resolved = await imageUrlOf(block, deps)
      if (resolved.url !== undefined) images.push({ type: 'image_url', image_url: { url: resolved.url } })
      else text.push(resolved.placeholder ?? '[image omitted]')
    } else if (block.type === 'file') {
      text.push('[file omitted: read it through the file tool]')
    }
  }
  if (images.length === 0) return text.join('\n')
  const parts = []
  if (text.length > 0) parts.push({ type: 'text', text: text.join('\n') })
  parts.push(...images)
  return parts
}

/**
 * Convert one GenerateOptions request into an OpenAI chat body.
 *
 * @param {object} options - DSH GenerateOptions (or an OpenAI-shaped subset).
 * @param {object} [imageDeps] - attachments store and image projection deps.
 * @returns {Promise<{body: object, modelId: string, alias: string | null}>}
 */
export async function toChatRequest(options, imageDeps = {}) {
  const { modelId, alias } = parseModelId(options?.model)
  const systemParts = []
  if (typeof options?.system === 'string' && options.system.trim() !== '') systemParts.push(options.system)
  const messages = []
  // Call ids emitted in the most recent assistant tool_calls row. A paired
  // `role: 'tool'` result whose id is not in this set is orphaned (its tool
  // call was dropped, e.g. an empty-name call) and must not be replayed.
  let liveToolCallIds = new Set()

  for (const message of options?.messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const role = String(message.role ?? '')

    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text !== '') systemParts.push(text)
      continue
    }

    if (role === 'tool') {
      const toolCallId = toolCallIdOf(message)
      if (!liveToolCallIds.has(toolCallId)) continue
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: textOf(message.content),
      })
      continue
    }

    if (role === 'assistant') {
      const text = textOf(message.content)
      const reasoning = reasoningOf(message.content)
      const toolCalls = toolCallsOf(message.content)
      const row = { role: 'assistant', content: text === '' && toolCalls.length > 0 ? null : text }
      if (reasoning !== '') row.reasoning_content = reasoning
      if (toolCalls.length > 0) row.tool_calls = toolCalls
      liveToolCallIds = new Set(toolCalls.map(call => call.id))
      messages.push(row)
      continue
    }

    // user or an unknown role: treat as user content, with images when present.
    const content = await userContentOf(message.content, imageDeps)
    messages.push({ role: role === 'user' ? 'user' : 'user', content })
  }

  if (systemParts.length > 0) messages.unshift({ role: 'system', content: systemParts.join('\n\n') })

  const body = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (typeof options?.temperature === 'number') body.temperature = options.temperature
  if (typeof options?.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (Array.isArray(options?.stop) && options.stop.length > 0) body.stop = options.stop
  if (typeof options?.reasoningEffort === 'string' && options.reasoningEffort !== '') {
    body.reasoning_effort = options.reasoningEffort
  }

  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
  }

  return { body, modelId, alias }
}
