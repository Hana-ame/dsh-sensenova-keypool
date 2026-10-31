/**
 * Settings-page backend for the key pool.
 *
 * The browser half writes keys through this route rather than through a
 * generic settings namespace: the key list is an array of secrets, and the
 * route can return aliases plus masked values only. Writes preserve every
 * other `settings.json` field and are restricted to loopback callers.
 *
 *   GET  /api/sensenova-keypool/admin/config
 *   POST /api/sensenova-keypool/admin/config
 *
 * @module src/admin
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, normalizeKeys, normalizeModels, normalizeRetryableCodes } from './settings.js'

const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message, code = 'BAD_REQUEST') {
  sendJson(res, status, { error: { message, code } })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

function header(req, name) {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readSettingsFile(filename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    throw new Error('settings.json must contain a JSON object')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`cannot read settings.json: ${error?.message ?? error}`)
  }
}

function writeSettingsFile(filename, settings) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filename)
}

function retryConfig(settings) {
  const maxRetries = Number.isInteger(settings.maxRetries) ? settings.maxRetries : DEFAULTS.maxRetries
  const retryBaseDelayMs = Number(settings.retryBaseDelayMs) > 0 ? Number(settings.retryBaseDelayMs) : DEFAULTS.retryBaseDelayMs
  const retryMaxDelayMs = Number(settings.retryMaxDelayMs) > 0 ? Number(settings.retryMaxDelayMs) : DEFAULTS.retryMaxDelayMs
  return {
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs: Math.max(retryBaseDelayMs, retryMaxDelayMs),
    retryableCodes: normalizeRetryableCodes(settings.retryableCodes),
  }
}

function autoContinueConfig(settings) {
  const autoContinue = settings.autoContinue !== false
  const rounds = Number.isSafeInteger(settings.autoContinueRounds) && settings.autoContinueRounds >= 0
    ? settings.autoContinueRounds
    : DEFAULTS.autoContinueRounds
  const prompt = String(settings.autoContinuePrompt ?? DEFAULTS.autoContinuePrompt).trim() || DEFAULTS.autoContinuePrompt
  return { autoContinue, autoContinueRounds: rounds, autoContinuePrompt: prompt }
}

function publicConfig(filename, settings, adapter) {
  const keys = normalizeKeys(settings.keys)
  const status = adapter.status()
  return {
    ok: true,
    settingsPath: filename,
    route: status.route,
    baseURL: String(settings.baseURL ?? DEFAULTS.baseURL),
    mode: settings.mode === 'manual' ? 'manual' : 'auto',
    defaultKey: String(settings.defaultKey ?? 'k1'),
    defaultModel: String(settings.defaultModel ?? DEFAULTS.defaultModel),
    models: normalizeModels(settings.models).map(({ id, name, description, contextWindow, maxOutput, reasoning, inputModalities }) => ({
      id,
      name,
      description,
      contextWindow,
      maxOutput,
      reasoning,
      inputModalities,
    })),
    keys: keys.map(entry => ({ alias: entry.alias, masked: entry.masked, enabled: entry.enabled !== false })),
    perKeyModels: settings.perKeyModels !== false,
    poolSize: status.poolSize,
    ...retryConfig(settings),
    ...autoContinueConfig(settings),
  }
}

/**
 * Build the admin handler. The caller owns route registration.
 *
 * @param {object} deps
 * @param {string} deps.settingsPath
 * @param {object} deps.adapter
 * @param {(settings: object) => void} [deps.onSaved]
 * @param {(message: string) => void} [deps.warn]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createAdmin({ settingsPath, adapter, onSaved = () => {}, warn = () => {} }) {
  const base = '/api/sensenova-keypool/admin'

  return async function admin(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const suffix = pathname === base ? '/' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null
    if (suffix === null) {
      sendError(res, 404, `unknown admin path ${pathname}`, 'NOT_FOUND')
      return
    }

    if (req.method === 'OPTIONS') {
      // Same-origin only: no CORS grant, so a cross-origin JSON request
      // fails its preflight instead of reaching this handler.
      res.writeHead(204)
      res.end()
      return
    }

    // Writing key material is a local operation. A non-loopback listener must
    // be fronted by a tunnel or reverse proxy that supplies its own access
    // control; never expose this route directly.
    if (!isLoopback(req)) {
      sendError(res, 403, 'sensenova-keypool admin is loopback-only', 'FORBIDDEN')
      return
    }

    try {
      if (req.method === 'GET' && (suffix === '/' || suffix === '/config')) {
        const settings = readSettingsFile(settingsPath)
        sendJson(res, 200, publicConfig(settingsPath, settings, adapter))
        return
      }

      if (req.method === 'POST' && suffix === '/config') {
        // A cross-origin HTML form can send text/plain without a preflight.
        // Requiring JSON forces a CORS preflight, which this handler never
        // grants, so only same-origin UI code reaches the write path.
        const contentType = String(header(req, 'content-type') ?? '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          throw new Error('content-type must be application/json')
        }
        const body = await readBody(req)
        if (!Array.isArray(body.keys)) throw new Error('keys must be an array')
        const current = readSettingsFile(settingsPath)
        const currentKeys = normalizeKeys(current.keys)
        const existing = new Map(currentKeys.map(entry => [entry.alias, entry]))
        // A row with an empty key field means "keep this key's existing
        // secret". `originalAlias` makes that survive a rename: the browser
        // sends the alias the row was loaded with, not just the new one.
        const submitted = body.keys.map(entry => {
          if (entry === null || typeof entry !== 'object') return entry
          const alias = String(entry.alias ?? '').trim()
          const originalAlias = String(entry.originalAlias ?? alias).trim()
          const key = String(entry.key ?? '').trim()
          const prior = existing.get(alias) ?? existing.get(originalAlias)
          const enabled = entry.enabled === undefined ? prior?.enabled !== false : entry.enabled !== false
          if (key === '' && prior !== undefined) return { ...entry, alias, key: prior.key, enabled }
          return { ...entry, alias, enabled }
        })
        const keys = normalizeKeys(submitted)
        const mode = body.mode === 'manual' ? 'manual' : body.mode === 'auto' ? 'auto' : current.mode === 'manual' ? 'manual' : 'auto'
        const enabledKeys = keys.filter(entry => entry.enabled !== false)
        let defaultKey = String(body.defaultKey ?? current.defaultKey ?? (enabledKeys[0]?.alias ?? keys[0]?.alias ?? 'k1'))
        if (enabledKeys.length > 0 && !enabledKeys.some(entry => entry.alias === defaultKey)) defaultKey = enabledKeys[0].alias
        const previousRetry = retryConfig(current)
        const maxRetries = body.maxRetries === undefined ? previousRetry.maxRetries : Number(body.maxRetries)
        if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 1_000_000) {
          throw new Error('maxRetries must be an integer between 0 and 1000000')
        }
        const retryBaseDelayMs = body.retryBaseDelayMs === undefined ? previousRetry.retryBaseDelayMs : Number(body.retryBaseDelayMs)
        const retryMaxDelayMs = body.retryMaxDelayMs === undefined ? previousRetry.retryMaxDelayMs : Number(body.retryMaxDelayMs)
        if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs < 1 || retryBaseDelayMs > 600_000) {
          throw new Error('retryBaseDelayMs must be an integer between 1 and 600000')
        }
        if (!Number.isSafeInteger(retryMaxDelayMs) || retryMaxDelayMs < retryBaseDelayMs || retryMaxDelayMs > 600_000) {
          throw new Error('retryMaxDelayMs must be an integer between retryBaseDelayMs and 600000')
        }
        const retryableCodes = body.retryableCodes === undefined
          ? previousRetry.retryableCodes
          : normalizeRetryableCodes(body.retryableCodes)
        // Auto-continue settings: optional on the wire, validated when present.
        const previousAuto = autoContinueConfig(current)
        const autoContinue = body.autoContinue === undefined
          ? previousAuto.autoContinue
          : body.autoContinue === true || body.autoContinue === 'true' || body.autoContinue === '1'
        const autoContinueRounds = body.autoContinueRounds === undefined
          ? previousAuto.autoContinueRounds
          : Number(body.autoContinueRounds)
        if (!Number.isSafeInteger(autoContinueRounds) || autoContinueRounds < 0 || autoContinueRounds > 100) {
          throw new Error('autoContinueRounds must be an integer between 0 and 100')
        }
        const autoContinuePrompt = body.autoContinuePrompt === undefined
          ? previousAuto.autoContinuePrompt
          : String(body.autoContinuePrompt).trim()
        if (autoContinuePrompt === '') throw new Error('autoContinuePrompt must not be empty')
        // Per-key model rows: optional on the wire; absent keeps the current
        // value so a key-only save does not silently flip the picker layout.
        const perKeyModels = body.perKeyModels === undefined
          ? current.perKeyModels !== false
          : body.perKeyModels === true || body.perKeyModels === 'true' || body.perKeyModels === '1'
        // Key/retry saves are model-neutral: this handler only changes the
        // key pool, assignment mode and retry policy. Model selection and the
        // model catalog stay under the caller's control.
        const next = {
          ...current,
          keys: keys.map(entry => ({ alias: entry.alias, key: entry.key, enabled: entry.enabled !== false })),
          mode,
          defaultKey,
          perKeyModels,
          maxRetries,
          retryBaseDelayMs,
          retryMaxDelayMs,
          retryableCodes,
          autoContinue,
          autoContinueRounds,
          autoContinuePrompt,
        }
        // Models are explicit: a key/retry-only save leaves both the list and
        // the default model untouched. A model edit must carry a valid list
        // and a default that exists in it; nothing is auto-selected.
        if (body.models !== undefined || body.defaultModel !== undefined) {
          const models = normalizeModels(body.models === undefined ? current.models : body.models)
          const defaultModel = String(body.defaultModel ?? current.defaultModel ?? DEFAULTS.defaultModel).trim()
          if (defaultModel === '') throw new Error('defaultModel must be a non-empty model id')
          if (!models.some(model => model.id === defaultModel)) {
            throw new Error(`defaultModel "${defaultModel}" is not in the model list`)
          }
          next.models = models
          next.defaultModel = defaultModel
        }
        writeSettingsFile(settingsPath, next)
        onSaved(next)
        sendJson(res, 200, publicConfig(settingsPath, next, adapter))
        return
      }

      // Settings-page "test" button: send one `hi` through the real adapter
      // path (key selection / body shaping / SSE / retry) and report latency
      // and the reply. Runs unbound (no sessionId), so it leaves no session-key
      // binding behind.
      if (req.method === 'POST' && suffix === '/test') {
        const contentType = String(header(req, 'content-type') ?? '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          throw new Error('content-type must be application/json')
        }
        const body = await readBody(req)
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        if (model === '' || model.length > 200) {
          throw new Error('model must be a non-empty string (<= 200 chars)')
        }
        if (typeof adapter.testModel !== 'function') {
          throw new Error('adapter does not support testModel')
        }
        sendJson(res, 200, await adapter.testModel({ model, timeoutMs: 30_000 }))
        return
      }

      // Settings-page "quota" button: probe every enabled key with a minimal
      // request and report each key's inferred quota state. `force: true`
      // bypasses the cache so a manual click always re-probes; the default
      // keeps repeated settings-page renders cheap.
      if (req.method === 'POST' && suffix === '/quota') {
        const contentType = String(header(req, 'content-type') ?? '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          throw new Error('content-type must be application/json')
        }
        const body = await readBody(req)
        if (typeof adapter.quota !== 'function') {
          throw new Error('adapter does not support quota')
        }
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        sendJson(res, 200, await adapter.quota({
          ...(model !== '' && model.length <= 200 ? { model } : {}),
          force: body.force === true || body.force === 'true',
        }))
        return
      }

      sendError(res, 404, `unknown admin path ${pathname}`, 'NOT_FOUND')
    } catch (error) {
      warn(`sensenova-keypool admin: ${error?.message ?? error}`)
      if (!res.headersSent) sendError(res, 400, String(error?.message ?? error))
      else res.end()
    }
  }
}
