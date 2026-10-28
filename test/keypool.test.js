import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKeyPool, createSessionKeyStore } from '../src/keypool.js'

const entries = [
  { alias: 'k1', key: 'sk-first-secret' },
  { alias: 'k2', key: 'sk-second-secret' },
]

function tempState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sn-keypool-')), 'state.json')
}

test('auto mode assigns round-robin and keeps every session pinned', () => {
  const pool = createKeyPool(entries)
  const store = createSessionKeyStore({
    statePath: tempState(),
    mode: 'auto',
    defaultKey: 'k1',
    pool,
    persist: false,
  })

  assert.equal(store.assign('session-a', null).alias, 'k1')
  assert.equal(store.assign('session-a', null).reason, 'session')
  assert.equal(store.assign('session-b', null).alias, 'k2')
  assert.equal(store.assign('session-a', null).alias, 'k1')
  assert.equal(store.assign('session-c', null).alias, 'k1')
  assert.equal(store.assign('session-b', null).alias, 'k2')
})

test('explicit alias rebinds one session and wins over auto', () => {
  const pool = createKeyPool(entries)
  const store = createSessionKeyStore({
    statePath: tempState(),
    mode: 'auto',
    defaultKey: 'k1',
    pool,
    persist: false,
  })

  assert.equal(store.assign('s1', null).alias, 'k1')
  assert.equal(store.assign('s1', 'k2').alias, 'k2')
  assert.equal(store.assign('s1', null).alias, 'k2')
  assert.equal(store.assign('s2', null).alias, 'k2')
})

test('manual mode puts new sessions on defaultKey', () => {
  const pool = createKeyPool(entries)
  const store = createSessionKeyStore({
    statePath: tempState(),
    mode: 'manual',
    defaultKey: 'k2',
    pool,
    persist: false,
  })
  assert.equal(store.assign('s1', null).alias, 'k2')
  assert.equal(store.assign('s2', null).alias, 'k2')
  assert.equal(store.assign('s2', 'k1').alias, 'k1')
  assert.equal(store.assign('s2', null).alias, 'k1')
})

test('unknown alias and empty pool fail loudly', () => {
  const pool = createKeyPool(entries)
  const store = createSessionKeyStore({
    statePath: tempState(),
    mode: 'auto',
    defaultKey: 'k1',
    pool,
    persist: false,
  })
  assert.throws(() => store.assign('s1', 'nope'), /unknown key alias/)
  const empty = createKeyPool([])
  const emptyStore = createSessionKeyStore({
    statePath: tempState(),
    mode: 'auto',
    defaultKey: 'k1',
    pool: empty,
    persist: false,
  })
  assert.throws(() => emptyStore.assign('s1', null), /no API keys/)
})

test('anonymous requests use one stable key and do not advance the cursor', () => {
  const pool = createKeyPool(entries)
  const store = createSessionKeyStore({
    statePath: tempState(),
    mode: 'auto',
    defaultKey: 'k1',
    pool,
    persist: false,
  })
  assert.equal(store.assign(undefined, null).alias, 'k1')
  assert.equal(store.assign(undefined, null).alias, 'k1')
  assert.equal(store.assign('next', null).alias, 'k1')
})

test('bindings persist across store instances', () => {
  const statePath = tempState()
  const pool = createKeyPool(entries)
  const first = createSessionKeyStore({ statePath, mode: 'auto', defaultKey: 'k1', pool })
  assert.equal(first.assign('persisted-session', null).alias, 'k1')
  const second = createSessionKeyStore({ statePath, mode: 'auto', defaultKey: 'k1', pool })
  assert.equal(second.assign('persisted-session', null).alias, 'k1')
  assert.equal(second.assign('fresh-session', null).alias, 'k2')
})

test('stale alias bindings are pruned when a key disappears', () => {
  const statePath = tempState()
  const two = createKeyPool(entries)
  const first = createSessionKeyStore({ statePath, mode: 'auto', defaultKey: 'k1', pool: two })
  first.assign('s1', 'k2')
  const one = createKeyPool([entries[0]])
  const second = createSessionKeyStore({ statePath, mode: 'auto', defaultKey: 'k1', pool: one })
  assert.equal(second.assign('s1', null).alias, 'k1')
})

test('snapshot masks secrets', () => {
  const pool = createKeyPool(entries)
  const store = createSessionKeyStore({
    statePath: tempState(),
    mode: 'auto',
    defaultKey: 'k1',
    pool,
    persist: false,
  })
  store.assign('s1', null)
  const snapshot = store.snapshot()
  assert.equal(snapshot.poolSize, 2)
  assert.equal(snapshot.keys[0].alias, 'k1')
  assert.ok(!JSON.stringify(snapshot).includes('sk-first-secret'))
})
