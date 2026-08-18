import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertConsultantModel,
  assertFormalConsultantModel,
  canonicalizeConsultantModel,
  FORMAL_CONSULTANT_MODELS,
  pinConsultantModel,
} from '../lib/consultant-model.js'

test('advisor on claude-opus-5 is allowed', () => {
  assert.doesNotThrow(() => assertConsultantModel('claude-opus-5', ['advisor', 'reviewer']))
})

test('ordinary reviewer smoke runs may use another model', () => {
  assert.doesNotThrow(() => assertConsultantModel('haiku', ['reviewer']))
})

test('a legacy advisor formal check refuses a changed or floating model id', () => {
  assert.throws(() => assertConsultantModel('haiku', ['advisor']), /pinned model/)
  assert.throws(() => assertConsultantModel('sonnet', ['reviewer', 'advisor', 'designer']), /pinned model/)
  assert.throws(() => assertConsultantModel('opus', ['advisor']), /pinned model/, 'the floating alias is not the pin')
})

test('formal prompt experiments pin the model even without an advisor arm', () => {
  assert.doesNotThrow(() => assertFormalConsultantModel('claude-opus-5'))
  assert.throws(() => assertFormalConsultantModel('haiku'), /pinned model/)
})

test('dry-run does not enforce the pin (plumbing must stay free)', () => {
  assert.doesNotThrow(() => assertConsultantModel('haiku', ['advisor'], { dryRun: true }))
})

test('the formal model set contains the versioned Opus 5 id only', () => {
  assert.deepEqual([...FORMAL_CONSULTANT_MODELS], ['claude-opus-5'])
})

test('settings canonicalize upgrades the floating opus alias and refuses haiku', () => {
  assert.deepEqual(canonicalizeConsultantModel('opus'), { model: 'claude-opus-5', action: 'upgrade', from: 'opus' })
  assert.equal(canonicalizeConsultantModel('haiku').action, 'reject')
  assert.equal(pinConsultantModel('haiku').model, 'claude-opus-5')
  assert.equal(pinConsultantModel('').model, 'claude-opus-5')
})
