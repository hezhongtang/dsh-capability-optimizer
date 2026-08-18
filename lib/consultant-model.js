/**
 * Capability pin for consultant models.
 *
 * A consult is only worth running if the advice-giver is a stronger coder
 * than the DSH manager that asked. Advisor is the high-intelligence role
 * and must never be assigned a cheaper model. Effort (high vs max) is a
 * thinking-budget knob on the same top-tier model, not a capability drop.
 */

/** Versioned ids only — aliases like `opus` can drift to a later generation. */
export const TOP_TIER_CONSULTANT_MODELS = new Set(['claude-opus-5'])

/** Default pin when an advisor role has no dedicated model. */
export const DEFAULT_TOP_TIER_CONSULTANT_MODEL = 'claude-opus-5'

/** Roles that may only consult a top-tier model. */
export const HIGH_INTELLECT_ROLES = new Set(['advisor'])

export function isHighIntellectRole(name) {
  return HIGH_INTELLECT_ROLES.has(name)
}

export function isTopTierConsultantModel(model) {
  return typeof model === 'string' && TOP_TIER_CONSULTANT_MODELS.has(model)
}

/**
 * Historical aliases that meant "the current top-tier opus". The floating
 * `opus` id is not itself the pin (it can drift), so live eval still refuses
 * it; settings load/save rewrite it to the versioned id.
 */
export const TOP_TIER_CONSULTANT_ALIASES = new Map([
  ['opus', DEFAULT_TOP_TIER_CONSULTANT_MODEL],
])

/**
 * Classify one configured model against the advisor pin.
 * @returns {{ model: string, action: 'empty' | 'keep' | 'upgrade' | 'reject', from?: string }}
 */
export function canonicalizeConsultantModel(model) {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  if (trimmed.length === 0) return { model: '', action: 'empty' }
  if (isTopTierConsultantModel(trimmed)) return { model: trimmed, action: 'keep' }
  const upgraded = TOP_TIER_CONSULTANT_ALIASES.get(trimmed)
  if (upgraded !== undefined) return { model: upgraded, action: 'upgrade', from: trimmed }
  return { model: trimmed, action: 'reject' }
}

/**
 * Force a model onto the advisor pin: empty, alias, or weaker all become
 * `claude-opus-5`. Used when loading a file or resolving a live consult so a
 * stale id cannot void the rest of the document or hop to haiku.
 * @returns {{ model: string, action: 'keep' | 'upgrade' | 'pin', from?: string }}
 */
export function pinConsultantModel(model) {
  const classified = canonicalizeConsultantModel(model)
  if (classified.action === 'keep') return { model: classified.model, action: 'keep' }
  if (classified.action === 'upgrade') {
    return { model: classified.model, action: 'upgrade', from: classified.from }
  }
  return {
    model: DEFAULT_TOP_TIER_CONSULTANT_MODEL,
    action: 'pin',
    from: classified.action === 'empty' ? '' : classified.model,
  }
}

/**
 * @param {string} model
 * @param {string[]} roles
 * @param {{ dryRun?: boolean }} [options]
 * @throws {Error} when a live run would ask a high-intellect role to consult a weaker model
 */
export function assertConsultantModel(model, roles, options = {}) {
  if (options.dryRun === true) return
  const needsTopTier = (Array.isArray(roles) ? roles : []).some((role) => HIGH_INTELLECT_ROLES.has(role))
  if (!needsTopTier) return
  if (isTopTierConsultantModel(model)) return
  throw new Error(
    `advisor must consult a top-tier model (${[...TOP_TIER_CONSULTANT_MODELS].join(', ')}); ` +
    `got ${model === undefined || model === '' ? '(empty)' : model}. ` +
    `A weaker consultant than the DSH manager is not a product-valid condition.`,
  )
}
