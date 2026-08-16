/**
 * Proactive-consultation runtime tests.
 *
 * The runtime is directly unit-testable; `wireAutoConsult` is exercised
 * against a minimal fake Cordis ctx (on / inject / logger / agents) rather
 * than a booted DSH, because the only thing under test here is which runtime
 * method each host event reaches.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutoConsultRuntime, wireAutoConsult } from '../lib/autoconsult.js'

const ROSTER = [
  { name: 'advisor', enabled: true },
  { name: 'reviewer', enabled: true },
  { name: 'designer', enabled: true },
]

/**
 * @param {object} [options]
 * @param {string[]} [options.enabled] backend-prefixed default keys
 * @param {number} [options.capPerRole]
 * @param {Array|undefined} [options.roster] live roster; `undefined` omits getRoster entirely
 */
function makeRuntime({ enabled = ['claude-code:reviewer'], capPerRole = 3, roster = ROSTER } = {}) {
  const defaults = { enabled, capPerRole }
  const options = { getDefaults: () => defaults }
  if (roster !== undefined) options.getRoster = () => roster
  return { runtime: createAutoConsultRuntime(options), defaults }
}

/** Simulate one consultation on the execution path. */
function consult(runtime, sessionId, role, outcome) {
  const slot = runtime.ledger.reserve(sessionId, role)
  if (!slot.ok) return slot
  slot.settle(outcome)
  return slot
}

/** Minimal Cordis-shaped ctx: records listeners and lets tests emit into them. */
function fakeCtx() {
  const listeners = new Map()
  const agents = new Map()
  return {
    logger: { info() {}, warn() {}, error() {} },
    agents: { get: (id) => agents.get(id) },
    registerAgent(id) { agents.set(id, { id }) },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
    },
    // No systemPrompt / other services in this harness: inject never fires,
    // which is exactly the "service absent" path the wiring must survive.
    inject() { return () => {} },
    async emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) await fn(...args)
    },
    listenerCount(event) { return (listeners.get(event) ?? []).length },
  }
}

// --- Defect 2: attempts must not satisfy a quality gate -------------------

test('a failed reviewer consultation leaves the reviewer gate OPEN', () => {
  const { runtime } = makeRuntime()
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  runtime.onConsultCall('s1', 'consult_expert', { role: 'reviewer' })
  consult(runtime, 's1', 'reviewer', 'failed')

  assert.deepEqual(runtime.reviewerGate('s1'), ['reviewer'], 'a failed review is not a review')
})

test('an aborted reviewer consultation leaves the reviewer gate OPEN', () => {
  const { runtime } = makeRuntime()
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  consult(runtime, 's1', 'reviewer', 'aborted')

  assert.deepEqual(runtime.reviewerGate('s1'), ['reviewer'])
})

test('a successful reviewer consultation closes the reviewer gate', () => {
  const { runtime } = makeRuntime()
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  consult(runtime, 's1', 'reviewer', 'success')

  assert.equal(runtime.reviewerGate('s1'), null)
})

test('last turn\'s success does not close this turn\'s gate', () => {
  const { runtime } = makeRuntime({ capPerRole: 5 })
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  consult(runtime, 's1', 'reviewer', 'success')
  assert.equal(runtime.reviewerGate('s1'), null)

  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Edit')
  assert.deepEqual(runtime.reviewerGate('s1'), ['reviewer'], 'new changes need a new review')
})

test('the reviewer gate is nudged at most once per turn', () => {
  const { runtime } = makeRuntime()
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  assert.deepEqual(runtime.reviewerGate('s1'), ['reviewer'])
  assert.equal(runtime.reviewerGate('s1'), null, 'a refused nudge is not re-sent this turn')
})

test('the reviewer gate stays shut for a turn that changed nothing', () => {
  const { runtime } = makeRuntime()
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Read')
  assert.equal(runtime.reviewerGate('s1'), null)
  assert.equal(runtime.reviewerGate('unseen-session'), null)
})

test('the reviewer gate goes quiet once the attempt budget is spent', () => {
  const { runtime } = makeRuntime({ capPerRole: 1 })
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  consult(runtime, 's1', 'reviewer', 'failed')

  assert.equal(runtime.reviewerGate('s1'), null, 'budget spent: degrade to model discretion')
})

// --- Designer anchor ------------------------------------------------------

test('the first write of a turn arms one designer nudge', () => {
  const { runtime } = makeRuntime({ enabled: ['claude-code:designer'] })
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  runtime.onWriteTool('s1', 'Edit')

  assert.deepEqual(runtime.consumeNudge('s1'), ['designer'])
  assert.equal(runtime.consumeNudge('s1'), null, 'the queue drains once')
})

test('a designer nudge armed before a success is dropped at drain time', () => {
  const { runtime } = makeRuntime({ enabled: ['claude-code:designer'], capPerRole: 5 })
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  consult(runtime, 's1', 'designer', 'success')

  assert.equal(runtime.consumeNudge('s1'), null, 'never ask for what just landed')
})

test('a designer nudge survives a failed consultation', () => {
  const { runtime } = makeRuntime({ enabled: ['claude-code:designer'], capPerRole: 5 })
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  consult(runtime, 's1', 'designer', 'failed')

  assert.deepEqual(runtime.consumeNudge('s1'), ['designer'])
})

test('a disabled role arms no anchor at all', () => {
  const { runtime } = makeRuntime({
    enabled: ['claude-code:designer', 'claude-code:reviewer'],
    roster: [{ name: 'designer', enabled: false }, { name: 'reviewer', enabled: false }],
  })
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')

  assert.equal(runtime.consumeNudge('s1'), null)
  assert.equal(runtime.reviewerGate('s1'), null)
})

// --- Defect 1 / 3: policy text tracks the live roster and the budget ------

test('policyText omits a role that is disabled in the live roster', () => {
  const { runtime } = makeRuntime({
    enabled: ['claude-code:reviewer', 'claude-code:designer'],
    roster: [{ name: 'reviewer', enabled: false }, { name: 'designer', enabled: true }],
  })
  const text = runtime.policyText('s1')
  assert.match(text, /designer/)
  assert.doesNotMatch(text, /reviewer/)
})

test('policyText omits a role that is absent from the live roster', () => {
  const { runtime } = makeRuntime({
    enabled: ['claude-code:reviewer', 'claude-code:ghost'],
    roster: [{ name: 'reviewer', enabled: true }],
  })
  const text = runtime.policyText('s1')
  assert.match(text, /reviewer/)
  assert.doesNotMatch(text, /ghost/)
})

test('policyText omits a role whose attempts are spent', () => {
  const { runtime } = makeRuntime({ enabled: ['claude-code:reviewer', 'claude-code:designer'], capPerRole: 1 })
  consult(runtime, 's1', 'reviewer', 'failed')

  const text = runtime.policyText('s1')
  assert.doesNotMatch(text, /- reviewer —/)
  assert.match(text, /- designer —/)
  assert.match(text, /reviewer 1\/1 attempted, 0 answered/, 'spent budget is still reported')
})

test('policyText is empty once every promised role is spent or dead', () => {
  const { runtime } = makeRuntime({ enabled: ['claude-code:reviewer'], capPerRole: 1 })
  assert.notEqual(runtime.policyText('s1'), '')
  consult(runtime, 's1', 'reviewer', 'failed')
  assert.equal(runtime.policyText('s1'), '')
})

test('an unwired roster filters nothing (host degrades, never mutes)', () => {
  const { runtime } = makeRuntime({ enabled: ['claude-code:reviewer'], roster: undefined })
  assert.match(runtime.policyText('s1'), /reviewer/)
})

test('a throwing roster provider is treated as unknown, not as empty', () => {
  const runtime = createAutoConsultRuntime({
    getDefaults: () => ({ enabled: ['claude-code:reviewer'], capPerRole: 3 }),
    getRoster: () => { throw new Error('settings unreadable') },
  })
  assert.match(runtime.policyText('s1'), /reviewer/)
})

// --- Defect 3: override filtering ----------------------------------------

test('setOverride filters unknown / disabled / other-backend keys and reports them', () => {
  const { runtime } = makeRuntime({
    roster: [{ name: 'reviewer', enabled: true }, { name: 'designer', enabled: false }],
  })
  const result = runtime.setOverride('s1', ['reviewer', 'claude-code:designer', 'ghost', 'codex:reviewer', '', 7])

  assert.deepEqual(result.enabled, ['claude-code:reviewer'])
  assert.deepEqual(result.dropped, [
    { key: 'claude-code:designer', reason: 'disabled-role' },
    { key: 'claude-code:ghost', reason: 'unknown-role' },
    { key: 'codex:reviewer', reason: 'other-backend' },
    { key: '', reason: 'invalid' },
    { key: '7', reason: 'invalid' },
  ])

  const snapshot = runtime.snapshot('s1')
  assert.deepEqual(snapshot.session.override, ['claude-code:reviewer'])
  assert.deepEqual(snapshot.session.overrideDropped, result.dropped)
  assert.deepEqual(snapshot.session.enabled, ['reviewer'])
})

test('clearing the override drops its rejection report too', () => {
  const { runtime } = makeRuntime()
  runtime.setOverride('s1', ['ghost'])
  assert.equal(runtime.snapshot('s1').session.overrideDropped.length, 1)

  runtime.setOverride('s1', null)
  const snapshot = runtime.snapshot('s1')
  assert.equal(snapshot.session.override, null)
  assert.deepEqual(snapshot.session.overrideDropped, [])
  assert.deepEqual(snapshot.session.enabled, ['reviewer'], 'back to the config-layer defaults')
})

test('an override wins over the config defaults for the anchors', () => {
  const { runtime } = makeRuntime({ enabled: ['claude-code:reviewer'] })
  runtime.setOverride('s1', ['designer'])
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')

  assert.deepEqual(runtime.consumeNudge('s1'), ['designer'])
  assert.equal(runtime.reviewerGate('s1'), null, 'reviewer is no longer enabled for this session')
})

// --- Snapshot -------------------------------------------------------------

test('snapshot reports flat counts for the composer and the full usage breakdown', () => {
  const { runtime } = makeRuntime({ capPerRole: 4 })
  consult(runtime, 's1', 'reviewer', 'success')
  consult(runtime, 's1', 'reviewer', 'failed')
  consult(runtime, 's1', 'reviewer', 'aborted')

  const snapshot = runtime.snapshot('s1')
  assert.equal(snapshot.session.counts.reviewer, 2, 'the aborted attempt was refunded')
  assert.deepEqual(snapshot.session.usage.reviewer, { attempts: 2, succeeded: 1, failed: 1, aborted: 1 })
  assert.deepEqual(snapshot.session.promised, ['reviewer'])
  assert.deepEqual(snapshot.defaults, { enabled: ['claude-code:reviewer'], capPerRole: 4 })
})

test('snapshot of an untouched session is safe', () => {
  const { runtime } = makeRuntime()
  const snapshot = runtime.snapshot('never-seen')
  assert.equal(snapshot.session.override, null)
  assert.deepEqual(snapshot.session.overrideDropped, [])
  assert.deepEqual(snapshot.session.counts, {})
})

// --- Defect 4: lifecycle --------------------------------------------------

test('dropSession clears override, ledger and turn flags', () => {
  const { runtime } = makeRuntime({ capPerRole: 1 })
  runtime.setOverride('s1', ['designer'])
  runtime.onTurnStart('s1')
  runtime.onWriteTool('s1', 'Write')
  consult(runtime, 's1', 'designer', 'failed')

  runtime.dropSession('s1')

  const snapshot = runtime.snapshot('s1')
  assert.equal(snapshot.session.override, null)
  assert.deepEqual(snapshot.session.counts, {})
  assert.equal(runtime.ledger.attemptsLeft('s1', 'designer'), 1)
  assert.equal(runtime.consumeNudge('s1'), null)
  assert.equal(runtime.reviewerGate('s1'), null)
})

test('wireAutoConsult listens for session/disposed and leaves other sessions intact', async () => {
  const ctx = fakeCtx()
  const { runtime } = makeRuntime({ roster: ROSTER })
  const dispose = wireAutoConsult(ctx, runtime)

  assert.equal(ctx.listenerCount('session/disposed'), 1, 'the disposal listener must exist')

  runtime.setOverride('s1', ['reviewer'])
  runtime.setOverride('s2', ['designer'])
  consult(runtime, 's1', 'reviewer', 'success')
  consult(runtime, 's2', 'designer', 'success')

  await ctx.emit('session/disposed', { id: 's1' })

  assert.equal(runtime.snapshot('s1').session.override, null)
  assert.equal(runtime.ledger.hasSucceeded('s1', 'reviewer'), false)
  assert.deepEqual(runtime.snapshot('s2').session.override, ['claude-code:designer'])
  assert.equal(runtime.ledger.hasSucceeded('s2', 'designer'), true)

  // A malformed disposal must not throw out of the listener.
  await ctx.emit('session/disposed', undefined)
  await ctx.emit('session/disposed', { id: 42 })

  dispose()
  assert.equal(ctx.listenerCount('session/disposed'), 0)
})

// --- Wiring: session/event bookkeeping ------------------------------------

test('session/event drives turn flags, write observation and attempt records', async () => {
  const ctx = fakeCtx()
  const { runtime } = makeRuntime({ enabled: ['claude-code:reviewer', 'claude-code:designer'], capPerRole: 5 })
  const dispose = wireAutoConsult(ctx, runtime)
  ctx.registerAgent('s1')
  const session = { id: 's1' }

  await ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'Write', arguments: '{}' } })
  assert.deepEqual(runtime.consumeNudge('s1'), ['designer'])

  await ctx.emit('session/event', session, {
    type: 'tool/call',
    data: { name: 'consult_expert', arguments: JSON.stringify({ role: 'reviewer' }) },
  })
  // The attempt was observed but nothing was settled: the gate stays open.
  assert.deepEqual(runtime.reviewerGate('s1'), ['reviewer'])

  await ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(runtime.reviewerGate('s1'), null, 'turn/end resets the write flag')

  // Malformed tool arguments must not throw out of the synchronous listener.
  await ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'consult_panel', arguments: '{not json' } })
  dispose()
})

test('agentless (replayed) sessions never move runtime state', async () => {
  const ctx = fakeCtx()
  const { runtime } = makeRuntime()
  const dispose = wireAutoConsult(ctx, runtime)
  const session = { id: 'replayed' } // no agent registered

  await ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'Write', arguments: '{}' } })

  assert.equal(runtime.reviewerGate('replayed'), null)
  assert.equal(runtime.consumeNudge('replayed'), null)
  dispose()
})
