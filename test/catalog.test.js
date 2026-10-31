import assert from 'node:assert/strict'
import test from 'node:test'
import { MODELS, ROUTE, ROUTE_LABEL, catalogRows, keyQualifiedModelId, parseModelId } from '../src/catalog.js'

test('catalog advertises the upstream-servable chat models only', () => {
  assert.equal(ROUTE, 'sensenova-pool')
  assert.equal(ROUTE_LABEL, 'SenseNova · Key Pool')
  assert.equal(MODELS.length, 6)
  assert.equal(MODELS[0].id, 'deepseek-v4-flash')
  assert.equal(MODELS.some(row => row.id === 'sensenova-6.8-flash-lite'), true)
  assert.equal(MODELS.some(row => row.id === 'sensenova-6.7-flash-lite'), false)
  assert.equal(MODELS.some(row => row.id === 'deepseek-v4.1-flash'), true)
})

test('catalog uses the requested 1M context / 384K output ceiling', () => {
  const byId = Object.fromEntries(MODELS.map(row => [row.id, row]))
  for (const row of MODELS) {
    assert.equal(row.contextWindow, 1_048_576)
    assert.equal(row.maxOutput, 384_000)
  }
})

test('the picker keeps the plain round-robin rows when no keys are passed', () => {
  const rows = catalogRows(ROUTE)
  assert.equal(rows.length, MODELS.length)
  assert.equal(rows.some(row => row.id.includes('@')), false)
})

test('every enabled key expands into its own dedicated model group', () => {
  const rows = catalogRows(ROUTE, MODELS, { keys: ['k1', 'k2'] })
  assert.equal(rows.length, MODELS.length * 3)
  const pinned = rows.filter(row => row.id.includes('@'))
  assert.equal(pinned.length, MODELS.length * 2)
  for (const model of MODELS) {
    for (const alias of ['k1', 'k2']) {
      const row = rows.find(entry => entry.id === keyQualifiedModelId(model.id, alias))
      assert.ok(row, `${model.id}@${alias} missing`)
      assert.equal(row.provider, ROUTE)
      assert.equal(row.name, `${model.name} · ${alias}`)
      assert.equal(row.description.endsWith(`[key ${alias}]`), true)
      assert.deepEqual(row.inputModalities, [...model.inputModalities])
    }
  }
  // The plain rows survive untouched: round-robin / session pinning remains.
  const plain = rows.filter(row => !row.id.includes('@'))
  assert.deepEqual(plain.map(row => row.id), MODELS.map(model => model.id))
})

test('perKeyModels:false keeps the catalog free of key-qualified rows', () => {
  const rows = catalogRows(ROUTE, MODELS, { keys: ['k1'], perKeyModels: false })
  assert.equal(rows.length, MODELS.length)
  assert.equal(rows.some(row => row.id.includes('@')), false)
})

test('a key-qualified id round-trips through parseModelId', () => {
  const id = keyQualifiedModelId('deepseek-v4-flash', 'work')
  assert.equal(id, 'deepseek-v4-flash@work')
  assert.deepEqual(parseModelId(id), { modelId: 'deepseek-v4-flash', alias: 'work' })
})
