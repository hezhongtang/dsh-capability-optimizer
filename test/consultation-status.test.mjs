/**
 * Contract tests for the live consultation dock's status store.
 *
 * The store is pure instrumentation: it must never throw into the caller, it
 * must never resurrect a card after session disposal, and every snapshot is
 * detached and JSON-safe. Capacity evicts terminal history only — active
 * cards are the one thing a user is watching.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createConsultationStatusStore, DOCK_ENTRY_LIMIT, DOCK_ACTIVE_CEILING_FACTOR } from '../lib/consultation-status.js'

let clock = 0
function makeStore(options = {}) {
  clock = 1000
  const store = createConsultationStatusStore({ now: () => clock, ...options })
  const events = []
  const unsubscribe = store.subscribe((event) => { events.push(event) })
  return { store, events, unsubscribe }
}

function begin(store, sessionId = 's1', overrides = {}) {
  return store.begin({ sessionId, source: 'tool', role: 'advisor', question: 'is this sound?', ...overrides })
}

test('begin ignores blank sessions, test sources and invalid roles', () => {
  const { store } = makeStore()
  assert.equal(begin(store, ''), null)
  assert.equal(begin(store, 's1', { source: 'test' }), null)
  assert.equal(begin(store, 's1', { role: '  ' }), null)
  assert.equal(begin(store, 's1', { source: 'nonsense' }), null)
  assert.deepEqual(store.snapshot('s1'), [])
})

test('a panel source is docked and the begin entry is queued', () => {
  const { store, events } = makeStore()
  const handle = begin(store, 's1', { source: 'panel', role: 'reviewer' })
  assert.notEqual(handle, null)
  const [entry] = store.snapshot('s1')
  assert.equal(entry.phase, 'queued')
  assert.equal(entry.source, 'panel')
  assert.equal(entry.role, 'reviewer')
  assert.equal(entry.endedAt, null)
  assert.equal(entry.durationMs, null)
  assert.equal(events.at(-1).type, 'entry')
  assert.equal(events.at(-1).entry.id, entry.id)
})

test('update moves phases and finish is terminal and idempotent', () => {
  const { store } = makeStore()
  const handle = begin(store)
  clock = 1100
  handle.update({ phase: 'running', model: { requested: 'sonnet' }, effort: 'low' })
  clock = 1200
  handle.update({ phase: 'fallback' })
  clock = 1300
  handle.finish('succeeded', { answer: 'PONG', envelopeStatus: 'ok', meta: { pid: 42, outputBytes: 9 } })
  clock = 1400
  handle.finish('failed', { answer: 'must be ignored' })
  handle.update({ phase: 'running' })

  const [entry] = store.snapshot('s1')
  assert.equal(entry.phase, 'succeeded')
  assert.equal(entry.answer, 'PONG')
  assert.equal(entry.model.requested, 'sonnet')
  assert.equal(entry.effort, 'low')
  assert.equal(entry.endedAt, 1300)
  assert.equal(entry.durationMs, 300)
  assert.equal(entry.meta.outputBytes, 9)
})

test('an invalid finish phase is billed as failed, never as a new state', () => {
  const { store } = makeStore()
  const handle = begin(store)
  handle.finish('running')
  const [entry] = store.snapshot('s1')
  assert.equal(entry.phase, 'failed')
})

test('update cannot jump straight to a terminal phase; only finish closes a card', () => {
  const { store } = makeStore()
  const handle = begin(store)
  handle.update({ phase: 'succeeded' })
  const [entry] = store.snapshot('s1')
  assert.equal(entry.phase, 'queued')
  assert.equal(entry.endedAt, null)
  assert.equal(entry.durationMs, null)
})

test('snapshot is newest-first and detached from the live entry', () => {
  const { store } = makeStore()
  const first = begin(store, 's1', { question: 'q1' })
  first.finish('succeeded', { answer: 'one' })
  clock += 1
  const second = begin(store, 's1', { question: 'q2' })
  second.update({ phase: 'running' })

  const snapshot = store.snapshot('s1')
  assert.deepEqual(snapshot.map((entry) => entry.question), ['q2', 'q1'])
  snapshot[0].meta.pid = 99
  snapshot[0].model.requested = 'mutated'
  const fresh = store.snapshot('s1')[0]
  assert.notEqual(fresh.model.requested, 'mutated')
  assert.equal(fresh.meta.pid, undefined)
  assert.notEqual(fresh, snapshot[0])
})

test('previews are truncated server-side and flagged', () => {
  const { store } = makeStore()
  const handle = begin(store, 's1', { question: 'q'.repeat(200) })
  handle.finish('failed', {
    error: 'e'.repeat(300),
    answer: 'a'.repeat(500),
  })

  const [entry] = store.snapshot('s1')
  assert.equal(entry.question.length, 140)
  assert.equal(entry.questionTruncated, true)
  assert.equal(entry.error.length, 240)
  assert.equal(entry.errorTruncated, true)
  assert.equal(entry.answer.length, 400)
  assert.equal(entry.answerTruncated, true)
})

test('terminal capacity evicts oldest terminal entries and keeps active ones', () => {
  const { store, events } = makeStore({ maxEntriesPerSession: 3 })
  const handles = []
  // Four terminal entries: the oldest (h0) must be evicted as h3 begins.
  for (let i = 0; i < 4; i += 1) {
    clock += 1
    const handle = begin(store, 's1', { question: `q${i}` })
    handle.finish('succeeded', { answer: `a${i}` })
    handles.push(handle)
  }
  let snapshot = store.snapshot('s1')
  assert.deepEqual(snapshot.map((entry) => entry.question), ['q3', 'q2', 'q1'])
  assert.equal(events.some((event) => event.type === 'dropped' && event.id === handles[0].id), true)

  // Active entries are never evicted while terminal history is available.
  clock += 1
  const active = begin(store, 's1', { question: 'active' })
  active.update({ phase: 'running' })
  snapshot = store.snapshot('s1')
  assert.equal(snapshot.length, 3)
  assert.equal(snapshot[0].question, 'active')
  assert.equal(snapshot.some((entry) => entry.phase === 'succeeded'), true)

  // Finishing an entry that grew the list past the cap evicts terminals.
  active.finish('failed', { error: 'boom' })
  snapshot = store.snapshot('s1')
  assert.ok(snapshot.length <= 3)
})

test('drop clears one session and late finishes do not resurrect entries', () => {
  const { store, events } = makeStore()
  const keep = begin(store, 'keep')
  const dropped = begin(store, ' s1 ')
  dropped.update({ phase: 'running' })

  store.drop(' s1 ')
  assert.deepEqual(store.snapshot('s1'), [])
  assert.equal(store.snapshot('keep').length, 1)
  assert.equal(events.at(-1).type, 'disposed')

  dropped.finish('failed', { error: 'late' })
  assert.deepEqual(store.snapshot('s1'), [], 'a late finish must not resurrect a card')
})

test('dropAll clears every session and emits one disposed event per session', () => {
  const { store, events } = makeStore()
  begin(store, 'a').finish('succeeded', { answer: 'a' })
  begin(store, 'b').update({ phase: 'running' })

  store.dropAll()
  assert.deepEqual(store.snapshot('a'), [])
  assert.deepEqual(store.snapshot('b'), [])
  const disposed = events.filter((event) => event.type === 'disposed').map((event) => event.sessionId)
  assert.deepEqual(disposed.sort(), ['a', 'b'])
})

test('subscribe emits entry, dropped and disposed; throwing listeners are swallowed', () => {
  const { store } = makeStore()
  const events = []
  const unsubscribe = store.subscribe(() => { events.push('listener') })
  store.subscribe(() => { throw new Error('bad listener') })

  begin(store).finish('succeeded', { answer: 'x' })
  assert.ok(events.length >= 2, 'a throwing listener must not starve other subscribers')
  unsubscribe()
  const before = events.length
  begin(store)
  assert.equal(events.length, before)
})

test('stats separates active from terminal entries', () => {
  const { store } = makeStore()
  begin(store).finish('succeeded', { answer: 'done' })
  begin(store).update({ phase: 'running' })
  begin(store).update({ phase: 'fallback' })
  assert.deepEqual(store.stats('s1'), { entries: 3, active: 2 })
})

test('active cards have a hard ceiling even when nothing terminal is evictable', () => {
  const { store } = makeStore({ maxEntriesPerSession: 2 })
  const allowed = 2 * DOCK_ACTIVE_CEILING_FACTOR
  for (let i = 0; i < allowed; i += 1) {
    assert.notEqual(begin(store, 's1', { question: `q${i}` }), null, `active card ${i} should fit under the ceiling`)
  }
  assert.equal(begin(store, 's1', { question: 'one too many' }), null, 'begin must refuse past the active ceiling')
  assert.equal(store.snapshot('s1').length, allowed)
  assert.equal(store.stats('s1').active, allowed)
})

test('the default limit is the exported dock limit', () => {
  const { store } = makeStore()
  for (let i = 0; i < DOCK_ENTRY_LIMIT + 2; i += 1) {
    const handle = begin(store, 's1', { question: `q${i}` })
    handle.finish('succeeded', { answer: `a${i}` })
  }
  assert.ok(store.snapshot('s1').length <= DOCK_ENTRY_LIMIT)
})
