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
