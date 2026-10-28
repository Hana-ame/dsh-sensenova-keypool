/**
 * Local OpenAI-compatible gateway.
 *
 * Mounted under `gateway.path` (default `/api/sensenova-keypool/v1`) and meant
 * for tools that cannot register a DSH plugin adapter — most importantly
 * Codex, which speaks the Responses API:
 *
 *   GET  {base}/models
 *   POST {base}/chat/completions   OpenAI Chat Completions
 *   POST {base}/responses          OpenAI Responses (Codex)
 *   GET  {base}/../status          masked key/session diagnostics
 *
 * Key choice uses the same session store as the in-process adapter. A client
 * can pin one key with the `x-sensenova-key: k2` header, and can name its
 * session with `x-sensenova-session`. Codex should set both in its HTTP
 * headers so every Codex process keeps one key across requests.
 *
 * @module src/gateway
 */

import { timingSafeEqual } from 'node:crypto'
import { postChat, readJson, UpstreamError } from './upstream.js'
import { parseSseStream } from './stream.js'
import { collectResponse, encodeResponseEvents, responsesToChat } from './responses.js'

const MAX_BODY_BYTES = 32 * 1024 * 1024

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-sensenova-key, x-sensenova-key-alias, x-sensenova-session, x-sensenova-client',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(),
    ...extraHeaders,
  })
  res.end(body)
}

function sendError(res, status, message, code = 'BAD_REQUEST') {
  sendJson(res, status, { error: { message, type: 'invalid_request_error', code } })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 32 MiB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function header(req, name) {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function checkToken(req, token) {
  if (!token) return true
  const authorization = String(header(req, 'authorization') ?? '')
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : String(header(req, 'x-sensenova-token') ?? '')
  if (supplied === '') return false
  const expected = Buffer.from(token)
  const actual = Buffer.from(supplied)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

function sessionFrom(req, body) {
  return String(
    header(req, 'x-sensenova-session') ??
      header(req, 'x-sensenova-client') ??
      body?.session_id ??
      body?.metadata?.session_id ??
      'local-default',
  )
}

function modelFrom(body, fallback) {
  return String(body?.model ?? fallback)
}

function keyAliasFrom(req) {
  const raw = header(req, 'x-sensenova-key') ?? header(req, 'x-sensenova-key-alias')
  return raw === undefined ? null : String(raw).trim() || null
}

function errorPayload(error) {
  if (error instanceof UpstreamError) {
    return {
      status: error.status !== undefined && error.status >= 400 && error.status <= 599 ? error.status : 502,
      body: { error: { message: error.message, type: 'upstream_error', code: error.code } },
    }
  }
  return {
    status: 500,
    body: { error: { message: String(error?.message ?? error), type: 'server_error', code: 'SERVER' } },
  }
}

/**
 * Build the HTTP handler. The caller owns route registration; this only owns
 * the response lifecycle for paths under the gateway prefix.
 *
 * @param {object} deps
 * @param {object} deps.adapter
 * @param {(message: string) => void} [deps.warn]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createGateway({ adapter, warn = () => {} }) {
  return async function gateway(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const settings = adapter._ensure().settings
    const base = settings.gateway.path
    const suffix = pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname === base ? '/' : null
    if (suffix === null || suffix === '') {
      sendError(res, 404, `unknown gateway path ${pathname}`, 'NOT_FOUND')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }

    if (!checkToken(req, settings.gateway.token)) {
      sendError(res, 401, 'invalid gateway token', 'INVALID_CREDENTIAL')
      return
    }

    try {
      if (req.method === 'GET' && suffix === '/models') {
        const models = await adapter.listModels(undefined)
        sendJson(res, 200, {
          object: 'list',
          data: models.map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'sensenova',
          })),
        })
        return
      }

      if (req.method === 'GET' && suffix === '/status') {
        sendJson(res, 200, adapter.status())
        return
      }

      if (req.method === 'POST' && suffix === '/chat/completions') {
        await handleChat(req, res, adapter, warn)
        return
      }

      if (req.method === 'POST' && suffix === '/responses') {
        await handleResponses(req, res, adapter, warn)
        return
      }

      sendError(res, 404, `unknown gateway path ${pathname}`, 'NOT_FOUND')
    } catch (error) {
      const { status, body } = errorPayload(error)
      if (!res.headersSent) sendJson(res, status, body)
      else res.end()
    }
  }
}

async function handleChat(req, res, adapter, warn) {
  const body = await readBody(req)
  const settings = adapter._ensure().settings
  const model = modelFrom(body, settings.defaultModel)
  const picked = adapter.pickKey({
    sessionId: sessionFrom(req, body),
    model,
    alias: keyAliasFrom(req),
  })

  const upstreamBody = { ...body, model: parsedModelId(model) }
  const stream = body.stream === true
  upstreamBody.stream = stream

  const response = await postChat({
    baseURL: settings.baseURL,
    chatPath: settings.chatPath,
    key: picked.key,
    body: upstreamBody,
    timeoutMs: settings.timeoutMs,
  })

  warn(`chat request model=${parsedModelId(model)} key=${picked.alias}`)

  if (!stream) {
    const json = await readJson(response)
    sendJson(res, 200, json, { 'x-sensenova-key-alias': picked.alias })
    return
  }

  const contentType = String(response.headers?.get?.('content-type') ?? '')
  if (!contentType.includes('text/event-stream') || response.body === null) {
    const json = await readJson(response)
    sendJson(res, 200, json, { 'x-sensenova-key-alias': picked.alias })
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-sensenova-key-alias': picked.alias,
    ...corsHeaders(),
  })
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  } catch (error) {
    warn(`chat stream failed: ${error?.message ?? error}`)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
    res.end()
  }
}

async function handleResponses(req, res, adapter, warn) {
  const body = await readBody(req)
  const settings = adapter._ensure().settings
  const converted = responsesToChat(body, settings.defaultModel)
  const picked = adapter.pickKey({
    sessionId: sessionFrom(req, body),
    model: converted.model,
    alias: keyAliasFrom(req),
  })

  // Always ask upstream for SSE so both the streaming and collected forms
  // share one parser.
  const upstreamBody = { ...converted.body, stream: true }
  const response = await postChat({
    baseURL: settings.baseURL,
    chatPath: settings.chatPath,
    key: picked.key,
    body: upstreamBody,
    timeoutMs: settings.timeoutMs,
  })

  warn(`responses request model=${converted.model} key=${picked.alias}`)

  const contentType = String(response.headers?.get?.('content-type') ?? '')
  let chunks
  if (contentType.includes('text/event-stream') && response.body !== null) {
    chunks = parseSseStream(response.body)
  } else {
    const json = await readJson(response)
    chunks = (async function* () {
      const { jsonToChunks } = await import('./stream.js')
      yield* jsonToChunks(json)
    })()
  }

  if (converted.stream !== true) {
    const payload = await collectResponse(chunks, { model: converted.model })
    sendJson(res, 200, payload, { 'x-sensenova-key-alias': picked.alias })
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-sensenova-key-alias': picked.alias,
    ...corsHeaders(),
  })
  try {
    for await (const event of encodeResponseEvents(chunks, { model: converted.model })) {
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
    }
  } catch (error) {
    const payload = {
      type: 'response.failed',
      response: {
        id: `resp_${Date.now().toString(36)}`,
        object: 'response',
        status: 'failed',
        error: { code: 'SERVER', message: String(error?.message ?? error) },
      },
    }
    res.write(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`)
  } finally {
    res.end()
  }
}

function parsedModelId(model) {
  const at = String(model ?? '').lastIndexOf('@')
  return at < 0 ? String(model ?? '') : String(model).slice(0, at)
}
