import assert from 'node:assert/strict'
import test from 'node:test'

test('client half registers the settings section', async () => {
  let loaded
  globalThis.window = { __ModuleLoader__: { load: entry => { loaded = entry } } }
  await import('../client.js?client-test')
  assert.equal(loaded.id, 'dsh-sensenova-keypool')

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
  }
  const mod = loaded.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected module ${name}`)
  })

  let section
  let dictionaries
  const ctx = {
    effect: callback => callback(),
    locale: {
      register: (namespace, value) => {
        dictionaries = { namespace, value }
        return () => {}
      },
      bind: namespace => key => `${namespace}:${key}`,
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (registration, component) => {
        section = { registration, component }
        return () => {}
      },
    },
  }
  mod.apply(ctx)

  assert.equal(mod.name, 'sensenova-keypool')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(dictionaries.namespace, 'settings.sensenovaKeyPool')
  assert.deepEqual(Object.keys(dictionaries.value.zh).sort(), Object.keys(dictionaries.value.en).sort())
  assert.equal(section.registration.name, 'settings.section')
  assert.equal(section.registration.id, 'sensenova-keypool')
  assert.equal(section.registration.label(), 'settings.sensenovaKeyPool:nav')
  assert.equal(typeof section.component, 'function')
})
