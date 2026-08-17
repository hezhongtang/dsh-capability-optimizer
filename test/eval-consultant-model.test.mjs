import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertConsultantModel, TOP_TIER_CONSULTANT_MODELS } from '../eval/lib/consultant-model.mjs'

test('advisor on claude-opus-5 is allowed', () => {
  assert.doesNotThrow(() => assertConsultantModel('claude-opus-5', ['advisor', 'reviewer']))
})

test('reviewer-only arms may use a cheaper model (smoke grids)', () => {
  assert.doesNotThrow(() => assertConsultantModel('haiku', ['reviewer']))
})

test('advisor on haiku or sonnet is refused on a live run', () => {
  assert.throws(() => assertConsultantModel('haiku', ['advisor']), /top-tier/)
  assert.throws(() => assertConsultantModel('sonnet', ['reviewer', 'advisor', 'designer']), /top-tier/)
  assert.throws(() => assertConsultantModel('opus', ['advisor']), /top-tier/, 'the floating alias is not the pin')
})

test('dry-run does not enforce the pin (plumbing must stay free)', () => {
  assert.doesNotThrow(() => assertConsultantModel('haiku', ['advisor'], { dryRun: true }))
})

test('the allowlist is the versioned Opus 5 id only', () => {
  assert.deepEqual([...TOP_TIER_CONSULTANT_MODELS], ['claude-opus-5'])
})
