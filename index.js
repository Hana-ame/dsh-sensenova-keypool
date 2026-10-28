/**
 * dsh-sensenova-keypool — plugin entry (Host half).
 *
 * Registers one provider route (`sensenova-pool`) whose adapter sends OpenAI
 * Chat Completions to SenseNova with a session-pinned key, and — when the web
 * server exists — mounts a local OpenAI-compatible gateway that also speaks
 * the Codex Responses API.
 *
 * The route id is deliberately not `sensenova`: the profile already owns that
 * route through `llm-pi-ai`. Keeping a distinct id lets both coexist and lets
 * you compare them; if you want this plugin to take over the name, remove the
 * `sensenova` provider entry from the profile and change `ROUTE` here.
 *
 * @module index
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SensenovaKeyPoolAdapter } from './src/adapter.js'
import { createAdmin } from './src/admin.js'
import { ROUTE } from './src/catalog.js'
import { createGateway } from './src/gateway.js'
import { createSettingsSource, validateSettings } from './src/settings.js'

export const name = 'sensenova-keypool'
export const inject = ['llm']

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))

function packageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return '0.0.0'
  }
}

export const version = packageVersion()

/**
 * Watch `settings.json` so key/alias edits refresh the browser model picker
 * without a page reload. `fs.watchFile` is polling-based and survives editors
 * that replace the file instead of writing it in place.
 *
 * @param {string} filename
 * @param {() => void} onChange
 * @returns {() => void} disposer
 */
function watchSettings(filename, onChange) {
  const listener = (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
    onChange()
  }
  fs.watchFile(filename, { interval: 1000 }, listener)
  return () => fs.unwatchFile(filename, listener)
}

/**
 * @param {object} ctx - cordis context
 * @returns {object} disposable
 */
export function apply(ctx) {
  const logger = ctx.logger ?? {}
  const warn = message => {
    if (typeof logger.warn === 'function') logger.warn(message)
  }
  const info = message => {
    if (typeof logger.info === 'function') logger.info(message)
  }

  // `settings.json` is the single key source. The browser Settings section
  // writes it through the loopback admin route; there is no env/credential
  // fallback and no second place to read key material from.
  const settingsSource = createSettingsSource()
  const initial = settingsSource.current()
  const problems = validateSettings(initial)
  if (problems.length > 0) warn(`sensenova-keypool: ${problems.join('; ')}`)

  const adapter = new SensenovaKeyPoolAdapter({
    settingsSource,
    warn,
    // Image input: the durable attachment store lives on the Host context.
    // `readImageRequest` in messages.js turns DSH image blocks into data URLs.
    resolveAttachments: () => ctx.get('attachments'),
  })

  // The browser caches the model catalog for the Host generation. Re-emitting
  // the adapter event after a settings edit makes new aliases visible in the
  // bottom-right model picker without reloading the page.
  const stopSettingsWatch = watchSettings(initial.settingsPath, () => {
    const next = settingsSource.reload()
    if (next.fileProblem) warn(`sensenova-keypool: ${next.fileProblem}`)
    try {
      ctx.emit('llm/adapters-updated')
    } catch (error) {
      warn(`sensenova-keypool: could not announce settings update: ${error?.message ?? error}`)
    }
    info(`sensenova-keypool: settings reloaded (keys=${next.keys.length}, mode=${next.mode})`)
  })

  let registration
  try {
    registration = ctx.llm.registerAdapter([ROUTE], adapter)
  } catch (error) {
    warn(`sensenova-keypool: could not register ${ROUTE}: ${error?.message ?? error}`)
    stopSettingsWatch()
    return { [Symbol.dispose]: () => {} }
  }

  info(
    `sensenova-keypool: route ${ROUTE} registered ` +
      `(keys=${initial.keys.length}, mode=${initial.mode}, default=${initial.defaultKey})`,
  )

  let removeGateway = null
  let removeAdmin = null

  // The web server is optional: a headless composition keeps the provider and
  // simply loses the settings page and Codex/OpenAI gateway.
  ctx.inject(['webServer'], scoped => {
    // The settings section needs this route even when the OpenAI gateway is
    // disabled; it is where the browser writes the key list.
    const admin = createAdmin({
      settingsPath: initial.settingsPath,
      adapter,
      onSaved: () => {
        settingsSource.reload()
        try {
          ctx.emit('llm/adapters-updated')
        } catch {
          // catalog refresh is best-effort
        }
      },
      warn,
    })
    removeAdmin = scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/sensenova-keypool/admin', handler: admin }),
      'sensenova-keypool: settings admin',
    )
    info('sensenova-keypool: settings admin mounted at /api/sensenova-keypool/admin')

    if (!initial.gateway.enabled) return
    const gateway = createGateway({ adapter, warn })
    removeGateway = scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: initial.gateway.path, handler: gateway }),
      'sensenova-keypool: local OpenAI/Codex gateway',
    )
    info(`sensenova-keypool: gateway mounted at ${initial.gateway.path}`)
  })

  return {
    [Symbol.dispose]: () => {
      try {
        if (typeof removeGateway === 'function') removeGateway()
      } catch {
        // disposed with the fiber anyway
      }
      try {
        if (typeof removeAdmin === 'function') removeAdmin()
      } catch {
        // disposed with the fiber anyway
      }
      try {
        registration()
      } catch {
        // already released
      }
      try {
        stopSettingsWatch()
      } catch {
        // already released
      }
      info('sensenova-keypool: disposed')
    },
  }
}
