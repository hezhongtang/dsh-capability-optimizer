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

test('legacy auto-consult required mode migrates to the honest hard-remind name', () => {
  const file = defaultSettings()
  file.autoConsult = { enabled: ['reviewer'], capPerRole: 3, mode: 'required' }
  const result = validateSettings(file)
  assert.equal(result.ok, true)
  assert.equal(result.settings.autoConsult.mode, 'hard-remind')
})

test('an explicit advisor with no model may follow the CLI default', () => {
  const ok = validateBackendSettings({ ...defaultBackendSettings(), roles: [oneRole] })
  assert.equal(ok.ok, true)
  const advisor = ok.settings.roles.find((role) => role.name === 'advisor')
  assert.equal(advisor.model, '')
})

test('built-in defaults recommend claude-opus-5 for advisor and leave reviewer unset', () => {
  const roles = defaultBackendSettings().roles
  assert.equal(roles.find((role) => role.name === 'advisor').model, 'claude-opus-5')
  assert.equal(roles.find((role) => role.name === 'reviewer').model, '')
  assert.equal(roles.find((role) => role.name === 'advisor').outputKind, 'advisor')
  assert.equal(roles.find((role) => role.name === 'reviewer').outputKind, 'reviewer')
  assert.equal(roles.find((role) => role.name === 'designer').outputKind, 'designer')
})

test('old built-ins recover their output kind and custom roles default to general', () => {
  const result = validateBackendSettings({
    ...defaultBackendSettings(),
    roles: [
      { ...oneRole, name: 'reviewer' },
      { ...oneRole, name: 'security' },
      { ...oneRole, name: 'architecture-check', outputKind: 'designer' },
    ],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.settings.roles.map((role) => [role.name, role.outputKind]), [
    ['reviewer', 'reviewer'],
    ['security', 'general'],
    ['architecture-check', 'designer'],
  ])
})

test('an advisor model is a user-overridable quality choice', () => {
  const result = validateBackendSettings({
    ...defaultBackendSettings(),
    roles: [{ ...oneRole, model: 'haiku' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.settings.roles[0].model, 'haiku')
})

test('a floating advisor alias is preserved outside a pinned experiment', () => {
  const ok = validateBackendSettings({
    ...defaultBackendSettings(),
    roles: [{ ...oneRole, model: 'opus' }],
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.settings.roles.find((role) => role.name === 'advisor').model, 'opus')
})

test('an advisor may choose a cheaper explicit fallback', () => {
  const result = validateBackendSettings({
    ...defaultBackendSettings(),
    roles: [{ ...oneRole, model: 'claude-opus-5', fallbackModel: 'haiku' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.settings.roles[0].fallbackModel, 'haiku')
})

test('an advisor alias does not void or rewrite the rest of a settings file', () => {
  const file = defaultSettings()
  file.backends['claude-code'].timeoutMs = 123456
  file.backends['claude-code'].extraArgs = ['--disable-slash-commands']
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
  assert.deepEqual(inspected.settings.extraArgs, ['--disable-slash-commands'])
  assert.equal(inspected.settings.roles.find((role) => role.name === 'advisor').model, 'opus')
  assert.equal(inspected.settings.roles.some((role) => role.name === 'reviewer'), true)
  assert.deepEqual(inspected.repairs, [])
  assert.deepEqual(inspected.problems, [])
})

test('explicit advisor model and fallback survive load unchanged', () => {
  const file = defaultSettings()
  file.backends['claude-code'].timeoutMs = 999000
  file.backends['claude-code'].roles = [{ ...oneRole, model: 'haiku', fallbackModel: 'sonnet' }]
  const inspected = inspectSettings(normalizeConfig({}), file)
  const advisor = inspected.settings.roles.find((role) => role.name === 'advisor')
  assert.equal(inspected.fileApplied, true)
  assert.equal(inspected.settings.timeoutMs, 999000)
  assert.equal(advisor.model, 'haiku')
  assert.equal(advisor.fallbackModel, 'sonnet')
  assert.deepEqual(inspected.repairs, [])
})

test('row-config advisor models remain explicit choices', () => {
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
  assert.equal(advisor.model, 'sonnet')
  assert.equal(advisor.fallbackModel, 'haiku')
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
        extraArgs: ['--disable-slash-commands', '--dangerously-skip-permissions', '--add-dir', '/srv/extra'],
        roles: [oneRole],
      },
    },
  }
  const validated = validateSettings(saved)
  assert.equal(validated.ok, true, 'a refused flag must not void the save')
  assert.equal(validated.settings.backends['claude-code'].model, 'sonnet')
  assert.deepEqual(validated.settings.backends['claude-code'].extraArgs, ['--disable-slash-commands', '--add-dir', '/srv/extra'])
  assert.deepEqual(validated.rejectedArgs.map((entry) => entry.arg), ['--dangerously-skip-permissions'])
  assert.equal(validated.settings.rejectedArgs, undefined, 'rejectedArgs must not be persisted into the file')
})
