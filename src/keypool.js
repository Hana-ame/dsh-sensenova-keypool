/**
 * Key pool and session↔key binding.
 *
 * The pool is the list of available keys (positional `k1`, `k2`, ... unless a
 * key entry names its own alias). The binding store answers one question:
 *
 *   "Which key does this session use?"
 *
 * The answer is decided once per session and persisted, so a later turn, a
 * process restart, or a title-generation call cannot silently move the session
 * to another key. Manual selection (`@k2` in the model id) always wins and
 * rebinds the session. Otherwise:
 *
 *   mode=auto   → new sessions get the next key in round-robin order
 *   mode=manual → new sessions get `defaultKey`
 *
 * This is *not* request-level failover. A 429/401 for a session stays that
 * session's failure; switching keys mid-session is exactly what the fixed-key
 * requirement forbids.
 *
 * @module src/keypool
 */

import fs from 'node:fs'
import path from 'node:path'
import { maskKey } from './catalog.js'

/**
 * Build the immutable alias→secret pool.
 *
 * @param {Array<{alias: string, key: string}>} entries
 */
export function createKeyPool(entries = []) {
  const aliasToKey = new Map()
  const keyToAlias = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.alias !== 'string' || typeof entry.key !== 'string') continue
    if (entry.alias === '' || entry.key === '') continue
    if (aliasToKey.has(entry.alias) || keyToAlias.has(entry.key)) continue
    aliasToKey.set(entry.alias, entry.key)
    keyToAlias.set(entry.key, entry.alias)
  }

  const aliases = [...aliasToKey.keys()]

  return {
    size: aliases.length,
    aliases,
    has: alias => aliasToKey.has(String(alias)),
    resolve: alias => aliasToKey.get(String(alias)) ?? null,
    aliasOf: key => keyToAlias.get(key) ?? null,
    masked: aliases.map(alias => ({ alias, masked: maskKey(aliasToKey.get(alias)) })),
    entries: aliases.map(alias => ({ alias, key: aliasToKey.get(alias), masked: maskKey(aliasToKey.get(alias)) })),
  }
}

function emptyState() {
  return { version: 1, cursor: 0, sessions: {}, updatedAt: new Date().toISOString() }
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()
    const cursor = Number.isInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : 0
    const sessions = parsed.sessions !== null && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
      ? parsed.sessions
      : {}
    return { version: 1, cursor, sessions: { ...sessions }, updatedAt: String(parsed.updatedAt ?? '') }
  } catch {
    return emptyState()
  }
}

function writeState(filePath, state) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

/**
 * Create the session-key binding store.
 *
 * @param {object} options
 * @param {string} options.statePath - where bindings/cursor persist.
 * @param {'auto'|'manual'} options.mode
 * @param {string} options.defaultKey
 * @param {ReturnType<typeof createKeyPool>} options.pool
 * @param {(message: string) => void} [options.warn]
 * @param {boolean} [options.persist=true] - tests can keep state in memory.
 */
export function createSessionKeyStore({
  statePath,
  mode,
  defaultKey,
  pool,
  warn = () => {},
  persist = true,
}) {
  const state = persist ? readState(statePath) : emptyState()

  // Drop bindings whose alias no longer exists; a removed key must not keep a
  // session pinned to nothing.
  let pruned = false
  for (const [sessionId, alias] of Object.entries(state.sessions)) {
    if (!pool.has(alias)) {
      delete state.sessions[sessionId]
      pruned = true
    }
  }
  if (pruned) save()

  function save() {
    state.updatedAt = new Date().toISOString()
    if (!persist) return
    try {
      writeState(statePath, state)
    } catch (error) {
      warn(`could not persist session key bindings: ${error?.message ?? error}`)
    }
  }

  function defaultAlias() {
    if (pool.has(defaultKey)) return defaultKey
    return pool.aliases[0] ?? null
  }

  /**
   * Pick the alias for a request.
   *
   * @param {string | undefined} sessionId
   * @param {string | null | undefined} explicitAlias
   * @returns {{alias: string, key: string, reason: 'explicit'|'session'|'manual'|'round-robin'|'anonymous'}}
   * @throws {Error} when the pool is empty or the alias is unknown.
   */
  function assign(sessionId, explicitAlias) {
    if (pool.size === 0) throw new Error('no API keys configured')

    const session = sessionId === undefined || sessionId === null ? '' : String(sessionId)

    if (explicitAlias !== undefined && explicitAlias !== null && explicitAlias !== '') {
      if (!pool.has(explicitAlias)) {
        throw new Error(`unknown key alias "${explicitAlias}"; available: ${pool.aliases.join(', ')}`)
      }
      if (session !== '') {
        state.sessions[session] = explicitAlias
        save()
      }
      return { alias: explicitAlias, key: pool.resolve(explicitAlias), reason: 'explicit' }
    }

    if (session !== '' && typeof state.sessions[session] === 'string' && pool.has(state.sessions[session])) {
      const alias = state.sessions[session]
      return { alias, key: pool.resolve(alias), reason: 'session' }
    }

    if (session === '') {
      const alias = defaultAlias()
      return { alias, key: pool.resolve(alias), reason: 'anonymous' }
    }

    let alias
    let reason
    if (mode === 'manual') {
      alias = defaultAlias()
      reason = 'manual'
    } else {
      alias = pool.aliases[state.cursor % pool.size]
      state.cursor = (state.cursor + 1) % pool.size
      reason = 'round-robin'
    }
    state.sessions[session] = alias
    save()
    return { alias, key: pool.resolve(alias), reason }
  }

  /**
   * Manually rebind one existing session.
   *
   * @param {string} sessionId
   * @param {string} alias
   */
  function bind(sessionId, alias) {
    if (!pool.has(alias)) throw new Error(`unknown key alias "${alias}"`)
    state.sessions[String(sessionId)] = alias
    save()
  }

  /** Current binding for a session, or null. */
  function get(sessionId) {
    const alias = state.sessions[String(sessionId)]
    return typeof alias === 'string' && pool.has(alias) ? alias : null
  }

  /** Diagnostic snapshot without secrets. */
  function snapshot() {
    return {
      mode,
      defaultKey,
      cursor: state.cursor,
      poolSize: pool.size,
      keys: pool.masked,
      sessions: Object.entries(state.sessions).map(([sessionId, alias]) => ({ sessionId, alias })),
      updatedAt: state.updatedAt,
    }
  }

  return { assign, bind, get, snapshot, statePath, mode, defaultKey }
}
