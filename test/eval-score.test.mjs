/**
 * Scoring contract for the §5.5 evaluation harness.
 *
 * The scorer decides whether a consultant's finding identifies a defect we
 * deliberately seeded. Everything downstream — recall, the arm comparison, any
 * claim about whether consultation helps — rests on this one judgement, so it
 * is deterministic, conservative, and auditable rather than model-judged.
 *
 * The bias is deliberate: a rule that is too strict understates the plugin's
 * value, which is the safe direction to be wrong in. An unmatched finding is
 * never called a false positive — it is returned verbatim for a human to read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreFindings, parseLocation } from '../eval/lib/score.mjs'

const BUG = {
  id: 'unbounded-cache',
  file: 'src/cache.js',
  line: 42,
  keywords: ['unbounded', 'evict', 'memory'],
}

const finding = (overrides = {}) => ({
  severity: 'high',
  confidence: 0.8,
  location: 'src/cache.js:42',
  evidence: 'the map grows unbounded; nothing evicts entries',
  impact: 'memory exhaustion',
  minimal_action: 'add an LRU bound',
  ...overrides,
})

test('parseLocation reads the shapes a model actually writes', () => {
  assert.deepEqual(parseLocation('src/cache.js:42'), { file: 'src/cache.js', line: 42 })
  assert.deepEqual(parseLocation('src/cache.js:42-58'), { file: 'src/cache.js', line: 42 })
  assert.deepEqual(parseLocation('src/cache.js'), { file: 'src/cache.js', line: null })
  assert.deepEqual(parseLocation('  lib/a.js line 7 '), { file: 'lib/a.js', line: 7 })
  assert.deepEqual(parseLocation(''), { file: '', line: null })
})

test('a finding at the seeded line naming the defect counts as found', () => {
  const result = scoreFindings([finding()], [BUG])

  assert.equal(result.found.length, 1)
  assert.equal(result.found[0].bugId, 'unbounded-cache')
  assert.equal(result.recall, 1)
  assert.deepEqual(result.missed, [])
  assert.deepEqual(result.unmatched, [])
})

test('the same defect described in a different file is not a match', () => {
  const result = scoreFindings([finding({ location: 'src/other.js:42' })], [BUG])

  assert.equal(result.recall, 0)
  assert.deepEqual(result.missed, ['unbounded-cache'])
  assert.equal(result.unmatched.length, 1, 'the finding is reported, not discarded')
})

test('a finding far from the seeded line is not a match', () => {
  const result = scoreFindings([finding({ location: 'src/cache.js:400' })], [BUG])

  assert.equal(result.recall, 0)
  assert.equal(result.unmatched.length, 1)
})

test('a finding with no line still matches on file plus vocabulary', () => {
  // Models routinely answer with a bare path. Refusing those would understate
  // recall for a reason that has nothing to do with whether they found the bug.
  const result = scoreFindings([finding({ location: 'src/cache.js' })], [BUG])

  assert.equal(result.recall, 1)
})

test('the right place with unrelated words is not a match', () => {
  const result = scoreFindings([finding({
    evidence: 'the variable name here is unclear',
    impact: 'readability',
    minimal_action: 'rename it',
  })], [BUG])

  assert.equal(result.recall, 0)
  assert.equal(result.unmatched.length, 1)
})

test('one finding cannot satisfy two seeded defects', () => {
  const second = { id: 'race', file: 'src/cache.js', line: 44, keywords: ['unbounded'] }
  const result = scoreFindings([finding()], [BUG, second])

  assert.equal(result.found.length, 1)
  assert.equal(result.recall, 0.5)
  assert.deepEqual(result.missed, ['race'])
})

test('seeded precision is the share of findings that land on a seeded defect', () => {
  const noise = finding({
    location: 'src/unrelated.js:3',
    evidence: 'style nit',
    impact: 'none',
    minimal_action: 'reformat',
  })
  const result = scoreFindings([finding(), noise], [BUG])

  assert.equal(result.recall, 1)
  assert.equal(result.seededPrecision, 0.5)
  assert.equal(result.unmatched.length, 1)
  assert.equal(result.unmatched[0].location, 'src/unrelated.js:3',
    'unmatched findings stay readable — they may be real bugs we did not seed')
})

test('an empty findings list scores zero recall without dividing by zero', () => {
  const result = scoreFindings([], [BUG])

  assert.equal(result.recall, 0)
  assert.equal(result.seededPrecision, null, 'precision is undefined with no findings, not 0')
  assert.deepEqual(result.missed, ['unbounded-cache'])
})

test('a task with no seeded defects reports null recall rather than a fake 1', () => {
  const result = scoreFindings([finding()], [])

  assert.equal(result.recall, null)
  assert.equal(result.seededPrecision, 0)
})
