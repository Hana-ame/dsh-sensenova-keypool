/**
 * The SenseNova key-pool adapter.
 *
 * Adapter contract (the harness validates structurally, not by `instanceof`):
 *   providerInfo / providerRetryPolicy / imageRequestPricing / listModels /
 *   resolveModel / prepareCall / stream
 *
 * Key policy:
 *   - one key per session, decided on the session's first request;
 *   - `model@alias` is accepted as a hidden override and rebinds that session;
 *     the picker never advertises key-qualified model rows;
 *   - mode=auto round-robins new sessions, mode=manual uses `defaultKey`;
 *   - retries reuse the same key. A 429/401 is this session's failure, never
 *     a reason to spend another key.
 *
 * @module src/adapter
 */

import {
  ROUTE,
  ROUTE_LABEL,
  catalogRows,
  parseModelId,
  resolveModelInfo,
} from './catalog.js'
import { createKeyPool, createSessionKeyStore } from './keypool.js'
import { toChatRequest } from './messages.js'
import { postChat, readJson, UpstreamError } from './upstream.js'
import { jsonToChunks, parseSseStream } from './stream.js'
import { validateSettings } from './settings.js'

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms))

function failureOf(error) {
  if (error instanceof UpstreamError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.retryAfterMs !== undefined ? { providerRetryAfterMs: error.retryAfterMs } : {}),
    }
  }
  return { code: 'TRANSPORT', message: String(error?.message ?? error) }
}

export class SensenovaKeyPoolAdapter {
  /**
   * @param {object} deps
   * @param {{current: () => object}} deps.settingsSource
   * @param {(message: string) => void} [deps.warn]
   * @param {Function} [deps.fetchImpl]
   * @param {(ms: number) => Promise<void>} [deps.sleep]
   * @param {() => object | undefined} [deps.resolveAttachments] - durable attachment store, for image input.
   * @param {(attachments: object, ref: object) => object | undefined} [deps.resolveImageAccess]
   */
  constructor(deps) {
    this.deps = deps
    this.pool = null
    this.store = null
    this.fingerprint = ''
  }

  _ensure() {
    const settings = this.deps.settingsSource.current()
    const problems = validateSettings(settings)
    if (problems.length > 0) this.deps.warn?.(`configuration: ${problems.join('; ')}`)
    const fingerprint = JSON.stringify({
      keys: settings.keys,
      mode: settings.mode,
      defaultKey: settings.defaultKey,
      statePath: settings.statePath,
    })
    if (this.pool === null || this.store === null || this.fingerprint !== fingerprint) {
      this.pool = createKeyPool(settings.keys.filter(entry => entry.enabled !== false))
      this.store = createSessionKeyStore({
        statePath: settings.statePath,
        mode: settings.mode,
        defaultKey: settings.defaultKey,
        pool: this.pool,
        warn: this.deps.warn,
      })
      this.fingerprint = fingerprint
    }
    return { settings, pool: this.pool, store: this.store }
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /**
   * The adapter owns retries so a retry reuses the key pinned to the session
   * and a 429 never spends another pool entry. The scope (`retryableCodes`),
   * count (`maxRetries`) and backoff cap (`retryMaxDelayMs`) all come from
   * `settings.json`; the harness-level retry plugin is kept inert with
   * `maxRetries: 0` so it cannot replay the same step on top.
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: Object.freeze([]),
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    })
  }

  /** The route declares no provider-side image pricing (text-only projection). */
  imageRequestPricing() {
    return undefined
  }

  async listModels(provider) {
    const { settings } = this._ensure()
    return catalogRows(provider ?? ROUTE, settings.models)
  }

  async resolveModel(provider, model) {
    const { settings } = this._ensure()
    return resolveModelInfo(provider ?? ROUTE, model, settings.models)
  }

  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options),
    }
  }

  /**
   * Resolve the key for one request without dispatching. The local gateway
   * uses this too, so both surfaces share the same session binding.
   *
   * @param {{sessionId?: string, model?: string, alias?: string | null}} request
   * @returns {{alias: string, key: string, reason: string, settings: object, pool: object, store: object}}
   */
  pickKey({ sessionId, model, alias } = {}) {
    const { settings, pool, store } = this._ensure()
    const parsed = alias === undefined || alias === null ? parseModelId(model ?? settings.defaultModel) : { alias }
    const picked = store.assign(sessionId, parsed.alias)
    return { ...picked, settings, pool, store }
  }

  /** Default model id for the gateway when the request omits one. */
  defaultModel() {
    return this._ensure().settings.defaultModel
  }

  /** Diagnostic snapshot for the local status endpoint. */
  status() {
    const { settings, store } = this._ensure()
    return {
      route: ROUTE,
      baseURL: settings.baseURL,
      mode: settings.mode,
      defaultModel: settings.defaultModel,
      models: settings.models.map(model => model.id),
      ...store.snapshot(),
    }
  }

  /**
   * One turn. The chosen key is fixed for the whole generator.
   *
   * @param {object} options - GenerateOptions
   * @returns {AsyncGenerator<object>}
   */
  async *stream(options) {
    const signal = options?.signal
    let picked
    try {
      picked = this.pickKey({
        sessionId: options?.sessionId === undefined || options?.sessionId === null ? undefined : String(options.sessionId),
        model: options?.model,
      })
    } catch (error) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'CONFIG', message: `sensenova-keypool: ${error?.message ?? error}` },
        },
      }
      return
    }

    const { settings } = picked
    const attachments = typeof this.deps.resolveAttachments === 'function' ? this.deps.resolveAttachments() : undefined
    const { body } = await toChatRequest(
      { ...options, model: options?.model ?? settings.defaultModel },
      {
        attachments,
        resolveImageAccess: this.deps.resolveImageAccess,
        signal,
        maxRequestImageBytes: settings.maxRequestImageBytes,
      },
    )
    const maxRetries = settings.maxRetries
    const sleep = this.deps.sleep ?? sleepDefault

    let response = null
    let lastError = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        response = await postChat({
          baseURL: settings.baseURL,
          chatPath: settings.chatPath,
          key: picked.key,
          body,
          signal,
          timeoutMs: settings.timeoutMs,
          fetchImpl: this.deps.fetchImpl,
        })
        break
      } catch (error) {
        lastError = error
        // The configured retry scope decides, not the boolean baked into the
        // error: RATE_LIMIT (HTTP 429) is in the default scope, so a rate-limit
        // window is retried up to `maxRetries` with the capped backoff below.
        const retryable = error instanceof UpstreamError && settings.retryableCodes.includes(error.code)
        if (signal?.aborted === true || !retryable || attempt >= maxRetries) break
        // A 429 often carries Retry-After; honour it but keep the configured
        // ceiling so a malicious/oversized header cannot stall the request.
        const retryAfterMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
          ? error.retryAfterMs
          : settings.retryBaseDelayMs * 2 ** attempt
        const delay = Math.min(settings.retryMaxDelayMs, retryAfterMs)
        this.deps.warn?.(
          `sensenova-keypool: ${picked.alias} retry ${attempt + 1}/${maxRetries} in ${delay} ms (${error.code}): ${error.message}`,
        )
        await sleep(delay)
        if (signal?.aborted === true) break
      }
    }

    if (response === null) {
      yield { type: 'finish', reason: { kind: 'error', failure: failureOf(lastError) } }
      return
    }

    try {
      const contentType = String(response.headers?.get?.('content-type') ?? '')
      if (contentType.includes('application/json')) {
        const json = await readJson(response)
        yield* jsonToChunks(json)
        return
      }
      if (response.body === null || response.body === undefined) {
        const json = await readJson(response)
        yield* jsonToChunks(json)
        return
      }
      yield* parseSseStream(response.body, { signal })
    } catch (error) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: failureOf(error) },
      }
    }
  }
}
