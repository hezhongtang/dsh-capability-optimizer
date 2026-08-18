import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSerialApply } from '../lib/apply-queue.js'

test('a second apply waits and runs again instead of returning skipped', async () => {
  const started = []
  const finished = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let calls = 0

  const apply = createSerialApply(async () => {
    const index = calls
    calls += 1
    started.push(index)
    if (index === 0) await firstGate
    finished.push(index)
    return `run-${index}`
  })

  const first = apply()
  const second = apply()

  await Promise.resolve()
  assert.deepEqual(started, [0], 'the second call must not interleave the first run')

  releaseFirst()
  assert.equal(await first, 'run-0')
  assert.equal(await second, 'run-1')
  assert.deepEqual(finished, [0, 1])
})

test('a failure does not permanently stall later applies', async () => {
  let calls = 0
  const apply = createSerialApply(async () => {
    calls += 1
    if (calls === 1) throw new Error('boom')
    return 'ok'
  })

  await assert.rejects(apply(), /boom/)
  assert.equal(await apply(), 'ok')
})
