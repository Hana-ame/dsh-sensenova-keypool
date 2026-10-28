/**
 * One HTTP dispatch to the SenseNova OpenAI-compatible endpoint.
 *
 * The adapter owns key selection; this module owns exactly one wire attempt:
 * POST the OpenAI chat body with one Bearer key, classify non-2xx responses,
 * and hand the streaming (or JSON) response back. It never rotates keys.
 *
 * @module src/upstream
 */

export const UPSTREAM_PRODUCT = 'deepseek-harness'
export const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness'
export const SERVICE_UA = `${UPSTREAM_PRODUCT} (+${UPSTREAM_URL})`

/** A classified upstream failure. */
export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{status?: number, retryable?: boolean, body?: string, retryAfterMs?: number}} [details]
   */
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.status = details.status
    this.retryable = details.retryable ?? false
    this.body = details.body ?? ''
    this.retryAfterMs = details.retryAfterMs
  }
}

/** Classify an HTTP status into a harness failure code. */
export function classifyStatus(status) {
  if (status === 401 || status === 403) return { code: 'INVALID_CREDENTIAL', retryable: false }
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true }
  if (status === 408 || status === 504) return { code: 'TIMEOUT', retryable: true }
  if (status >= 500) return { code: 'SERVER', retryable: true }
  if (status === 404) return { code: 'NOT_FOUND', retryable: false }
  if (status >= 400) return { code: 'BAD_REQUEST', retryable: false }
  return { code: 'SERVER', retryable: false }
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after')
  if (raw === null || raw === undefined || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return undefined
}

async function summarize(response) {
  try {
    const text = await response.text()
    return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text
  } catch {
    return ''
  }
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs))
  if (signal === undefined || signal === null) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal.aborted ? signal : timeout
}

/**
 * POST one chat-completions request.
 *
 * @param {object} args
 * @param {string} args.baseURL - e.g. https://token.sensenova.cn/v1
 * @param {string} args.chatPath - e.g. /chat/completions
 * @param {string} args.key
 * @param {object} args.body - OpenAI request body
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.timeoutMs]
 * @param {Function} [args.fetchImpl]
 * @param {Record<string, string>} [args.extraHeaders]
 * @returns {Promise<Response>}
 */
export async function postChat({
  baseURL,
  chatPath,
  key,
  body,
  signal,
  timeoutMs = 120_000,
  fetchImpl,
  extraHeaders = {},
}) {
  const fetcher = typeof fetchImpl === 'function'
    ? fetchImpl
    : typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null
  if (fetcher === null) throw new UpstreamError('no fetch implementation available', 'TRANSPORT', { retryable: false })

  const url = `${String(baseURL ?? '').replace(/\/+$/, '')}${chatPath}`
  if (!/^https?:\/\//i.test(url)) {
    throw new UpstreamError(`invalid upstream URL: ${url}`, 'CONFIG', { retryable: false })
  }
  if (typeof key !== 'string' || key.trim() === '') {
    throw new UpstreamError('empty API key', 'INVALID_CREDENTIAL', { retryable: false })
  }

  const streaming = body?.stream === true
  const headers = {
    'content-type': 'application/json',
    'user-agent': SERVICE_UA,
    authorization: `Bearer ${key.trim()}`,
    accept: streaming ? 'text/event-stream' : 'application/json',
    ...extraHeaders,
  }

  let response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: combineSignals(signal, timeoutMs),
    })
  } catch (error) {
    if (signal?.aborted === true) {
      throw new UpstreamError('caller cancelled the request', 'ABORTED', { retryable: false })
    }
    const name = String(error?.name ?? '')
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new UpstreamError(`upstream timed out after ${timeoutMs} ms`, 'TIMEOUT', { retryable: true })
    }
    throw new UpstreamError(`upstream transport failed: ${error?.message ?? error}`, 'TRANSPORT', { retryable: true })
  }

  if (!response.ok) {
    const status = Number(response.status)
    const verdict = classifyStatus(status)
    const detail = await summarize(response)
    throw new UpstreamError(
      `SenseNova HTTP ${status}: ${detail || response.statusText || 'no body'}`,
      verdict.code,
      {
        status,
        retryable: verdict.retryable,
        body: detail,
        retryAfterMs: parseRetryAfter(response.headers),
      },
    )
  }

  return response
}

/**
 * Read a non-streaming JSON answer. Kept here so tests and the gateway share
 * one error path.
 *
 * @param {Response} response
 * @returns {Promise<object>}
 */
export async function readJson(response) {
  try {
    return await response.json()
  } catch (error) {
    throw new UpstreamError(`upstream returned invalid JSON: ${error?.message ?? error}`, 'SERVER', {
      status: response.status,
      retryable: false,
    })
  }
}
