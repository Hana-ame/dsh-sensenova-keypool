import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAdmin } from '../src/admin.js'

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensenova-admin-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify(contents, null, 2))
  return file
}

function invoke(handler, { method = 'GET', url = '/api/sensenova-keypool/admin/config', body, headers: headerOverrides, address = '127.0.0.1' } = {}) {
  const headers = { 'content-type': 'application/json', ...(headerOverrides ?? {}) }
  const req = body === undefined
    ? { method, url, headers, socket: { remoteAddress: address } }
    : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method,
        url,
        headers,
        socket: { remoteAddress: address },
      })
  return new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      status: 0,
      headers: {},
      text: '',
      writeHead(status, responseHeaders) {
        this.status = status
        this.headers = responseHeaders
        this.headersSent = true
      },
      end(chunk) {
        this.text += chunk === undefined ? '' : String(chunk)
        try {
          resolve({ status: this.status, headers: this.headers, body: JSON.parse(this.text) })
        } catch (error) {
          reject(error)
        }
      },
    }
    handler(req, res).catch(reject)
  })
}

test('GET returns aliases and masks, never raw keys', async () => {
  const file = tempFile({
    baseURL: 'https://example.test/v1',
    mode: 'auto',
    defaultKey: 'k1',
    keys: [{ alias: 'k1', key: 'sk-secret-one' }],
  })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 1 }) },
  })
  const response = await invoke(admin)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.keys, [{ alias: 'k1', masked: 'sk-s…-one', enabled: true }])
  assert.equal(JSON.stringify(response.body).includes('sk-secret-one'), false)
})

test('POST preserves an existing secret when the key field is blank', async () => {
  const file = tempFile({
    baseURL: 'https://example.test/v1',
    mode: 'auto',
    defaultKey: 'k1',
    keys: [{ alias: 'k1', key: 'sk-old' }],
    untouched: { keep: true },
  })
  let saved = 0
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 2 }) },
    onSaved: () => { saved += 1 },
  })
  const response = await invoke(admin, {
    method: 'POST',
    body: { keys: [{ alias: 'k1', key: '' }, { alias: 'k2', key: 'sk-new' }], mode: 'manual', defaultKey: 'k2' },
  })
  assert.equal(response.status, 200)
  assert.equal(saved, 1)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(written.keys, [{ alias: 'k1', key: 'sk-old', enabled: true }, { alias: 'k2', key: 'sk-new', enabled: true }])
  assert.deepEqual(written.untouched, { keep: true })
  assert.equal(written.mode, 'manual')
  assert.equal(written.defaultKey, 'k2')
})

test('POST saves the retry count, backoff and scope', async () => {
  const file = tempFile({
    mode: 'auto',
    defaultKey: 'k1',
    keys: [{ alias: 'k1', key: 'sk-old' }],
    maxRetries: 2,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 6000,
    retryableCodes: ['RATE_LIMIT'],
  })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 1 }) },
  })
  const response = await invoke(admin, {
    method: 'POST',
    body: {
      keys: [{ alias: 'k1', key: '' }],
      maxRetries: 7,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 1500,
      retryableCodes: ['RATE_LIMIT', 'SERVER'],
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.maxRetries, 7)
  assert.deepEqual(response.body.retryableCodes, ['RATE_LIMIT', 'SERVER'])
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.maxRetries, 7)
  assert.equal(written.retryBaseDelayMs, 250)
  assert.equal(written.retryMaxDelayMs, 1500)
  assert.deepEqual(written.retryableCodes, ['RATE_LIMIT', 'SERVER'])
})

test('GET lists models with context/modalities and POST saves manual model edits', async () => {
  const file = tempFile({
    mode: 'auto',
    defaultKey: 'k1',
    keys: [{ alias: 'k1', key: 'sk-model' }],
  })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 1 }) },
  })
  const initial = await invoke(admin)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.models.length >= 1, true)
  assert.equal(typeof initial.body.models[0].contextWindow, 'number')
  assert.equal(typeof initial.body.models[0].maxOutput, 'number')
  assert.equal(initial.body.models[0].inputModalities.includes('text'), true)
  assert.equal(typeof initial.body.defaultModel, 'string')

  const response = await invoke(admin, {
    method: 'POST',
    body: {
      keys: [{ alias: 'k1', key: '' }],
      defaultModel: 'my-model',
      models: [
        { id: 'my-model', name: 'My Model', contextWindow: 1048576, maxOutput: 384000, inputModalities: ['text', 'image'] },
        { id: 'text-only', name: 'Text Only', contextWindow: 131072, maxOutput: 8192, inputModalities: ['text'] },
      ],
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.defaultModel, 'my-model')
  assert.deepEqual(response.body.models.map(model => model.id), ['my-model', 'text-only'])
  assert.deepEqual(response.body.models[0].inputModalities, ['text', 'image'])
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.defaultModel, 'my-model')
  assert.deepEqual(written.models[0].inputModalities, ['text', 'image'])
})

test('renaming a key keeps its secret and disabling hides it from the pool', async () => {
  const file = tempFile({
    mode: 'auto',
    defaultKey: 'k1',
    keys: [{ alias: 'k1', key: 'sk-keep' }],
  })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 1 }) },
  })
  const renamed = await invoke(admin, {
    method: 'POST',
    body: { keys: [{ alias: '主号', originalAlias: 'k1', key: '', enabled: true }] },
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(renamed.body.keys, [{ alias: '主号', masked: 'sk…ep', enabled: true }])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keys, [{ alias: '主号', key: 'sk-keep', enabled: true }])

  const disabled = await invoke(admin, {
    method: 'POST',
    body: { keys: [{ alias: '主号', originalAlias: '主号', key: '', enabled: false }] },
  })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.keys[0].enabled, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keys, [{ alias: '主号', key: 'sk-keep', enabled: false }])
})

test('admin refuses non-loopback callers', async () => {
  const file = tempFile({ keys: [] })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 0 }) },
  })
  const response = await invoke(admin, { address: '10.0.0.4' })
  assert.equal(response.status, 403)
})

test('auto-continue fields are exposed and saved', async () => {
  const file = tempFile({
    mode: 'auto',
    defaultKey: 'k1',
    keys: [{ alias: 'k1', key: 'sk-auto' }],
    autoContinue: false,
    autoContinueRounds: 2,
    autoContinuePrompt: 'go on',
  })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 1 }) },
  })
  const initial = await invoke(admin)
  assert.equal(initial.body.autoContinue, false)
  assert.equal(initial.body.autoContinueRounds, 2)
  assert.equal(initial.body.autoContinuePrompt, 'go on')

  const response = await invoke(admin, {
    method: 'POST',
    body: {
      keys: [{ alias: 'k1', key: '' }],
      autoContinue: true,
      autoContinueRounds: 5,
      autoContinuePrompt: 'continue please',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.autoContinue, true)
  assert.equal(response.body.autoContinueRounds, 5)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.autoContinue, true)
  assert.equal(written.autoContinueRounds, 5)
  assert.equal(written.autoContinuePrompt, 'continue please')
})

test('auto-continue POST rejects invalid rounds', async () => {
  const file = tempFile({
    keys: [{ alias: 'k1', key: 'sk-auto' }],
  })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 1 }) },
  })
  const response = await invoke(admin, {
    method: 'POST',
    body: { keys: [{ alias: 'k1', key: '' }], autoContinueRounds: -1 },
  })
  assert.equal(response.status, 400)
})

test('per-key model rows: exposed on GET, saved on POST, kept when omitted', async () => {
  const file = tempFile({
    baseURL: 'https://example.test/v1',
    mode: 'auto',
    defaultKey: 'k1',
    keys: [{ alias: 'k1', key: 'sk-secret-one' }],
  })
  const admin = createAdmin({
    settingsPath: file,
    adapter: { status: () => ({ route: 'sensenova-pool', poolSize: 1 }) },
  })
  const initial = await invoke(admin)
  assert.equal(initial.body.perKeyModels, true)

  const off = await invoke(admin, {
    method: 'POST',
    body: { keys: [{ alias: 'k1', key: '' }], perKeyModels: false },
  })
  assert.equal(off.status, 200)
  assert.equal(off.body.perKeyModels, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).perKeyModels, false)

  // A key-only save must not flip the flag back on.
  const again = await invoke(admin, {
    method: 'POST',
    body: { keys: [{ alias: 'k1', key: '' }, { alias: 'k2', key: 'sk-two' }] },
  })
  assert.equal(again.body.perKeyModels, false)

  const on = await invoke(admin, {
    method: 'POST',
    body: { keys: [{ alias: 'k1', key: '' }, { alias: 'k2', key: 'sk-two' }], perKeyModels: true },
  })
  assert.equal(on.body.perKeyModels, true)
})

test('POST /quota requires JSON and forwards force, never leaking a raw key', async () => {
  let seen = null
  const file = tempFile({ baseURL: 'https://example.test/v1', mode: 'auto', defaultKey: 'k1', keys: [{ alias: 'k1', key: 'sk-secret-one' }] })
  const admin = createAdmin({
    settingsPath: file,
    adapter: {
      status: () => ({ route: 'sensenova-pool', poolSize: 1 }),
      quota: async options => {
        seen = options
        return {
          ok: true,
          at: '2026-10-31T00:00:00.000Z',
          model: 'deepseek-flash',
          cacheHit: false,
          entries: [{ alias: 'k1', masked: 'sk-s…-one', state: 'healthy', httpStatus: 200, latencyMs: 12 }],
        }
      },
    },
  })
  const bad = await invoke(admin, { method: 'POST', url: '/api/sensenova-keypool/admin/quota', headers: { 'content-type': 'text/plain' }, body: { force: true } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'BAD_REQUEST')

  const response = await invoke(admin, {
    method: 'POST',
    url: '/api/sensenova-keypool/admin/quota',
    headers: { 'content-type': 'application/json' },
    body: { force: true },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(seen, { force: true })
  assert.equal(response.body.entries[0].state, 'healthy')
  assert.equal(JSON.stringify(response.body).includes('sk-secret-one'), false)
})
