/**
 * Config normalization for dsh-capability-optimizer.
 *
 * The row config is plain data from the composition; nothing here trusts it.
 * Everything has a safe default so the row mounts loose in any profile with
 * an empty config, exactly like the built-in tool rows.
 */

const DEFAULT_TIMEOUT_MS = 300000
const DEFAULT_MAX_TURNS = 8
const MAX_PANEL_ROLES = 4

/**
 * @param {unknown} raw - the plugin row's config value (may be undefined).
 * @returns {{
 *   cliPath: string,
 *   model: string,
 *   timeoutMs: number,
 *   maxTurns: number,
 *   extraArgs: string[],
 *   roles: unknown[],
 *   maxPanelRoles: number,
 * }}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const timeoutMs = positiveInt(source.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxTurns = positiveInt(source.maxTurns, DEFAULT_MAX_TURNS)
  const maxPanelRoles = positiveInt(source.maxPanelRoles, MAX_PANEL_ROLES)

  return {
    cliPath: nonEmptyString(source.cliPath),
    model: nonEmptyString(source.model),
    timeoutMs,
    maxTurns,
    maxPanelRoles,
    extraArgs: Array.isArray(source.extraArgs)
      ? source.extraArgs.filter((arg) => typeof arg === 'string' && arg.length > 0)
      : [],
    roles: Array.isArray(source.roles) ? source.roles : [],
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
