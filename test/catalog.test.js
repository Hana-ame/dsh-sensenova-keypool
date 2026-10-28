import assert from 'node:assert/strict'
import test from 'node:test'
import { MODELS, ROUTE, ROUTE_LABEL, catalogRows } from '../src/catalog.js'

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

test('the picker never expands key aliases into model rows', () => {
  const rows = catalogRows(ROUTE)
  assert.equal(rows.length, MODELS.length)
  assert.equal(rows.some(row => row.id.includes('@') || row.name.includes('key k')), false)
})
