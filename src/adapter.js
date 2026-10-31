/**
 * The SenseNova key-pool adapter.
 *
 * Adapter contract (the harness validates structurally, not by `instanceof`):
 *   providerInfo / providerRetryPolicy / imageRequestPricing / listModels /
 *   resolveModel / prepareCall / stream
 *
 * Key policy:
 *   - one key per session, decided on the session's first request;
 *   - `model@alias` pins that session to the named key; since 0.3.0 the picker
 *     advertises those rows (`perKeyModels`, default on) so every key has its
 *     own selectable model next to the round-robin/session-pinned rows;
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
import { jsonToChunks, mergeUsage, parseSseStream } from './stream.js'
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

/**
 * Classify an upstream failure into a probe-based quota state. The provider's
 * 429 vocabulary (see stream.js) is the only signal an API key can reach, so
 * the two buckets are told apart by the error body:
 *
 *   - `token plan entitlement exhausted` → hard quota wall (`quota_exhausted`);
 *   - `rps / rpm / tpm exhausted`        → transient bucket (`rate_limited`).
 *
 * @param {unknown} error
 * @returns {'healthy'|'rate_limited'|'quota_exhausted'|'invalid_credential'|'error'}
 */
export function classifyQuotaError(error) {
  if (error instanceof UpstreamError) {
    if (error.status === 401 || error.status === 403) return 'invalid_credential'
    if (error.status === 429) {
      const text = `${error.message} ${error.body ?? ''}`.toLowerCase()
      if (text.includes('token plan entitlement exhausted')) return 'quota_exhausted'
      if (/rps|rpm|tpm|rate|quota|exhausted/.test(text)) return 'rate_limited'
      return 'rate_limited'
    }
    if (error.status >= 500) return 'error'
    if (error.status === 408 || error.status === 504) return 'error'
    return 'error'
  }
  return 'error'
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
    const { settings, pool } = this._ensure()
    return catalogRows(provider ?? ROUTE, settings.models, {
      keys: pool.aliases,
      perKeyModels: settings.perKeyModels,
    })
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
      // Last probe-based quota snapshot, without re-probing. `null` until the
      // first `quota()` call (settings page auto-fetches on load).
      quota: this._quotaCache?.result ?? null,
      ...store.snapshot(),
    }
  }

  /**
   * Probe-based quota snapshot. SenseNova's OpenAI-compatible gateway
   * (`token.sensenova.cn`) exposes NO quota endpoint — only `/v1/models` and
   * `/v1/chat/completions` exist there, and the console endpoints that carry
   * real numbers (`/lite/console/v1/tokenplan/pool-usage`) are OAuth-session
   * gated. So "quota" is inferred from a minimal chat request per key and the
   * 429 vocabulary the provider returns:
   *
   *   - 200  → `healthy`            (entitlement present, not rate-throttled)
   *   - 429  `token plan entitlement exhausted` → `quota_exhausted`
   *          (hard wall: the plan's token budget is spent)
   *   - 429  `rps / rpm / tpm exhausted`        → `rate_limited`
   *          (transient bucket; key works again shortly)
   *   - 401/403                        → `invalid_credential`
   *   - anything else                  → `error`
   *
   * The probe is non-streaming and capped at `maxTokens` output tokens so it
   * costs a few tokens per key. Results are cached for `ttlMs` (60 s by
   * default) so repeated settings-page renders do not hammer the shared
   * account bucket; `force: true` re-probes immediately.
   *
   * @param {{ model?: string, maxTokens?: number, timeoutMs?: number, ttlMs?: number, force?: boolean }} [options]
   * @returns {Promise<object>} `{ ok, at, model, cacheHit, entries: [{ alias, masked, state, httpStatus?, latencyMs, message? }] }`
   */
  async quota({ model, maxTokens = 2, timeoutMs = 15_000, ttlMs = 60_000, force = false } = {}) {
    const now = Date.now()
    if (!force && this._quotaCache !== undefined && now - this._quotaCache.at < Math.max(1_000, Number(ttlMs) || 60_000)) {
      return { ...this._quotaCache.result, cacheHit: true }
    }
    const { settings, pool } = this._ensure()
    const probeModel = String(model ?? settings.defaultModel ?? '').trim() || 'deepseek-flash'
    const entries = []
    // Probe keys sequentially with a short stagger: every key of the same
    // account shares the provider's rate bucket, so a simultaneous burst can
    // trip rps and mislabel a merely-throttled key as exhausted.
    for (let index = 0; index < pool.entries.length; index += 1) {
      const entry = pool.entries[index]
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 150))
      const started = Date.now()
      const row = { alias: entry.alias, masked: entry.masked, state: 'error', latencyMs: 0 }
      try {
        const response = await postChat({
          baseURL: settings.baseURL,
          chatPath: settings.chatPath,
          key: entry.key,
          body: {
            model: probeModel,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: Math.max(1, Number(maxTokens) || 2),
            stream: false,
          },
          timeoutMs,
          fetchImpl: this.deps.fetchImpl,
        })
        row.state = 'healthy'
        row.httpStatus = Number(response?.status ?? 200)
        // Drain the body so the connection is reused; the JSON answer is not
        // needed to classify, and `readJson` would throw on a stream that a
        // provider closes early.
        try { await response.text() } catch { /* non-fatal */ }
      } catch (error) {
        row.state = classifyQuotaError(error)
        row.httpStatus = error instanceof UpstreamError ? error.status : undefined
        row.message = String(error?.message ?? error).slice(0, 300)
      } finally {
        row.latencyMs = Date.now() - started
        entries.push(row)
      }
    }
    const result = {
      ok: true,
      at: new Date(now).toISOString(),
      model: probeModel,
      cacheHit: false,
      entries,
    }
    this._quotaCache = { at: now, result }
    return result
  }

  /**
   * One turn, with automatic continuation when SenseNova truncates the answer
   * at the request output cap (`finish_reason: "length"` → `max-tokens`).
   *
   * The harness ends a step the moment its stream yields a `max-tokens`
   * finish — there is no built-in "keep going". This adapter therefore loops
   * itself: after a truncated round it feeds the partial answer back as an
   * assistant message plus a short "continue" user message, re-dispatches with
   * the same session-pinned key, and streams the continuation as fresh blocks
   * (`startIndex` offset keeps block indexes unique inside one turn).
   *
   * Truncation is not taken on faith from the reason string alone: a round
   * whose usage consumed the whole requested output cap is treated as
   * truncated even when the provider reports `stop`, because some SenseNova
   * backends cut the answer without saying `length`. When that round's
   * input+output already fill the model context window, a continuation cannot
   * fit, so the turn ends with a `CONTEXT_WINDOW_EXCEEDED` failure instead of a
   * plain truncation: the harness compacts the session and retries the step,
   * which is what keeps the agent flow alive for long conversations. A
   * continuation request rejected as an invalid/oversized request is
   * classified the same way.
   *
   * The loop stops on any of: a natural `stop`/`tool-calls` finish, an error,
   * a tool-call being produced (continuing a half-built call would corrupt
   * it), the configured `autoContinueRounds` cap, or caller abort. Exactly one
   * merged `usage` chunk and one final `finish` chunk are emitted for the whole
   * turn, because the harness reads only the last usage/finish of a stream.
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
    const { body: baseBody } = await toChatRequest(
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

    const autoContinue = settings.autoContinue !== false
    const maxRounds = Number.isSafeInteger(settings.autoContinueRounds) && settings.autoContinueRounds >= 0
      ? settings.autoContinueRounds
      : 0
    const continuePrompt = String(settings.autoContinuePrompt ?? '继续').trim() || '继续'

    // One dispatch with the same retry scope as before. Each continuation round
    // is a fresh HTTP request that reuses the session's key.
    const dispatch = async body => {
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
          const retryable = error instanceof UpstreamError && settings.retryableCodes.includes(error.code)
          if (signal?.aborted === true || !retryable || attempt >= maxRetries) break
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
      return { response, lastError }
    }

    const fail = reason => this.deps.warn?.(`sensenova-keypool: ${picked.alias} ${reason}`)

    // Output cap and context window let one round be classified as truncated
    // even when the provider does not report `finish_reason: "length"`:
    //   - `capSaturated`: the round consumed exactly the cap we requested, so
    //     the answer was cut by the output limit whatever the reason string says.
    //   - `nearContextLimit`: input+output already fill the model window, so a
    //     continuation request could only be rejected; the harness must compact
    //     first (CONTEXT_WINDOW_EXCEEDED → compaction retry, i.e. the agent loop
    //     continues instead of ending the turn on a truncated answer).
    const requestMaxTokens = Number.isSafeInteger(baseBody.max_tokens) && baseBody.max_tokens > 0
      ? baseBody.max_tokens
      : undefined
    let contextWindow
    try {
      const info = resolveModelInfo(ROUTE, options?.model ?? settings.defaultModel, settings.models)
      const value = Number(info?.context?.contextWindow)
      if (Number.isFinite(value) && value > 0) contextWindow = value
    } catch {
      contextWindow = undefined
    }
    const nearContextLimit = usage => {
      if (contextWindow === undefined || usage === undefined || usage === null) return false
      const input = Number(usage.inputTokens ?? 0)
      const output = Number(usage.outputTokens ?? 0)
      if (!Number.isFinite(input) || !Number.isFinite(output)) return false
      const slack = Math.min(1024, Math.floor(contextWindow * 0.02))
      return input + output >= contextWindow - slack
    }
    const capSaturated = usage => {
      if (requestMaxTokens === undefined || usage === undefined || usage === null) return false
      const output = Number(usage.outputTokens ?? 0)
      return Number.isFinite(output) && output >= requestMaxTokens
    }
    const isTruncatedRound = (roundFinish, roundUsage) => {
      if (roundFinish?.kind === 'max-tokens') return true
      // A provider may stop without saying `length` while still consuming the
      // whole cap; the token count is stronger evidence than the reason string.
      return capSaturated(roundUsage) && roundFinish?.kind !== 'tool-calls'
    }
    const contextOverflowFailure = (usage, detail) => {
      const counts = usage === undefined
        ? ''
        : ` (input ${Number(usage.inputTokens ?? 0)} + output ${Number(usage.outputTokens ?? 0)} tokens)`
      const window = contextWindow === undefined ? 'the model context window' : `the ${contextWindow}-token context window`
      return {
        kind: 'error',
        failure: {
          code: 'CONTEXT_WINDOW_EXCEEDED',
          message:
            `sensenova-keypool: response truncated at ${window}${counts}` +
            `${detail === undefined || detail === '' ? '' : `: ${detail}`}` +
            '; compaction is required to continue',
        },
      }
    }

    let messages = baseBody.messages
    let startIndex = 0 // block-index offset: continuation blocks must not reuse harness indexes
    let totalUsage
    let streamedAnyText = false // text/reasoning produced across all rounds of this turn
    let lastRoundUsage

    for (let round = 0; ; round += 1) {
      const body = round === 0 ? baseBody : { ...baseBody, messages }
      const { response, lastError } = await dispatch(body)

      if (response === null) {
        const failure = failureOf(lastError)
        if (round > 0 && streamedAnyText) {
          // The continuation request failed. A rejected (invalid/oversized)
          // request means the grown prompt no longer fits: report a context
          // overflow so the harness compacts and retries this step, instead of
          // silently committing a truncated answer as `stop`.
          if (failure.code === 'BAD_REQUEST' || failure.code === 'INVALID_REQUEST') {
            fail(`continuation rejected (${failure.code}), treating as context overflow: ${failure.message}`)
            if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
            yield { type: 'finish', reason: contextOverflowFailure(lastRoundUsage, failure.message) }
            return
          }
          // Any other continuation failure: commit the partial answer instead of
          // surfacing a transport error that would discard it (mirrors the
          // sawContent → stop fallback in stream.js).
          if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } else {
          yield { type: 'finish', reason: { kind: 'error', failure } }
        }
        return
      }

      const settleFailure = failure => {
        const reason = round > 0 && streamedAnyText
          ? { kind: 'stop' }
          : { kind: 'error', failure }
        return reason
      }

      let chunks
      try {
        const contentType = String(response.headers?.get?.('content-type') ?? '')
        if (contentType.includes('application/json')) {
          const json = await readJson(response)
          chunks = jsonToChunks(json, { startIndex })
        } else if (response.body === null || response.body === undefined) {
          const json = await readJson(response)
          chunks = jsonToChunks(json, { startIndex })
        } else {
          chunks = parseSseStream(response.body, { signal, startIndex })
        }
      } catch (error) {
        const reason = settleFailure(failureOf(error))
        if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason }
        return
      }

      let roundFinish = null
      let roundUsage
      let roundToolCall = false
      let roundBlocks = 0
      let roundText = ''
      let roundReasoning = ''
      try {
        for await (const chunk of chunks) {
          if (chunk.type === 'block-start') {
            roundBlocks += 1
            yield chunk
          } else if (chunk.type === 'block-end') {
            if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') roundText += chunk.block.text
            else if (chunk.block?.type === 'reasoning' && typeof chunk.block.text === 'string') roundReasoning += chunk.block.text
            else if (chunk.block?.type === 'tool-call') roundToolCall = true
            yield chunk
          } else if (chunk.type === 'usage') {
            roundUsage = mergeUsage(roundUsage, chunk.usage)
          } else if (chunk.type === 'finish') {
            roundFinish = chunk.reason
          } else {
            yield chunk
          }
        }
      } catch (error) {
        // The per-round parser already degrades mid-stream errors with content to
        // `stop`; a hard throw here keeps the same policy.
        const reason = settleFailure(failureOf(error))
        if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason }
        return
      }

      totalUsage = mergeUsage(totalUsage, roundUsage)
      lastRoundUsage = roundUsage
      if (roundText !== '' || roundReasoning !== '') streamedAnyText = true
      startIndex += roundBlocks

      const truncated = isTruncatedRound(roundFinish, roundUsage)
      if (truncated && roundFinish?.kind !== 'max-tokens') {
        // Visible in the Host log: the provider cut the answer without saying
        // `length`, and only the token accounting caught it.
        fail(`truncation inferred from cap saturation (finish=${roundFinish?.kind ?? 'none'}, output=${roundUsage?.outputTokens ?? '?'}/${requestMaxTokens ?? '?'})`)
      }
      if (truncated && nearContextLimit(roundUsage)) {
        // The answer was cut because the prompt already fills the window:
        // appending a continuation request would only grow an unsendable body.
        // Surface a context overflow so the harness compacts and retries the
        // step, which is the only way the agent loop can keep going here.
        fail(`context window full at truncation (input=${roundUsage?.inputTokens ?? '?'} + output=${roundUsage?.outputTokens ?? '?'} of ${contextWindow ?? '?'}); handing off to compaction`)
        if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: contextOverflowFailure(roundUsage) }
        return
      }

      const canContinue = autoContinue
        && truncated
        && round < maxRounds
        && !roundToolCall
        && streamedAnyText
        && signal?.aborted !== true
      if (!canContinue) {
        let finalReason
        if (roundFinish?.kind === 'error' && streamedAnyText) finalReason = { kind: 'stop' }
        else if (truncated) finalReason = { kind: 'max-tokens' }
        else finalReason = roundFinish ?? { kind: 'stop' }
        if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: finalReason }
        return
      }

      fail(`auto-continue ${round + 1}/${maxRounds} after max-token truncation`)

      // Feed the partial answer back so the model continues from exactly where
      // it stopped; reasoning content keeps thinking models coherent.
      const assistant = { role: 'assistant', content: roundText === '' ? null : roundText }
      if (roundReasoning !== '') assistant.reasoning_content = roundReasoning
      messages = [...messages, assistant, { role: 'user', content: continuePrompt }]
    }
  }

  /**
   * 设置页「测试」按钮：用池里的 key 给指定模型发一条 `hi`，返回耗时与回复。
   *
   * 走适配器自己的 `stream()`（而不是另拼一路 HTTP），所以测的是**真实链路**：
   * key 选择/轮询、请求体形状、SSE 解析、限流重试全部参与。但不传 sessionId，
   * `pickKey` 走匿名分支——不会在状态文件里给测试会话留下 key 绑定。
   *
   * @param {{ model?: string, maxTokens?: number, timeoutMs?: number }} [options]
   * @returns {Promise<object>} `{ ok, model, key, latencyMs, text, reasoning?, usage?, error? }`
   */
  async testModel({ model, maxTokens = 512, timeoutMs = 30_000 } = {}) {
    const started = Date.now()
    const requested = String(model ?? '').trim()
    const outcome = { ok: false, model: requested, key: '', latencyMs: 0, text: '' }
    if (requested === '') {
      outcome.latencyMs = 0
      outcome.error = { code: 'CONFIG', message: 'model id is empty' }
      return outcome
    }
    let picked
    try {
      picked = this.pickKey({ model: requested })
    } catch (error) {
      outcome.error = { code: 'CONFIG', message: String(error?.message ?? error) }
      return outcome
    }
    outcome.key = picked.alias
    outcome.model = parseModelId(requested).modelId

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 30_000))
    try {
      for await (const chunk of this.stream({
        provider: ROUTE,
        model: requested,
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : 512,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') outcome.text += chunk.text
        else if (chunk.type === 'reasoning-delta') outcome.reasoning = (outcome.reasoning ?? '') + chunk.text
        else if (chunk.type === 'usage') outcome.usage = chunk.usage
        else if (chunk.type === 'finish') {
          outcome.ok = chunk.reason?.kind !== 'error' && chunk.reason?.kind !== 'aborted'
          if (!outcome.ok) outcome.error = chunk.reason?.failure ?? { code: 'UNKNOWN', message: 'stream failed' }
        }
      }
    } catch (error) {
      outcome.ok = false
      outcome.error = { code: error?.code ?? 'TEST_FAILED', message: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
    outcome.latencyMs = Date.now() - started
    if (outcome.ok && outcome.text.trim() === '') {
      outcome.ok = false
      outcome.error = { code: 'EMPTY', message: '模型返回了空文本' }
    }
    return outcome
  }
}
