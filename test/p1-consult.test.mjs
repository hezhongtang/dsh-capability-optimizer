/**
 * P1 consult path: structured envelope, bounded packet, fingerprint dedupe.
 * Each case drives createConsultationService().consult — the same entry
 * /test and the tools use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConsultationService } from '../lib/consultation.js'
import { resetCliCapabilities } from '../lib/claude.js'
import { defaultSettings, effectiveSettings } from '../lib/settings.js'
import { normalizeConfig } from '../lib/config.js'
import { ACTIVE_BACKEND } from '../lib/backends.js'
import { fakeClaudePath, withEnv } from './helpers/harness.mjs'

function makeSettings(overrides = {}) {
  const file = defaultSettings()
  Object.assign(file.backends[ACTIVE_BACKEND], overrides)
  return effectiveSettings(normalizeConfig({}), file)
}

const ask = (extra = {}) => ({ role: 'advisor', question: 'is this sound?', ...extra })

const REVISE = {
  verdict: 'revise',
  summary: 'guard the null path',
  findings: [{
    severity: 'high',
    confidence: 0.86,
    location: 'lib/x.js:12',
    evidence: 'deref without a null check',
    impact: 'crash on empty input',
    minimal_action: 'return early when value is null',
  }],
  checked_scope: ['lib/x.js'],
  unknowns: [],
}

test('envelope parse: advertised structured fixture returns verdict revise and a finding', async () => {
  resetCliCapabilities()
  const result = await withEnv({
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_STRUCTURED: JSON.stringify(REVISE),
  }, () => createConsultationService({
    settings: makeSettings({ cliPath: fakeClaudePath }),
  }).consult(ask({ question: 'review the null path' })))

  assert.equal(result.ok, true, result.ok ? '' : result.error)
  assert.equal(result.meta.envelopeStatus, 'ok')
  assert.equal(result.envelope.verdict, 'revise')
  assert.ok(result.envelope.findings.length >= 1)
  assert.equal(result.envelope.findings[0].severity, 'high')
})

test('envelope degrade: malformed structured_output is not forged into verdict pass', async () => {
  resetCliCapabilities()
  const result = await withEnv({
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_ANSWER: 'plain prose advice',
    FAKE_CLAUDE_STRUCTURED: 'definitely-not-json',
  }, () => createConsultationService({
    settings: makeSettings({ cliPath: fakeClaudePath }),
  }).consult(ask({ question: 'garbage envelope' })))

  assert.equal(result.ok, true)
  assert.equal(result.answer, 'plain prose advice')
  assert.equal(result.envelope, undefined)
  assert.equal(result.meta.envelopeStatus, 'invalid')
  assert.notEqual(result.meta.envelopeStatus, 'ok')
})

test('envelope degrade: unadvertised schema path stays raw and does not yield pass', async () => {
  resetCliCapabilities()
  const oldHelp = `Options:\n  -p, --print\n  --output-format <format>\n  -h, --help\n`
  const result = await withEnv({
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_ANSWER: 'raw text only',
    FAKE_CLAUDE_HELP: oldHelp,
  }, () => createConsultationService({
    settings: makeSettings({ cliPath: fakeClaudePath }),
  }).consult(ask({ question: 'no schema flag' })))

  assert.equal(result.ok, true)
  assert.equal(result.answer, 'raw text only')
  assert.equal(result.envelope, undefined)
  assert.equal(result.meta.envelopeStatus, 'raw')
})

test('packet bounds: an oversized artifact is truncated and recorded in checked_scope or unknowns', async () => {
  let stdin = ''
  const runner = async (options) => {
    stdin = options.userMessage
    return { ok: true, answer: 'seen', meta: {} }
  }
  const result = await createConsultationService({ settings: makeSettings(), runner }).consult(ask({
    question: 'trim this',
    context: 'DIFF\n' + 'x'.repeat(8000),
    maxPacketBytes: 600,
  }))

  assert.equal(result.ok, true)
  assert.match(stdin, /\[question\]/)
  assert.match(stdin, /UNTRUSTED EVIDENCE/)
  assert.match(stdin, /\[truncated\]/)
  const overflow = [
    ...(result.envelope?.checked_scope ?? []),
    ...(result.envelope?.unknowns ?? []),
    ...(result.meta.packetOverflow ?? []),
  ]
  assert.ok(overflow.some((item) => /truncat/i.test(item)), `expected overflow record, got ${JSON.stringify(overflow)}`)
})

test('fingerprint dedupe: overlapping identical consults spawn once; a changed digest spawns again', async () => {
  let spawns = 0
  const runner = async () => {
    spawns += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { ok: true, answer: `n${spawns}`, meta: {} }
  }
  const service = createConsultationService({ settings: makeSettings(), runner })
  const same = { sessionId: 'dedupe-a', question: 'same q', context: 'same material', source: 'tool' }

  const [first, second] = await Promise.all([
    service.consult(ask(same)),
    service.consult(ask(same)),
  ])
  assert.equal(spawns, 1, 'identical overlapping calls must share one CLI spawn')
  assert.equal(first.answer, second.answer)

  const third = await service.consult(ask({ ...same, context: 'changed material' }))
  assert.equal(spawns, 2, 'a changed context digest must spawn again')
  assert.equal(third.ok, true)
})
