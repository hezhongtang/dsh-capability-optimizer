/**
 * Reproducibility pin for the formal consultant experiment.
 *
 * Product settings recommend Opus 5 for the built-in advisor but remain
 * user-overridable. The pre-registered eval is different: it must reject a
 * changed model or floating alias, otherwise results from different model
 * snapshots would be presented as one experiment.
 */

/** Versioned ids only — aliases like `opus` can drift to a later generation. */
export const FORMAL_CONSULTANT_MODELS = new Set(['claude-opus-5'])

/** Product quality recommendation and the current formal-eval pin. */
export const DEFAULT_ADVISOR_MODEL = 'claude-opus-5'

/** Built-in roles that receive the product recommendation by default. */
export const ADVISOR_ROLES = new Set(['advisor'])

export function isAdvisorRole(name) {
  return ADVISOR_ROLES.has(name)
}

export function isFormalConsultantModel(model) {
  return typeof model === 'string' && FORMAL_CONSULTANT_MODELS.has(model)
}

/**
 * Historical aliases that mean "the current top-tier opus". The floating
 * `opus` id is not itself a reproducible eval pin.
 */
export const TOP_TIER_CONSULTANT_ALIASES = new Map([
  ['opus', DEFAULT_ADVISOR_MODEL],
])

/**
 * Classify one model against the current reproducible experiment id.
 * @returns {{ model: string, action: 'empty' | 'keep' | 'upgrade' | 'reject', from?: string }}
 */
export function canonicalizeConsultantModel(model) {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  if (trimmed.length === 0) return { model: '', action: 'empty' }
  if (isFormalConsultantModel(trimmed)) return { model: trimmed, action: 'keep' }
  const upgraded = TOP_TIER_CONSULTANT_ALIASES.get(trimmed)
  if (upgraded !== undefined) return { model: upgraded, action: 'upgrade', from: trimmed }
  return { model: trimmed, action: 'reject' }
}

/**
 * Canonicalization helper retained for eval tooling and old integrations.
 * Product settings and live consultations do not call this function.
 * @returns {{ model: string, action: 'keep' | 'upgrade' | 'pin', from?: string }}
 */
export function pinConsultantModel(model) {
  const classified = canonicalizeConsultantModel(model)
  if (classified.action === 'keep') return { model: classified.model, action: 'keep' }
  if (classified.action === 'upgrade') {
    return { model: classified.model, action: 'upgrade', from: classified.from }
  }
  return {
    model: DEFAULT_ADVISOR_MODEL,
    action: 'pin',
    from: classified.action === 'empty' ? '' : classified.model,
  }
}

/**
 * @param {string} model
 * @param {string[]} roles
 * @param {{ dryRun?: boolean }} [options]
 * @throws {Error} when a formal eval would violate its pre-registered model pin
 */
export function assertConsultantModel(model, roles, options = {}) {
  if (options.dryRun === true) return
  const includesAdvisor = (Array.isArray(roles) ? roles : []).some((role) => ADVISOR_ROLES.has(role))
  if (!includesAdvisor) return
  assertFormalConsultantModel(model, options)
}

/** Pin any explicitly formal experiment, independent of which role it tests. */
export function assertFormalConsultantModel(model, options = {}) {
  if (options.dryRun === true) return
  if (isFormalConsultantModel(model)) return
  throw new Error(
    `formal evaluation must use its pinned model (${[...FORMAL_CONSULTANT_MODELS].join(', ')}); ` +
    `got ${model === undefined || model === '' ? '(empty)' : model}. ` +
    `Use a separate run label for any other model.`,
  )
}


/* Deprecated compatibility names for integrations compiled against 0.5.x. */
export const TOP_TIER_CONSULTANT_MODELS = FORMAL_CONSULTANT_MODELS
export const DEFAULT_TOP_TIER_CONSULTANT_MODEL = DEFAULT_ADVISOR_MODEL
export const HIGH_INTELLECT_ROLES = ADVISOR_ROLES
export const isHighIntellectRole = isAdvisorRole
export const isTopTierConsultantModel = isFormalConsultantModel
