import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadSettings } from '../src/settings.js'

function tempSettings(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensenova-settings-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify(contents, null, 2))
  return file
}

test('settings.json is the only key source', () => {
  const settings = loadSettings({
    path: '/nonexistent/settings.json',
    env: {
      SENSENOVA_API_KEY: 'sk-env',
      SENSENOVA_KEYS: 'sk-env-1,sk-env-2',
      SENSENOVA_KEY_REFS: 'SENSENOVA_API_KEY',
    },
  })
  assert.deepEqual(settings.keys, [])
  assert.equal(settings.keyRefs, undefined)
})

test('keys in settings.json are normalized and masked', () => {
  const file = tempSettings({
    baseURL: 'https://example.test/v1',
    keys: [{ alias: 'work', key: 'sk-work' }, { alias: 'k2', key: 'sk-two' }],
  })
  const settings = loadSettings({ path: file, env: {} })
  assert.deepEqual(settings.keys.map(entry => entry.alias), ['work', 'k2'])
  assert.equal(settings.keys[0].masked, 'sk…rk')
  assert.equal(settings.keys[0].masked.includes('sk-work'), false)
})

test('retry scope defaults to rate limit, timeout, server and transport', () => {
  const settings = loadSettings({ path: '/nonexistent/settings.json', env: {} })
  assert.deepEqual(settings.retryableCodes, ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT'])
})

test('retry scope is normalized and can come from the environment', () => {
  const file = tempSettings({ retryableCodes: [' rate_limit ', 'Server', 'RATE_LIMIT', ''] })
  const fromFile = loadSettings({ path: file, env: {} })
  assert.deepEqual(fromFile.retryableCodes, ['RATE_LIMIT', 'SERVER'])

  const fromEnv = loadSettings({
    path: '/nonexistent/settings.json',
    env: { SENSENOVA_RETRY_CODES: 'rate_limit, timeout ,TRANSPORT' },
  })
  assert.deepEqual(fromEnv.retryableCodes, ['RATE_LIMIT', 'TIMEOUT', 'TRANSPORT'])
})

test('models default to the built-in snapshot with 6.8 image-capable', () => {
  const settings = loadSettings({ path: '/nonexistent/settings.json', env: {} })
  assert.equal(settings.models.length, 6)
  assert.equal(settings.models[0].id, 'deepseek-v4-flash')
  const lite = settings.models.find(model => model.id === 'sensenova-6.8-flash-lite')
  assert.deepEqual(lite.inputModalities, ['text', 'image'])
})

test('models are normalized: dedupe, validate numbers, keep modality flags', () => {
  const file = tempSettings({
    models: [
      { id: 'm1', name: 'M1', contextWindow: '1048576', maxOutput: 384000, inputModalities: ['text', 'image'] },
      { id: 'm1', name: 'dup' },
      { id: '', name: 'empty' },
      { id: 'm2', contextWindow: -1, maxOutput: 10 },
      { id: 'm3', contextWindow: 100, maxOutput: 200, reasoning: false, inputModalities: ['image'] },
    ],
  })
  const settings = loadSettings({ path: file, env: {} })
  assert.deepEqual(settings.models.map(model => model.id), ['m1', 'm3'])
  assert.deepEqual(settings.models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(settings.models[1].inputModalities, ['text', 'image'])
  assert.equal(settings.models[1].reasoning, false)
})

test('auto-continue defaults are on with a round cap', () => {
  const settings = loadSettings({ path: '/nonexistent/settings.json', env: {} })
  assert.equal(settings.autoContinue, true)
  assert.equal(settings.autoContinueRounds, 8)
  assert.equal(settings.autoContinuePrompt, '继续')
})

test('auto-continue reads from settings.json and environment', () => {
  const file = tempSettings({ autoContinue: false, autoContinueRounds: 3, autoContinuePrompt: 'continue please' })
  const fromFile = loadSettings({ path: file, env: {} })
  assert.equal(fromFile.autoContinue, false)
  assert.equal(fromFile.autoContinueRounds, 3)
  assert.equal(fromFile.autoContinuePrompt, 'continue please')

  const fromEnv = loadSettings({
    path: '/nonexistent/settings.json',
    env: {
      SENSENOVA_AUTO_CONTINUE: '0',
      SENSENOVA_AUTO_CONTINUE_ROUNDS: '12',
      SENSENOVA_AUTO_CONTINUE_PROMPT: 'keep going',
    },
  })
  assert.equal(fromEnv.autoContinue, false)
  assert.equal(fromEnv.autoContinueRounds, 12)
  assert.equal(fromEnv.autoContinuePrompt, 'keep going')
})

test('auto-continue values are normalized defensively', () => {
  const file = tempSettings({ autoContinueRounds: 'many', autoContinuePrompt: '   ' })
  const settings = loadSettings({ path: file, env: {} })
  assert.equal(settings.autoContinueRounds, 8)
  assert.equal(settings.autoContinuePrompt, '继续')
})
