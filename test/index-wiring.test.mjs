/**
 * Wiring contract for the live consultation dock's host glue.
 *
 * `lib/index.js` owns two cleanup facts that no unit test of the store or the
 * route can see: a disposed session drops its dock cards, and disposing the
 * plugin drops every session. The apply seam accepts the status store so this
 * test can observe both without booting a real Cordis profile.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

function fakeCtx() {
  const listeners = new Map()
  return {
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      inject() { return () => {} },
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(listener)
        return () => {}
      },
    },
    listeners,
  }
}

test('session/disposed drops one session and plugin dispose calls dropAll', async () => {
  const drops = []
  const consultationStatus = {
    drop(sessionId) { drops.push(['drop', sessionId]) },
    dropAll() { drops.push(['dropAll']) },
  }
  const { ctx, listeners } = fakeCtx()
  const dispose = apply(ctx, {}, { consultationStatus })

  assert.ok(listeners.has('session/disposed'), 'the dock store must observe session disposal')
  const sessionListeners = listeners.get('session/disposed')
  sessionListeners[sessionListeners.length - 1]({ id: 'sess-A' })
  assert.deepEqual(drops, [['drop', 'sess-A']])

  dispose()
  assert.deepEqual(drops, [['drop', 'sess-A'], ['dropAll']])
})
