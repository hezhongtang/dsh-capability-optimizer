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

/** Load the bundle the way the host does; return its exports and captured styles. */
function loadClient() {
  const source = readFileSync(join(repoRoot, 'client', 'client.js'), 'utf8')
  let loaded = null
  const styles = []
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
    document: {
      getElementById: () => null,
      createElement: (tag) => {
        const el = { tagName: tag, attributes: {}, textContent: '', setAttribute(key, value) { this.attributes[key] = value } }
        if (tag === 'style') styles.push(el)
        return el
      },
      head: { appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => Promise.reject(new Error('no network in tests')),
  }
  runInNewContext(source, sandbox, { filename: 'client/client.js' })
  assert.notEqual(loaded, null, 'the bundle never called window.__ModuleLoader__.load')
  return { client: loaded, styles }
}

/** Drive `apply()` with a stub host, capturing dictionaries and slot registrations. */
function applyClient() {
  const { client, styles } = loadClient()
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
  return { client, registered, dictionaries, styles }
}

test('the client bundle loads and registers all three seats', () => {
  const { client, registered } = applyClient()

  assert.equal(client.name, 'dsh-capability-optimizer')
  // Spread first: the bundle's arrays come from the vm realm, so a strict deep
  // compare against a host-realm literal would fail on the prototype alone.
  assert.deepEqual([...client.inject], ['slots', 'locale'])
  assert.deepEqual(registered.map((entry) => entry.name).sort(),
    ['conversation.input.dock', 'conversation.input.left', 'settings.section'])
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
test('extraArgs placeholder names allowlisted flags, not a refused one', () => {
  const { dictionaries } = applyClient()
  for (const locale of ['zh', 'en']) {
    assert.match(dictionaries[locale].extraArgsPh, /--add-dir/)
    assert.doesNotMatch(dictionaries[locale].extraArgsPh, /--settings/)
    assert.equal(typeof dictionaries[locale].applyDraft, 'string')
    assert.equal(typeof dictionaries[locale].savedNotApplied, 'string')
    assert.equal(typeof dictionaries[locale].resetNotApplied, 'string')
    assert.equal(typeof dictionaries[locale].rejectedArgsNote, 'string')
    assert.equal(typeof dictionaries[locale].autoMode, 'string')
    assert.equal(typeof dictionaries[locale].autoModeHint, 'string')
    assert.equal(typeof dictionaries[locale].autoHintOff, 'string')
    assert.equal(typeof dictionaries[locale].acDropped, 'string')
    assert.equal(typeof dictionaries[locale].maxBudgetUsd, 'string')
    assert.match(dictionaries[locale].testMeta, /\{model\}/)
    assert.match(dictionaries[locale].testHint, /180/)
    assert.match(dictionaries[locale].autoModeHint, /Write/)
  }
})

test('the save path reads the host applied flag instead of always claiming a hot apply', () => {
  const source = readFileSync(join(repoRoot, 'client', 'client.js'), 'utf8')
  assert.match(source, /data\.applied === false/)
  assert.match(source, /data\.rejectedArgs/)
  assert.match(source, /recommendedAdvisorModels/)
  assert.match(source, /resetNotApplied/)
  assert.match(source, /advisorRoles/)
})

test('settings copy presents advisor Opus 5 as an overridable recommendation', () => {
  const { dictionaries } = applyClient()
  for (const locale of ['zh', 'en']) {
    for (const key of ['roleModelAdvisor', 'roleModelAdvisorHint', 'roleRecommendedPill']) {
      assert.equal(typeof dictionaries[locale][key], 'string', `${locale}.${key} must exist`)
      assert.ok(dictionaries[locale][key].length > 0, `${locale}.${key} must not be empty`)
    }
    assert.match(dictionaries[locale].roleModelAdvisorHint, /claude-opus-5/)
    assert.doesNotMatch(dictionaries[locale].autoHint, /only consults|只会请/)
  }
})

test('the composer popover has localized words for the whole ledger breakdown', () => {
  const { dictionaries } = applyClient()

  for (const locale of ['zh', 'en']) {
    for (const key of ['acAttempted', 'acAnswered', 'acFailed', 'acCancelled', 'acNotJson']) {
      assert.equal(typeof dictionaries[locale][key], 'string',
        `${locale}.${key} must exist for the usage breakdown`)
      assert.ok(dictionaries[locale][key].length > 0, `${locale}.${key} must not be empty`)
    }
  }
})

/**
 * The host SPA answers unknown paths with HTML 200. `fetch` then looks
 * successful, `res.json()` fails, and the old `catch (() => ({}))` turned
 * that into an empty object. Adopting `{}` as composer state reads
 * `session.enabled` and the slot error-boundary unmounts the button.
 */
test('an HTML 200 SPA shell is not a valid auto-consult snapshot', () => {
  const { client } = applyClient()
  assert.equal(typeof client.isAutoConsultState, 'function')
  assert.equal(client.isAutoConsultState({}), false)
  assert.equal(client.isAutoConsultState(null), false)
  assert.equal(client.isAutoConsultState({ session: {} }), false)
  assert.equal(client.isAutoConsultState({
    defaults: { capPerRole: 3, mode: 'remind' },
    session: { enabled: [], override: null, counts: {}, usage: {} },
    roles: [],
  }), true)
})

test('consultation-status snapshots have a strict JSON guard too', () => {
  const { client } = applyClient()
  assert.equal(typeof client.isConsultationStatus, 'function')
  assert.equal(client.isConsultationStatus({}), false)
  assert.equal(client.isConsultationStatus(null), false)
  assert.equal(client.isConsultationStatus({ session: 's', entries: [] }), false)
  assert.equal(client.isConsultationStatus({ session: 's', entries: [], now: Date.now() }), true)
  assert.equal(client.isConsultationStatus({ session: 's', entries: [], now: 'later' }), false)
})

test('dock timing helpers do not drift and poll only as fast as needed', () => {
  const { client } = applyClient()
  assert.equal(typeof client.dockPollDelay, 'function')
  assert.equal(typeof client.dockNow, 'function')

  assert.equal(client.dockPollDelay([]), 8000)
  assert.equal(client.dockPollDelay([{ phase: 'succeeded' }]), 8000)
  assert.equal(client.dockPollDelay([{ phase: 'running' }]), 1000)
  assert.equal(client.dockPollDelay([{ phase: 'fallback' }]), 1000)

  const snapshot = { now: 100000, receivedAt: 100000 }
  assert.equal(client.dockNow(snapshot, 110000), 110000)
  assert.equal(client.dockNow(snapshot, 200000), 200000, 'a monotonic tick must never be added to refreshed server time')
  assert.equal(client.dockNow({ now: 100000 }, 120000), 100000, 'missing receivedAt falls back to the server clock')
})

test('readApiJson rejects the SPA HTML shell even when status is 200', () => {
  const { client } = applyClient()
  const html = {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
  }
  assert.throws(() => client.readApiJson(html, '<!doctype html>'), /JSON|json/)
  const json = {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
  }
  // vm-realm objects fail a host-realm deepEqual on the prototype alone.
  assert.equal(JSON.stringify(client.readApiJson(json, '{"session":{"enabled":[]}}')), '{"session":{"enabled":[]}}')
})

test('api errors carry their HTTP status so the dock can key on a real 404', () => {
  const source = readFileSync(join(repoRoot, 'client', 'client.js'), 'utf8')
  assert.match(source, /error\.status = res\.status/)
  assert.match(source, /error\.status === 404/)
  assert.match(source, /failures >= 5/)
})

test('apply() injects composer styles so the chat seat is not unstyled', () => {
  const { styles } = applyClient()
  assert.ok(styles.some((el) => el.attributes['data-dco'] === ''),
    'ensureStyles must run from apply(), not only from the Settings section')
})

/**
 * The composer button used to render as bare 12px near-black text (`color:
 * inherit`) floating between the host's styled toolbar pills — read as a
 * missing/broken control. It must ride the host trigger tokens (muted
 * secondary label, 13px/500, 24px radius), and the popover must paint its
 * declared 264px width (box-sizing content-box made it a 290px silhouette the
 * anchor clamp did not budget for).
 */
test('composer auto-consult button matches the host toolbar trigger tokens', () => {
  const { styles } = applyClient()
  const css = styles.find((el) => el.attributes['data-dco'] === '')?.textContent ?? ''
  assert.match(css, /\.dco-ac-btn\{height:28px;border-radius:24px;border:none;background:transparent;color:var\(--dsw-alias-label-secondary/)
  assert.doesNotMatch(css, /\.dco-ac-btn\{[^}]*color:inherit/)
  // a visible focus ring (outline beats a low-contrast border-token shadow)
  assert.match(css, /\.dco-ac-btn:focus-visible\{outline:2px solid var\(--dsw-alias-label-primary/)
  assert.match(css, /\.dco-ac-pop\{position:fixed;box-sizing:border-box;width:264px/)
  // the count badge must not inherit the button's 20px line-height into its
  // 16px grid cell, or the digit lands ~2px below center
  assert.match(css, /\.dco-ac-count\{box-sizing:border-box;line-height:1;min-width:16px;height:16px/)
  // the open state is visually signalled even with nothing selected
  assert.match(css, /\.dco-ac-btn\[aria-expanded="true"\]\{background:var\(--dsw-alias-interactive-bg-hover/)
  // `.on` must stay after `:hover` (both two-class specificity) so the
  // selected pill is not washed out by hover, and `.on:hover` (three-class)
  // still gives the selected state a hover cue.
  const hoverAt = css.indexOf('.dco-ac-btn:hover')
  const onAt = css.indexOf('.dco-ac-btn.on')
  assert.ok(hoverAt !== -1 && onAt !== -1 && onAt > hoverAt, 'selected state must outrank the plain hover background')
  assert.match(css, /\.dco-ac-btn\.on:hover\{filter:brightness/)
})

test('consultation dock styles ship in the same injected stylesheet', () => {
  const { styles } = applyClient()
  const css = styles.find((el) => el.attributes['data-dco'] === '')?.textContent ?? ''
  assert.match(css, /\.dco-cd\{box-sizing:border-box;display:flex/)
  assert.match(css, /\.dco-cd-list\{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto\}/)
  assert.match(css, /\.dco-cd-phase\.succeeded\{[^}]*--dsw-alias-state-success/)
  assert.match(css, /\.dco-cd-phase\.failed\{[^}]*--dsw-alias-state-error/)
})

test('composer clamp and ARIA derive from one shared popup constant', () => {
  const source = readFileSync(join(repoRoot, 'client', 'client.js'), 'utf8')
  assert.match(source, /const POPUP_W = 264/)
  assert.match(source, /window\.innerWidth - \(POPUP_W \+ 8\)/)
  // the popover is a checkbox group, not a menu
  assert.match(source, /'aria-haspopup': 'dialog'/)
  assert.match(source, /'aria-controls': open \? popupId : undefined/)
  assert.match(source, /id: popupId,/)
})
