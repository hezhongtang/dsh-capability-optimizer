/**
 * Ledger contract tests: the cap has to be a real refusal, settle has to be
 * idempotent, and the attempt/success axes have to stay separate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLedger } from '../lib/ledger.js'

test('reserve claims attempts until the cap, then refuses with used/cap', () => {
  const ledger = createLedger({ getCap: () => 2 })
  const first = ledger.reserve('s1', 'reviewer')
  const second = ledger.reserve('s1', 'reviewer')
  const third = ledger.reserve('s1', 'reviewer')

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(third, { ok: false, used: 2, cap: 2 })
  assert.equal(ledger.attemptsLeft('s1', 'reviewer'), 0)
})

test('two reserves in flight against a cap of 1: exactly one wins', async () => {
  const ledger = createLedger({ getCap: () => 1 })
  // Both callers reach reserve() through the microtask queue, the way two
  // panel roles do. The claim must be visible to whichever runs second.
  const [a, b] = await Promise.all([
    (async () => { await Promise.resolve(); return ledger.reserve('s1', 'designer') })(),
    (async () => { await Promise.resolve(); return ledger.reserve('s1', 'designer') })(),
  ])
  assert.equal([a, b].filter((r) => r.ok).length, 1)
  const loser = [a, b].find((r) => !r.ok)
  assert.deepEqual(loser, { ok: false, used: 1, cap: 1 })
  assert.equal(ledger.usage('s1').designer.attempts, 1)
})

test('a reserved-but-unsettled attempt still holds the slot', () => {
  const ledger = createLedger({ getCap: () => 1 })
  const held = ledger.reserve('s1', 'reviewer')
  assert.equal(held.ok, true)
  assert.equal(ledger.reserve('s1', 'reviewer').ok, false)
})

test('per-role and per-session budgets are independent', () => {
  const ledger = createLedger({ getCap: () => 1 })
  assert.equal(ledger.reserve('s1', 'reviewer').ok, true)
  assert.equal(ledger.reserve('s1', 'designer').ok, true)
  assert.equal(ledger.reserve('s2', 'reviewer').ok, true)
  assert.equal(ledger.reserve('s1', 'reviewer').ok, false)
})

test('settle is idempotent', () => {
  const ledger = createLedger({ getCap: () => 5 })
  const slot = ledger.reserve('s1', 'reviewer')
  slot.settle('success')
  slot.settle('success')
  slot.settle('failed')
  assert.deepEqual(ledger.usage('s1').reviewer, { attempts: 1, succeeded: 1, failed: 0, aborted: 0 })
})

test('abort refunds the attempt; failure does not', () => {
  const ledger = createLedger({ getCap: () => 2 })

  ledger.reserve('s1', 'reviewer').settle('aborted')
  assert.equal(ledger.attemptsLeft('s1', 'reviewer'), 2, 'a cancelled call must not be billed')
  assert.equal(ledger.usage('s1').reviewer.aborted, 1)

  ledger.reserve('s1', 'reviewer').settle('failed')
  assert.equal(ledger.attemptsLeft('s1', 'reviewer'), 1, 'a failed call keeps its slot')
  assert.equal(ledger.usage('s1').reviewer.failed, 1)
})

test('an unknown outcome is billed as a failure', () => {
  const ledger = createLedger({ getCap: () => 2 })
  ledger.reserve('s1', 'reviewer').settle('who-knows')
  assert.equal(ledger.usage('s1').reviewer.failed, 1)
  assert.equal(ledger.attemptsLeft('s1', 'reviewer'), 1)
})

test('hasSucceeded stays false until a success settles', () => {
  const ledger = createLedger({ getCap: () => 5 })
  assert.equal(ledger.hasSucceeded('s1', 'reviewer'), false)

  const attempt = ledger.reserve('s1', 'reviewer')
  assert.equal(ledger.hasSucceeded('s1', 'reviewer'), false, 'an attempt is not a success')
  attempt.settle('failed')
  assert.equal(ledger.hasSucceeded('s1', 'reviewer'), false)
  ledger.reserve('s1', 'reviewer').settle('aborted')
  assert.equal(ledger.hasSucceeded('s1', 'reviewer'), false)

  ledger.reserve('s1', 'reviewer').settle('success')
  assert.equal(ledger.hasSucceeded('s1', 'reviewer'), true)
  assert.equal(ledger.successes('s1', 'reviewer'), 1)
})

test('successes counts monotonically per role', () => {
  const ledger = createLedger({ getCap: () => 5 })
  ledger.reserve('s1', 'reviewer').settle('success')
  ledger.reserve('s1', 'reviewer').settle('success')
  assert.equal(ledger.successes('s1', 'reviewer'), 2)
  assert.equal(ledger.successes('s1', 'designer'), 0)
  assert.equal(ledger.successes('s2', 'reviewer'), 0)
})

test('usage returns a detached copy', () => {
  const ledger = createLedger({ getCap: () => 5 })
  ledger.reserve('s1', 'reviewer').settle('success')
  const snapshot = ledger.usage('s1')
  snapshot.reviewer.attempts = 99
  assert.equal(ledger.usage('s1').reviewer.attempts, 1)
  assert.deepEqual(ledger.usage('unknown-session'), {})
})

test('drop clears everything for one session and leaves others intact', () => {
  const ledger = createLedger({ getCap: () => 1 })
  ledger.reserve('s1', 'reviewer').settle('failed')
  ledger.reserve('s2', 'reviewer').settle('success')

  ledger.drop('s1')

  assert.deepEqual(ledger.usage('s1'), {})
  assert.equal(ledger.attemptsLeft('s1', 'reviewer'), 1)
  assert.equal(ledger.hasSucceeded('s1', 'reviewer'), false)
  assert.equal(ledger.hasSucceeded('s2', 'reviewer'), true)
})

test('the cap is read live, so a config edit hot-applies', () => {
  let cap = 1
  const ledger = createLedger({ getCap: () => cap })
  assert.equal(ledger.reserve('s1', 'reviewer').ok, true)
  assert.equal(ledger.reserve('s1', 'reviewer').ok, false)
  cap = 3
  assert.equal(ledger.attemptsLeft('s1', 'reviewer'), 2)
  assert.equal(ledger.reserve('s1', 'reviewer').ok, true)
})

test('a shrinking cap never reports negative headroom', () => {
  let cap = 3
  const ledger = createLedger({ getCap: () => cap })
  ledger.reserve('s1', 'reviewer').settle('failed')
  ledger.reserve('s1', 'reviewer').settle('failed')
  cap = 1
  assert.equal(ledger.attemptsLeft('s1', 'reviewer'), 0)
  assert.equal(ledger.reserve('s1', 'reviewer').ok, false)
})

test('a broken cap provider degrades to the documented default, not to unlimited', () => {
  const thrower = createLedger({ getCap: () => { throw new Error('boom') } })
  assert.equal(thrower.attemptsLeft('s1', 'reviewer'), 3)
  const garbage = createLedger({ getCap: () => 'lots' })
  assert.equal(garbage.attemptsLeft('s1', 'reviewer'), 3)
  const missing = createLedger({})
  assert.equal(missing.attemptsLeft('s1', 'reviewer'), 3)
})

test('a cap of zero refuses everything', () => {
  const ledger = createLedger({ getCap: () => 0 })
  assert.deepEqual(ledger.reserve('s1', 'reviewer'), { ok: false, used: 0, cap: 0 })
})

test('a missing session id reserves for free instead of refusing', () => {
  const ledger = createLedger({ getCap: () => 0 })
  const slot = ledger.reserve(undefined, 'reviewer')
  assert.equal(slot.ok, true)
  slot.settle('success')
  assert.deepEqual(ledger.usage(undefined), {})
  assert.equal(ledger.hasSucceeded(undefined, 'reviewer'), false)
  assert.equal(ledger.reserve('', 'reviewer').ok, true)
  assert.equal(ledger.reserve('s1', '').ok, true)
})
