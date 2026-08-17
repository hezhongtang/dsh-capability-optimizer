/**
 * Contract tests for the hand-authored client bundle.
 *
 * `client/client.js` has no build step and, until now, no test: a typo in it
 * fails in the host's console, not here. It is a CJS factory the host loads
 * through `window.__ModuleLoader__`, so a stub loader plus a shallow React
 * double is enough to run the real module body and the real `apply()` — the
 * same path the host takes — without a DOM.
 *
 * What is worth pinning here is what a reader of the code cannot check:
 *  - the bundle parses and registers the seats it claims to register;
 *  - the two dictionaries stay in step, because a key added to one and not the
 *    other renders as a raw key id in the other locale.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { repoRoot } from './helpers/harness.mjs'

/** Enough React for the module body and `apply()`; nothing renders here. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}

/** Load the bundle the way the host does; return its exports. */
function loadClient() {
  const source = readFileSync(join(repoRoot, 'client', 'client.js'), 'utf8')
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          loaded = factory((id) => {
            if (id === 'react') return reactStub
            throw new Error(`unexpected require(${id})`)
          })
        },
      },
    },
    document: { getElementById: () => null, createElement: () => ({ setAttribute() {} }), head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => Promise.reject(new Error('no network in tests')),
  }
  runInNewContext(source, sandbox, { filename: 'client/client.js' })
  assert.notEqual(loaded, null, 'the bundle never called window.__ModuleLoader__.load')
  return loaded
}

/** Drive `apply()` with a stub host, capturing dictionaries and slot registrations. */
function applyClient() {
  const client = loadClient()
  const registered = []
  let dictionaries = null
  const ctx = {
    effect: (fn) => { fn() },
    locale: {
      register: (_ns, dicts) => { dictionaries = dicts },
      bind: () => (key) => key,
    },
    slots: {
      inject: (_slot, fn) => { fn() },
      register: (config, component) => { registered.push({ ...config, component }); return config },
    },
  }
  client.apply(ctx)
  return { client, registered, dictionaries }
}

test('the client bundle loads and registers both seats', () => {
  const { client, registered } = applyClient()

  assert.equal(client.name, 'dsh-capability-optimizer')
  // Spread first: the bundle's arrays come from the vm realm, so a strict deep
  // compare against a host-realm literal would fail on the prototype alone.
  assert.deepEqual([...client.inject], ['slots', 'locale'])
  assert.deepEqual(registered.map((entry) => entry.name).sort(),
    ['conversation.input.left', 'settings.section'])
})

test('the zh and en dictionaries define exactly the same keys', () => {
  const { dictionaries } = applyClient()

  assert.notEqual(dictionaries, null, 'apply() never registered dictionaries')
  const zh = Object.keys(dictionaries.zh).sort()
  const en = Object.keys(dictionaries.en).sort()
  const missingFromEn = zh.filter((key) => !dictionaries.en[key])
  const missingFromZh = en.filter((key) => !dictionaries.zh[key])
  assert.deepEqual(missingFromEn, [], 'keys present in zh but not en render as raw ids')
  assert.deepEqual(missingFromZh, [], 'keys present in en but not zh render as raw ids')
  assert.deepEqual(zh, en)
})

/**
 * S4: `counts[role]/cap` cannot distinguish a role that spent its budget on
 * useful reviews from one that burned it on failures. The ledger has told the
 * difference since P0 (`attempts` / `succeeded` / `failed` / `aborted`); the
 * composer popover needs the words to say it.
 */
test('settings copy names the advisor top-tier model pin in both locales', () => {
  const { dictionaries } = applyClient()
  for (const locale of ['zh', 'en']) {
    for (const key of ['roleModelAdvisor', 'roleModelAdvisorHint', 'errAdvisorModel', 'roleTopTierPill']) {
      assert.equal(typeof dictionaries[locale][key], 'string', `${locale}.${key} must exist`)
      assert.ok(dictionaries[locale][key].length > 0, `${locale}.${key} must not be empty`)
    }
    assert.match(dictionaries[locale].roleModelAdvisorHint, /claude-opus-5/)
  }
})

test('the composer popover has localized words for the whole ledger breakdown', () => {
  const { dictionaries } = applyClient()

  for (const locale of ['zh', 'en']) {
    for (const key of ['acAttempted', 'acAnswered', 'acFailed', 'acCancelled']) {
      assert.equal(typeof dictionaries[locale][key], 'string',
        `${locale}.${key} must exist for the usage breakdown`)
      assert.ok(dictionaries[locale][key].length > 0, `${locale}.${key} must not be empty`)
    }
  }
})
