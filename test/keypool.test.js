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

test('the rotation entry takes the next key on every request and cycles the pool', () => {
  const pool = createKeyPool(entries)
  const store = createSessionKeyStore({
    statePath: tempState(),
    mode: 'manual',
    defaultKey: 'k1',
    pool,
    persist: false,
  })

  // Every request advances: k1 → k2 → k1 → k2 … no session binding involved.
  assert.equal(store.assign('s1', '轮换').alias, 'k1')
  assert.equal(store.assign('s1', '轮换').alias, 'k2')
  assert.equal(store.assign('s1', '轮换').alias, 'k1')
  assert.equal(store.assign('s2', '轮换').alias, 'k2')
  assert.equal(store.assign('s2', '轮换').alias, 'k1')

  // The rotation rows never created a session binding: a plain request on
  // the same session still follows the normal mode rules (fresh binding).
  const plain = store.assign('s1', null)
  assert.equal(plain.alias, 'k1')
  assert.equal(plain.reason, 'manual')
})

test('the rotation cursor persists across store instances', () => {
  const statePath = tempState()
  const pool = createKeyPool(entries)
  const first = createSessionKeyStore({ statePath, mode: 'auto', defaultKey: 'k1', pool })
  assert.equal(first.assign('s1', '轮换').alias, 'k1')
  assert.equal(first.assign('s1', '轮换').alias, 'k2')
  const second = createSessionKeyStore({ statePath, mode: 'auto', defaultKey: 'k1', pool })
  // Wraps to the first key: one full cycle done, starting over.
  assert.equal(second.assign('s1', '轮换').alias, 'k1')
})

test('rotation works on an empty-pool day zero with a single key', () => {
  const pool = createKeyPool([{ alias: 'only', key: 'sk-one' }])
  const store = createSessionKeyStore({ statePath: tempState(), mode: 'manual', defaultKey: 'only', pool, persist: false })
  assert.equal(store.assign('s1', '轮换').alias, 'only')
  assert.equal(store.assign('s1', '轮换').alias, 'only')
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
