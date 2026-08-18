/**
 * Settings-layer contracts that the runner and consultation service rely on:
 * a typed dollar budget, and extraArgs refusals that must not void the file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultBackendSettings, defaultSettings, effectiveSettings, inspectSettings, validateBackendSettings, validateSettings } from '../lib/settings.js'
import { normalizeConfig } from '../lib/config.js'

const oneRole = {
  name: 'advisor',
  description: 'test role',
  systemPrompt: 'You are a test persona.',
  enabled: true,
}

test('maxBudgetUsd defaults to 0 (no cap) and accepts fractional dollars', () => {
  assert.equal(defaultBackendSettings().maxBudgetUsd, 0)

  const ok = validateBackendSettings({ ...defaultBackendSettings(), maxBudgetUsd: 2.5, roles: [oneRole] })
  assert.equal(ok.ok, true)
  assert.equal(ok.settings.maxBudgetUsd, 2.5)
})

test('an invalid maxBudgetUsd is a field problem, not a throw', () => {
  const bad = validateBackendSettings({ ...defaultBackendSettings(), maxBudgetUsd: -1, roles: [oneRole] })
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((problem) => problem.includes('maxBudgetUsd')))
})

test('row-config maxBudgetUsd reaches effective settings when no file exists', () => {
  const effective = effectiveSettings(normalizeConfig({ maxBudgetUsd: 1.25 }), null)
  assert.equal(effective.maxBudgetUsd, 1.25)
})

test('an enabled advisor without a model is pinned to claude-opus-5', () => {
  const ok = validateBackendSettings({ ...defaultBackendSettings(), roles: [oneRole] })
  assert.equal(ok.ok, true)
  const advisor = ok.settings.roles.find((role) => role.name === 'advisor')
  assert.equal(advisor.model, 'claude-opus-5')
})

test('built-in defaults pin advisor to claude-opus-5 and leave reviewer unset', () => {
  const roles = defaultBackendSettings().roles
  assert.equal(roles.find((role) => role.name === 'advisor').model, 'claude-opus-5')
  assert.equal(roles.find((role) => role.name === 'reviewer').model, '')
})

test('an enabled advisor on haiku is a field problem, not a silent downgrade', () => {
  const bad = validateBackendSettings({
    ...defaultBackendSettings(),
    roles: [{ ...oneRole, model: 'haiku' }],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((problem) => problem.includes('top-tier')))
})

test('an enabled advisor on opus upgrades to the versioned pin', () => {
  const ok = validateBackendSettings({
    ...defaultBackendSettings(),
    roles: [{ ...oneRole, model: 'opus' }],
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.settings.roles.find((role) => role.name === 'advisor').model, 'claude-opus-5')
})

test('an enabled advisor fallback on haiku is a field problem', () => {
  const bad = validateBackendSettings({
    ...defaultBackendSettings(),
    roles: [{ ...oneRole, model: 'claude-opus-5', fallbackModel: 'haiku' }],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((problem) => problem.includes('fallback') && problem.includes('top-tier')))
})

test('a stale advisor model does not void the rest of a settings file on load', () => {
  const file = defaultSettings()
  file.backends['claude-code'].timeoutMs = 123456
  file.backends['claude-code'].extraArgs = ['--safe-mode']
  file.backends['claude-code'].roles = [
    { ...oneRole, model: 'opus' },
    {
      name: 'reviewer',
      description: 'review',
      systemPrompt: 'Review the change.',
      enabled: true,
    },
  ]
  const inspected = inspectSettings(normalizeConfig({}), file)
  assert.equal(inspected.fileApplied, true)
  assert.equal(inspected.settings.timeoutMs, 123456)
  assert.deepEqual(inspected.settings.extraArgs, ['--safe-mode'])
  assert.equal(inspected.settings.roles.find((role) => role.name === 'advisor').model, 'claude-opus-5')
  assert.equal(inspected.settings.roles.some((role) => role.name === 'reviewer'), true)
  assert.ok(inspected.repairs.some((repair) => repair.path.includes('model') && repair.to === 'claude-opus-5'))
  assert.deepEqual(inspected.problems, [])
})

test('a weaker advisor model is pinned on load instead of dropping the file', () => {
  const file = defaultSettings()
  file.backends['claude-code'].timeoutMs = 999000
  file.backends['claude-code'].roles = [{ ...oneRole, model: 'haiku', fallbackModel: 'sonnet' }]
  const inspected = inspectSettings(normalizeConfig({}), file)
  const advisor = inspected.settings.roles.find((role) => role.name === 'advisor')
  assert.equal(inspected.fileApplied, true)
  assert.equal(inspected.settings.timeoutMs, 999000)
  assert.equal(advisor.model, 'claude-opus-5')
  assert.equal(advisor.fallbackModel, '')
  assert.ok(inspected.repairs.length >= 2)
})

test('row-config advisor models are pinned the same way as the file', () => {
  const effective = effectiveSettings(normalizeConfig({
    roles: [{
      name: 'advisor',
      description: 'row advisor',
      systemPrompt: 'You are a test persona.',
      model: 'sonnet',
      fallbackModel: 'haiku',
    }],
  }), null)
  const advisor = effective.roles.find((role) => role.name === 'advisor')
  assert.equal(advisor.model, 'claude-opus-5')
  assert.equal(advisor.fallbackModel, '')
})

test('unrecoverable file problems stay visible instead of looking like defaults', () => {
  const file = defaultSettings()
  file.backends['claude-code'].roles = []
  const inspected = inspectSettings(normalizeConfig({}), file)
  assert.equal(inspected.fileApplied, false)
  assert.ok(inspected.problems.some((problem) => /roles/.test(problem)))
  assert.equal(inspected.settings.roles.some((role) => role.name === 'advisor'), true)
})

test('a refused extraArg does not fail validation or wipe the rest of the document', () => {
  const saved = {
    version: 2,
    backends: {
      'claude-code': {
        ...defaultBackendSettings(),
        model: 'sonnet',
        extraArgs: ['--safe-mode', '--dangerously-skip-permissions', '--add-dir', '/srv/extra'],
        roles: [oneRole],
      },
    },
  }
  const validated = validateSettings(saved)
  assert.equal(validated.ok, true, 'a refused flag must not void the save')
  assert.equal(validated.settings.backends['claude-code'].model, 'sonnet')
  assert.deepEqual(validated.settings.backends['claude-code'].extraArgs, ['--safe-mode', '--add-dir', '/srv/extra'])
  assert.deepEqual(validated.rejectedArgs.map((entry) => entry.arg), ['--dangerously-skip-permissions'])
  assert.equal(validated.settings.rejectedArgs, undefined, 'rejectedArgs must not be persisted into the file')
})
