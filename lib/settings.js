/**
 * Durable settings for dsh-capability-optimizer.
 *
 * File shape v2 (multi-backend, one workspace per harness CLI):
 *
 *   { version: 2, backends: { "claude-code": { …flat settings… } } }
 *
 * Only backends with a runner are stored; reserved harnesses (codex, zcode,
 * …) exist in the UI catalog (backends.js), not in the file. A v1 flat file
 * migrates on read: its fields become the claude-code backend verbatim.
 *
 * Resolution order for the active backend's effective settings:
 *   built-in defaults  ←  row config (cordis.patch.yml)  ←  settings file
 * The roles array is replaced wholesale by whichever layer last supplied it;
 * on first save the built-ins are copied into the file so every role is
 * editable in place. A disabled role (omp-style `enabled: false`) stays in
 * the roster but drops out of the tools' enum until re-enabled.
 *
 * One plugin-owned JSON file under $DSH_HOME, written with the same
 * atomic-replace discipline dsh's own JSON storage uses (temp file + fsync +
 * rename + directory fsync), so a crash can never leave a torn file.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BUILTIN_ROLES, slugifyRoleName } from './roles.js'
import { EFFORT_LEVELS } from './claude.js'
import { ACTIVE_BACKEND } from './backends.js'

/** Model-level failure patterns (omp-derived plus Claude CLI tags): these
 * warrant a fallback retry. `unrecognized_model` is the CLI's own tag. */
const MODEL_LEVEL_ERROR = /invalid_request_error|unrecognized[_ ]model|model[_ ]not[_ ]found|is not supported when|does not exist|unknown model|invalid model|no such model/i

/** @returns {string} absolute path of the settings file. */
export function settingsFilePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-capability-optimizer', 'settings.json')
}

/**
 * The editable per-backend settings seeded from built-ins. Role fields follow
 * omp's advisor roster (name / model / instructions / enabled) plus one-hop
 * `fallbackModel` for model-level failures and a thinking-effort override.
 */
function defaultRoleFrom(role) {
  return {
    name: role.name,
    label: '',
    description: role.description,
    systemPrompt: role.systemPrompt,
    model: '',
    fallbackModel: '',
    effort: '',
    enabled: true,
  }
}

/** Flat defaults for one backend workspace (claude-code today). */
export function defaultBackendSettings() {
  return {
    cliPath: '',
    model: '',
    fallbackModel: '',
    effort: '',
    timeoutMs: 300000,
    maxTurns: 8,
    maxPanelRoles: 4,
    extraArgs: [],
    roles: BUILTIN_ROLES.map(defaultRoleFrom),
  }
}

/** Whole-file v2 defaults. */
export function defaultSettings() {
  return { version: 2, backends: { [ACTIVE_BACKEND]: defaultBackendSettings() } }
}

/**
 * Normalize any historical file shape to v2. A v2 document passes through
 * (unknown backends preserved verbatim); a v1 flat document nests under the
 * active backend; anything else becomes v2 defaults.
 */
export function toV2(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultSettings()
  if (parsed.backends !== null && typeof parsed.backends === 'object' && !Array.isArray(parsed.backends)) {
    return { version: 2, backends: parsed.backends }
  }
  // v1 flat: every field belongs to the (then only) backend.
  const { version: _version, ...flat } = parsed
  return { version: 2, backends: { [ACTIVE_BACKEND]: flat } }
}

/**
 * Read the settings file; a missing file yields null (callers fall back to
 * row config), an unreadable one yields null with the reason logged by the
 * caller through the returned `error`. The result is already v2.
 * @returns {Promise<{settings: object | null, error: string | null}>}
 */
export async function loadSettings() {
  try {
    const text = await readFile(settingsFilePath(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: null, error: 'settings file is not a JSON object' }
    }
    return { settings: toV2(parsed), error: null }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { settings: null, error: null }
    return { settings: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Validate one backend workspace (the claude-code shape).
 * Returns the clean flat settings, or field-qualified problems.
 * @returns {{ok: true, settings: object} | {ok: false, problems: string[]}}
 */
export function validateBackendSettings(candidate) {
  const problems = []
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, problems: ['backend settings must be an object'] }
  }
  const out = defaultBackendSettings()

  out.cliPath = nonEmptyString(candidate.cliPath)
  out.model = nonEmptyString(candidate.model)
  out.fallbackModel = nonEmptyString(candidate.fallbackModel)
  out.effort = effortOrProblem(candidate.effort, 'effort', problems)

  out.timeoutMs = positiveInt(candidate.timeoutMs, 300000, 'timeoutMs', problems)
  out.maxTurns = positiveInt(candidate.maxTurns, 8, 'maxTurns', problems)
  out.maxPanelRoles = positiveInt(candidate.maxPanelRoles, 4, 'maxPanelRoles', problems, 32)

  if (Array.isArray(candidate.extraArgs)) {
    out.extraArgs = candidate.extraArgs.filter((arg) => typeof arg === 'string' && arg.trim().length > 0).map((arg) => arg.trim())
  }

  if (!Array.isArray(candidate.roles) || candidate.roles.length === 0) {
    problems.push('roles must be a non-empty array')
  } else {
    const seen = new Map()
    const roles = []
    for (const [index, entry] of candidate.roles.entries()) {
      if (entry === null || typeof entry !== 'object') {
        problems.push(`roles[${index}] must be an object`)
        continue
      }
      const name = slugifyRoleName(entry.name ?? '')
      if (name.length === 0) {
        problems.push(`roles[${index}]: missing or invalid name`)
        continue
      }
      if (seen.has(name)) {
        problems.push(`roles[${index}]: duplicate role name "${name}"`)
        continue
      }
      const systemPrompt = typeof entry.systemPrompt === 'string' ? entry.systemPrompt.trim() : ''
      if (systemPrompt.length === 0 && entry.enabled !== false) {
        problems.push(`roles[${index}] ("${name}"): systemPrompt required for an enabled role`)
      }
      seen.set(name, true)
      roles.push({
        name,
        label: nonEmptyString(entry.label),
        description: typeof entry.description === 'string' && entry.description.trim().length > 0 ? entry.description.trim() : `Custom expert role "${name}".`,
        systemPrompt,
        model: nonEmptyString(entry.model),
        fallbackModel: nonEmptyString(entry.fallbackModel),
        effort: effortOrProblem(entry.effort, `roles[${index}] ("${slugifyRoleName(entry.name ?? '')}").effort`, problems),
        enabled: entry.enabled !== false,
      })
    }
    if (roles.filter((role) => role.enabled).length === 0 && problems.length === 0) {
      problems.push('at least one role must stay enabled')
    }
    out.roles = roles
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, settings: out }
}

/**
 * Validate a whole v2 document (or a v1 flat document, which migrates).
 * The active backend is fully validated; other stored backends are preserved
 * verbatim so a future runner's saved shape survives round-trips today.
 * @returns {{ok: true, settings: object} | {ok: false, problems: string[]}}
 */
export function validateSettings(candidate) {
  const v2 = toV2(candidate)
  const active = v2.backends[ACTIVE_BACKEND]
  const validated = validateBackendSettings(active === undefined ? defaultBackendSettings() : active)
  if (!validated.ok) return validated
  return { ok: true, settings: { version: 2, backends: { ...v2.backends, [ACTIVE_BACKEND]: validated.settings } } }
}

/**
 * Merge the three layers into the ACTIVE backend's effective settings (the
 * flat shape the tools consume). Row config stays flat v1: it predates
 * backends and targets the only runner.
 * @param {object} rowConfig - normalized row config (config.js).
 * @param {object | null} fileSettings - v2 settings file, when present.
 */
export function effectiveSettings(rowConfig, fileSettings) {
  const base = {
    ...defaultBackendSettings(),
    cliPath: rowConfig.cliPath || '',
    model: rowConfig.model || '',
    fallbackModel: '',
    timeoutMs: rowConfig.timeoutMs,
    maxTurns: rowConfig.maxTurns,
    maxPanelRoles: rowConfig.maxPanelRoles,
    extraArgs: rowConfig.extraArgs,
    roles: undefined,
  }
  // Row-config roles (if any) replace built-ins wholesale; slug-normalized.
  if (rowConfig.roles.length > 0) {
    const merged = new Map(BUILTIN_ROLES.map(defaultRoleFrom).map((role) => [role.name, role]))
    for (const entry of rowConfig.roles) {
      if (entry === null || typeof entry !== 'object') continue
      const name = slugifyRoleName(entry.name ?? '')
      const systemPrompt = typeof entry.systemPrompt === 'string' ? entry.systemPrompt.trim() : ''
      if (name.length === 0 || systemPrompt.length === 0) continue
      merged.set(name, {
        name,
        label: typeof entry.label === 'string' ? entry.label.trim() : '',
        description: typeof entry.description === 'string' && entry.description.trim().length > 0 ? entry.description.trim() : `Custom expert role "${name}".`,
        systemPrompt,
        model: typeof entry.model === 'string' ? entry.model.trim() : '',
        fallbackModel: typeof entry.fallbackModel === 'string' ? entry.fallbackModel.trim() : '',
        effort: typeof entry.effort === 'string' && EFFORT_LEVELS.has(entry.effort.trim()) ? entry.effort.trim() : '',
        enabled: entry.enabled !== false,
      })
    }
    base.roles = [...merged.values()]
  } else {
    base.roles = defaultBackendSettings().roles
  }

  if (fileSettings === null) return base
  const validated = validateSettings(fileSettings)
  if (!validated.ok) return base
  return { ...base, ...validated.settings.backends[ACTIVE_BACKEND] }
}

/**
 * Atomically persist settings (temp + fsync + rename + dir fsync).
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function saveSettings(settings) {
  const path = settingsFilePath()
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    if (process.platform !== 'win32') {
      const dir = await open(dirname(path), 'r')
      try { await dir.sync() } finally { await dir.close() }
    }
    return { ok: true }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Remove the settings file (UI "reset to defaults"). */
export async function deleteSettings() {
  try {
    await rm(settingsFilePath(), { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether a consult failure looks model-level (worth a fallback-model retry). */
export function isModelLevelError(text) {
  return typeof text === 'string' && MODEL_LEVEL_ERROR.test(text)
}

/** Validate one effort value: '' (inherit) or a legal CLI level. */
function effortOrProblem(value, field, problems) {
  const effort = nonEmptyString(value)
  if (effort.length === 0) return ''
  if (!EFFORT_LEVELS.has(effort)) {
    problems.push(`${field} must be one of: ${[...EFFORT_LEVELS].join(', ')} (or empty)`)
    return ''
  }
  return effort
}

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value, fallback, field, problems, max = 3600000) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || Math.floor(n) !== n || n <= 0 || n > max) {
    problems.push(`${field} must be a positive integer (≤ ${max})`)
    return fallback
  }
  return n
}
