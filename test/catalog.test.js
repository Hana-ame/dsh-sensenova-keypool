import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MODELS,
  ROUTE,
  ROUTE_LABEL,
  VERIFIED_INPUT_MODALITIES,
  catalogRows,
  keyQualifiedModelId,
  parseModelId,
  resolveModelInfo,
} from '../src/catalog.js'

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
  // 1 plain row + 1 rotation row per model
  assert.equal(rows.length, MODELS.length * 2)
  assert.equal(rows.filter(row => !row.id.includes('@')).length, MODELS.length)
})

test('every enabled key expands into its own dedicated model group', () => {
  const rows = catalogRows(ROUTE, MODELS, { keys: ['k1', 'k2'] })
  // 1 plain + 1 rotation + 2 key rows per model
  assert.equal(rows.length, MODELS.length * 4)
  // @-qualified rows: 2 keys + 1 rotation per model
  const pinned = rows.filter(row => row.id.includes('@'))
  assert.equal(pinned.length, MODELS.length * 3)
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
  // Rotation rows are NOT key-qualified: they stay even with perKeyModels off.
  assert.equal(rows.length, MODELS.length * 2)
  assert.equal(rows.filter(row => !row.id.includes('@')).length, MODELS.length)
})

test('a key-qualified id round-trips through parseModelId', () => {
  const id = keyQualifiedModelId('deepseek-v4-flash', 'work')
  assert.equal(id, 'deepseek-v4-flash@work')
  assert.deepEqual(parseModelId(id), { modelId: 'deepseek-v4-flash', alias: 'work' })
})

test('every model advertises a request-rotation entry that cycles the pool', () => {
  const rows = catalogRows(ROUTE, MODELS, { keys: ['k1', 'k2'] })
  for (const model of MODELS) {
    const row = rows.find(entry => entry.id === keyQualifiedModelId(model.id, '轮换'))
    assert.ok(row, `${model.id}@轮换 missing`)
    assert.equal(row.name, `${model.name} · 轮换`)
    assert.equal(row.description.endsWith('[每次请求换下一个 key]'), true)
    assert.deepEqual(row.inputModalities, verifiedModalitiesOf(model))
  }
  // resolveModelInfo keeps the rotation suffix readable too
  const info = resolveModelInfo(ROUTE, `${MODELS[0].id}@轮换`)
  assert.equal(info.name.endsWith('· 轮换'), true)
  assert.equal(info.description.includes('每次请求换下一个 key'), true)
  assert.equal(info.id, `${MODELS[0].id}@轮换`)
  assert.equal(info.context.contextWindow, MODELS[0].contextWindow)
})

function verifiedModalitiesOf(model) {
  // mirror the verified-modality clamp for the expected value
  const verified = VERIFIED_INPUT_MODALITIES[model.id]
  return verified ? [...verified] : [...model.inputModalities]
}

test('a model whose upstream metadata lies about image input is clamped to text', () => {
  // settings.json (or a stale Settings refresh) can advertise `image` for
  // models whose chat route rejects image_url with HTTP 400. The verified
  // table must win, or every read_image / screenshot turn hard-fails.
  const declaredImage = [
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576, maxOutput: 384_000, reasoning: true, inputModalities: ['text', 'image'] },
    { id: 'sensenova-6.8-flash-lite', name: 'Lite', contextWindow: 1_048_576, maxOutput: 384_000, reasoning: true, inputModalities: ['text', 'image'] },
  ]

  assert.deepEqual(resolveModelInfo(ROUTE, 'glm-5.2', declaredImage).inputModalities, ['text'])
  assert.deepEqual(resolveModelInfo(ROUTE, 'glm-5.2@k1', declaredImage).inputModalities, ['text'])
  assert.deepEqual(
    resolveModelInfo(ROUTE, 'sensenova-6.8-flash-lite', declaredImage).inputModalities,
    ['text', 'image'],
  )

  const rows = catalogRows(ROUTE, declaredImage)
  assert.deepEqual(rows.find(row => row.id === 'glm-5.2').inputModalities, ['text'])
  assert.deepEqual(rows.find(row => row.id === 'glm-5.2@k1') ?? null, null)
  assert.deepEqual(rows.find(row => row.id === 'sensenova-6.8-flash-lite').inputModalities, ['text', 'image'])
})

test('the verified table only lists ids measured against the live route', () => {
  assert.deepEqual([...VERIFIED_INPUT_MODALITIES['glm-5.2']], ['text'])
  assert.deepEqual([...VERIFIED_INPUT_MODALITIES['sensenova-6.8-flash-lite']], ['text', 'image'])
  // Unknown ids keep the declared value — a newer image model is not disabled
  // before this table can verify it.
  assert.deepEqual(
    resolveModelInfo(ROUTE, 'brand-new-model', [
      { id: 'brand-new-model', inputModalities: ['text', 'image'] },
    ]).inputModalities,
    ['text', 'image'],
  )
})
