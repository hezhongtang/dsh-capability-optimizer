import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileReviewPromptVariant,
  REVIEW_PROMPT_VARIANTS,
} from '../eval/lib/prompt-variants.mjs'

test('review prompt experiment freezes role-free, legacy, and current variants', () => {
  assert.deepEqual([...REVIEW_PROMPT_VARIANTS], ['minimal', 'legacy', 'current'])
  const variants = [...REVIEW_PROMPT_VARIANTS].map((name) => compileReviewPromptVariant(name, '/repo'))
  assert.equal(new Set(variants.map((entry) => entry.hash)).size, 3)
  assert.ok(variants.every((entry) => /^[a-f0-9]{64}$/.test(entry.hash)))
})

test('the minimal arm has a task contract without expert persona decoration', () => {
  const minimal = compileReviewPromptVariant('minimal', '/repo')
  assert.match(minimal.systemPrompt, /Objective: inspect the supplied material/)
  assert.doesNotMatch(minimal.systemPrompt, /Role:|senior|world-class/i)
  assert.ok(minimal.outputSchema.required.includes('findings'))
})

test('legacy and current arms preserve their materially different review policies', () => {
  const legacy = compileReviewPromptVariant('legacy', '/repo')
  const current = compileReviewPromptVariant('current', '/repo')
  assert.match(legacy.systemPrompt, /guilty until proven correct/)
  assert.match(legacy.systemPrompt, /Markdown is fine/)
  assert.ok(legacy.outputSchema.properties.findings.items.required.includes('confidence'))

  assert.match(current.systemPrompt, /try to falsify/)
  assert.match(current.systemPrompt, /Do not report style preferences, non-functional nits, generic hardening ideas/)
  assert.equal(current.outputSchema.properties.findings.items.properties.confidence, undefined)
})

test('an unknown prompt variant is rejected before spending quota', () => {
  assert.throws(() => compileReviewPromptVariant('future', '/repo'), /unknown review prompt variant/)
})
