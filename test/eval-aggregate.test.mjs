/**
 * Aggregation contract for the §5.5 harness.
 *
 * The whole point of §5.5 is to stop "more compute" being read as "better
 * architecture", so the aggregate has two jobs: never average an
 * unmeasurable away, and never report a quality number without the spend that
 * bought it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate } from '../eval/lib/aggregate.mjs'

const trial = (overrides = {}) => ({
  taskId: 't1',
  arm: 'single-low',
  trial: 0,
  ok: true,
  recall: 1,
  seededPrecision: 1,
  findingCount: 2,
  costUsd: 0.01,
  durationMs: 1000,
  ...overrides,
})

test('an arm reports its quality and the spend that bought it', () => {
  const out = aggregate([
    trial({ recall: 1, costUsd: 0.02, durationMs: 1000 }),
    trial({ recall: 0.5, costUsd: 0.04, durationMs: 3000 }),
  ])

  const arm = out.byArm['single-low']
  assert.equal(arm.trials, 2)
  assert.equal(arm.recallMean, 0.75)
  assert.equal(arm.costUsdTotal, 0.06)
  assert.equal(arm.costUsdMean, 0.03)
  assert.equal(arm.durationMsMean, 2000)
})

test('security and envelope reliability stay visible beside quality', () => {
  const out = aggregate([
    trial({ attackSucceeded: false, envelopeStatus: ['ok'] }),
    trial({ attackSucceeded: true, envelopeStatus: ['invalid'] }),
    trial({ attackSucceeded: null, envelopeStatus: ['ok'] }),
  ])
  const arm = out.byArm['single-low']
  assert.equal(arm.attackSuccessRate, 0.5)
  assert.equal(arm.attackN, 2)
  assert.equal(arm.envelopeOkRate, 2 / 3)
})

test('a task that seeds nothing does not average in as recall zero', () => {
  // `recall: null` means "not measurable here", which is not the same fact as
  // "found nothing". Averaging them together silently halves the score.
  const out = aggregate([
    trial({ recall: 1 }),
    trial({ recall: null, seededPrecision: 0 }),
  ])

  assert.equal(out.byArm['single-low'].recallMean, 1)
  assert.equal(out.byArm['single-low'].recallN, 1, 'only measurable trials count toward the mean')
})

test('a failed consultation is reported both ways, never silently', () => {
  const out = aggregate([
    trial({ recall: 1 }),
    trial({ ok: false, failure: 'timeout', recall: null, seededPrecision: null, findingCount: 0 }),
  ])

  const arm = out.byArm['single-low']
  assert.equal(arm.failureRate, 0.5)
  assert.deepEqual(arm.failures, { timeout: 1 })
  assert.equal(arm.recallMean, 1, 'a failure is no measurement, so it does not drag the mean')
  assert.equal(arm.recallMeanCountingFailures, 0.5, 'and it is also reported as a product-level miss')
})

test('arms are comparable at matched spend, not just head to head', () => {
  const out = aggregate([
    trial({ arm: 'panel-3', recall: 1, costUsd: 0.30 }),
    trial({ arm: 'single-high', recall: 1, costUsd: 0.10 }),
  ])

  assert.equal(out.byArm['panel-3'].recallPerUsd, 1 / 0.30)
  assert.equal(out.byArm['single-high'].recallPerUsd, 1 / 0.10)
  assert.deepEqual(out.arms.sort(), ['panel-3', 'single-high'])
})

test('an empty run aggregates to nothing rather than throwing', () => {
  const out = aggregate([])

  assert.deepEqual(out.arms, [])
  assert.deepEqual(out.byArm, {})
})

test('spend with no cost reported stays null instead of counting as free', () => {
  // The CLI does not always report `total_cost_usd` (subscription runs often
  // report 0 or omit it). Treating a missing cost as 0 would make an arm look
  // free and break the entire compute-matched comparison.
  const out = aggregate([
    trial({ costUsd: null }),
    trial({ costUsd: null }),
  ])

  assert.equal(out.byArm['single-low'].costUsdTotal, null)
  assert.equal(out.byArm['single-low'].recallPerUsd, null)
})
