/**
 * Role-specific structured advice contracts.
 *
 * The consultation module has one small interface: choose a role, then ask a
 * question. This module hides the output diversity behind that seam. Every
 * role shares verdict/summary/scope/unknowns, while its decision payload is
 * specific to the work it performs. A schema-valid object is still parsed and
 * checked here because JSON shape is not semantic correctness.
 */
import { roleOutputKind } from './roles.js'

export const VERDICTS = new Set(['pass', 'revise', 'uncertain'])
// `nit` remains readable for 0.5.x envelopes, but the current reviewer schema
// does not solicit non-functional findings.
export const SEVERITIES = new Set(['blocker', 'high', 'medium', 'low', 'nit'])
const CURRENT_SEVERITIES = ['blocker', 'high', 'medium', 'low']

// Anthropic structured outputs support required fields but not minLength.
// Keep the non-empty requirement visible to the model and enforce it in the
// semantic parser below instead of sending an unsupported schema keyword.
const text = (description) => ({
  type: 'string',
  description: `Must be non-empty.${description ? ` ${description}` : ''}`,
})
const texts = (description, minItems = 0) => ({
  type: 'array',
  items: text(),
  ...(minItems > 0 ? { minItems } : {}),
  ...(description ? { description } : {}),
})
const closedObject = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties })

const COMMON_PROPERTIES = {
  verdict: {
    type: 'string',
    enum: [...VERDICTS],
    description: 'pass = sound/ready, revise = a material change is recommended, uncertain = decisive evidence is missing.',
  },
  summary: text('Concise decision-oriented summary.'),
  checked_scope: texts('Files, modules, evidence, or constraints actually inspected.'),
  unknowns: texts('Missing facts or unresolved suspicions; never silently convert these into findings or facts.'),
}

const FINDING = closedObject(
  ['severity', 'location', 'evidence', 'impact', 'minimal_action'],
  {
    severity: {
      type: 'string',
      enum: CURRENT_SEVERITIES,
      description: 'blocker=unsafe to release; high=major security/correctness/data loss; medium=bounded incorrect behavior; low=limited real defect.',
    },
    location: text('Specific file/symbol/line or plan section.'),
    evidence: text('Inspectable evidence and the concrete trigger or failing condition.'),
    impact: text('What materially breaks if left unchanged.'),
    minimal_action: text('Smallest corrective action, not a speculative redesign.'),
  },
)

export const REVIEWER_ENVELOPE_SCHEMA = closedObject(
  ['verdict', 'summary', 'findings', 'checked_scope', 'unknowns'],
  {
    ...COMMON_PROPERTIES,
    findings: { type: 'array', items: FINDING },
  },
)

const ADVISOR_OPTION = closedObject(
  ['option', 'upsides', 'downsides', 'when_to_choose'],
  {
    option: text(),
    upsides: texts('Concrete advantages of this option.', 1),
    downsides: texts('Concrete costs or disadvantages of this option.', 1),
    when_to_choose: text('The observable condition under which this option becomes preferable.'),
  },
)

export const ADVISOR_ENVELOPE_SCHEMA = closedObject(
  [
    'verdict', 'summary', 'recommendation', 'decision_factors', 'options',
    'risks', 'assumptions', 'next_steps', 'checked_scope', 'unknowns',
  ],
  {
    ...COMMON_PROPERTIES,
    recommendation: text('The concrete decision the caller should make.'),
    decision_factors: texts('Facts or constraints that materially determine the recommendation.', 1),
    options: { type: 'array', minItems: 1, items: ADVISOR_OPTION },
    risks: texts('Material risks of the recommendation, not generic caveats.'),
    assumptions: texts('Claims treated as true but not established by the inspected evidence.'),
    next_steps: texts('Ordered, executable next actions.', 1),
  },
)

const DESIGN_INTERFACE = closedObject(
  ['name', 'responsibility', 'inputs', 'outputs'],
  {
    name: text(),
    responsibility: text(),
    inputs: texts(),
    outputs: texts(),
  },
)

const DESIGN_ALTERNATIVE = closedObject(
  ['option', 'tradeoff', 'why_not_default'],
  {
    option: text(),
    tradeoff: text(),
    why_not_default: text(),
  },
)

export const DESIGNER_ENVELOPE_SCHEMA = closedObject(
  [
    'verdict', 'summary', 'proposed_shape', 'interfaces', 'data_flow',
    'failure_modes', 'alternatives', 'risky_interface', 'reversibility',
    'migration_steps', 'validation', 'checked_scope', 'unknowns',
  ],
  {
    ...COMMON_PROPERTIES,
    proposed_shape: text('The coherent module shape and why it fits the workspace.'),
    interfaces: { type: 'array', minItems: 1, items: DESIGN_INTERFACE },
    data_flow: texts('Ordered description of important data/state movement.', 1),
    failure_modes: texts('Material failure modes paired with containment or recovery behavior.', 1),
    alternatives: { type: 'array', minItems: 1, items: DESIGN_ALTERNATIVE },
    risky_interface: text('The interface decision most likely to create irreversible coupling.'),
    reversibility: text('How the risky decision remains replaceable or migratable.'),
    migration_steps: texts('Ordered steps from the current shape to the proposal.'),
    validation: texts('Tests or observable checks that would validate the design.', 1),
  },
)

export const GENERAL_ENVELOPE_SCHEMA = closedObject(
  ['verdict', 'summary', 'recommendations', 'evidence', 'checked_scope', 'unknowns'],
  {
    ...COMMON_PROPERTIES,
    recommendations: texts('Concrete actions or decisions proposed by the custom expert.', 1),
    evidence: texts('Inspectable support for the recommendations.'),
  },
)

const SCHEMAS = Object.freeze({
  advisor: ADVISOR_ENVELOPE_SCHEMA,
  reviewer: REVIEWER_ENVELOPE_SCHEMA,
  designer: DESIGNER_ENVELOPE_SCHEMA,
  general: GENERAL_ENVELOPE_SCHEMA,
})

const TOP_LEVEL_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(SCHEMAS).map(([kind, schema]) => [kind, new Set(schema.required)]),
))

/** Backward-compatible default for direct runner callers: code review. */
export const ADVICE_ENVELOPE_SCHEMA = REVIEWER_ENVELOPE_SCHEMA

/** JSON Schema to pass to Claude for one role. */
export function envelopeSchemaForRole(role) {
  return SCHEMAS[roleOutputKind(role)] ?? GENERAL_ENVELOPE_SCHEMA
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function stringList(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const entry of value) {
    const item = nonEmptyString(entry)
    if (item === null) return null
    out.push(item)
  }
  return out
}

function parseObjectArray(value, fields) {
  if (!Array.isArray(value)) return null
  const out = []
  const allowed = new Set(Object.keys(fields))
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    if (Object.keys(entry).some((field) => !allowed.has(field))) return null
    const item = {}
    for (const [field, kind] of Object.entries(fields)) {
      const parsed = kind === 'list' ? stringList(entry[field]) : nonEmptyString(entry[field])
      if (parsed === null) return null
      item[field] = parsed
    }
    out.push(item)
  }
  return out
}

function parseCommon(value, kind) {
  if (!VERDICTS.has(value.verdict)) return { ok: false, reason: 'bad-verdict' }
  const summary = nonEmptyString(value.summary)
  const checkedScope = stringList(value.checked_scope)
  const unknowns = stringList(value.unknowns)
  if (summary === null) return { ok: false, reason: 'bad-summary' }
  if (checkedScope === null) return { ok: false, reason: 'bad-checked-scope' }
  if (unknowns === null) return { ok: false, reason: 'bad-unknowns' }
  if (value.verdict === 'uncertain' && unknowns.length === 0) {
    return { ok: false, reason: 'uncertain-without-unknowns' }
  }
  return {
    ok: true,
    envelope: {
      kind,
      verdict: value.verdict,
      summary,
      checked_scope: checkedScope,
      unknowns,
    },
  }
}

function parseReviewer(value, common) {
  if (!Array.isArray(value.findings)) return { ok: false, reason: 'bad-findings' }
  const findings = []
  for (const entry of value.findings) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'bad-finding' }
    const allowed = new Set(['severity', 'location', 'evidence', 'impact', 'minimal_action', 'confidence'])
    if (Object.keys(entry).some((field) => !allowed.has(field))) return { ok: false, reason: 'unexpected-finding-field' }
    if (!SEVERITIES.has(entry.severity)) return { ok: false, reason: 'bad-severity' }
    const location = nonEmptyString(entry.location)
    const evidence = nonEmptyString(entry.evidence)
    const impact = nonEmptyString(entry.impact)
    const minimalAction = nonEmptyString(entry.minimal_action)
    if ([location, evidence, impact, minimalAction].includes(null)) return { ok: false, reason: 'incomplete-finding' }
    const finding = { severity: entry.severity, location, evidence, impact, minimal_action: minimalAction }
    // Read old envelopes without perpetuating decorative precision in the new schema.
    const confidence = Number(entry.confidence)
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) finding.confidence = confidence
    findings.push(finding)
  }
  if (value.verdict === 'revise' && findings.length === 0) return { ok: false, reason: 'revise-without-findings' }
  if (value.verdict === 'pass' && findings.length > 0) return { ok: false, reason: 'pass-with-findings' }
  return { ok: true, envelope: { ...common, findings } }
}

function parseAdvisor(value, common) {
  const recommendation = nonEmptyString(value.recommendation)
  const decisionFactors = stringList(value.decision_factors)
  const options = parseObjectArray(value.options, {
    option: 'text', upsides: 'list', downsides: 'list', when_to_choose: 'text',
  })
  const risks = stringList(value.risks)
  const assumptions = stringList(value.assumptions)
  const nextSteps = stringList(value.next_steps)
  if ([recommendation, decisionFactors, options, risks, assumptions, nextSteps].includes(null)) {
    return { ok: false, reason: 'bad-advisor-payload' }
  }
  if (options.length === 0) return { ok: false, reason: 'advisor-needs-option' }
  if (options.some((option) => option.upsides.length === 0 || option.downsides.length === 0)) {
    return { ok: false, reason: 'advisor-option-needs-tradeoff' }
  }
  if (decisionFactors.length === 0 || nextSteps.length === 0) {
    return { ok: false, reason: 'advisor-needs-decision-path' }
  }
  return {
    ok: true,
    envelope: {
      ...common,
      recommendation,
      decision_factors: decisionFactors,
      options,
      risks,
      assumptions,
      next_steps: nextSteps,
    },
  }
}

function parseDesigner(value, common) {
  const proposedShape = nonEmptyString(value.proposed_shape)
  const interfaces = parseObjectArray(value.interfaces, {
    name: 'text', responsibility: 'text', inputs: 'list', outputs: 'list',
  })
  const dataFlow = stringList(value.data_flow)
  const failureModes = stringList(value.failure_modes)
  const alternatives = parseObjectArray(value.alternatives, {
    option: 'text', tradeoff: 'text', why_not_default: 'text',
  })
  const riskyInterface = nonEmptyString(value.risky_interface)
  const reversibility = nonEmptyString(value.reversibility)
  const migrationSteps = stringList(value.migration_steps)
  const validation = stringList(value.validation)
  if ([
    proposedShape, interfaces, dataFlow, failureModes, alternatives,
    riskyInterface, reversibility, migrationSteps, validation,
  ].includes(null)) return { ok: false, reason: 'bad-designer-payload' }
  if (interfaces.length === 0 || alternatives.length === 0) return { ok: false, reason: 'designer-needs-options' }
  if (failureModes.length === 0) return { ok: false, reason: 'designer-needs-failure-mode' }
  if (dataFlow.length === 0 || validation.length === 0) return { ok: false, reason: 'designer-needs-validation-path' }
  return {
    ok: true,
    envelope: {
      ...common,
      proposed_shape: proposedShape,
      interfaces,
      data_flow: dataFlow,
      failure_modes: failureModes,
      alternatives,
      risky_interface: riskyInterface,
      reversibility,
      migration_steps: migrationSteps,
      validation,
    },
  }
}

function parseGeneral(value, common) {
  const recommendations = stringList(value.recommendations)
  const evidence = stringList(value.evidence)
  if (recommendations === null || evidence === null) return { ok: false, reason: 'bad-general-payload' }
  if (recommendations.length === 0) return { ok: false, reason: 'general-needs-recommendation' }
  return { ok: true, envelope: { ...common, recommendations, evidence } }
}

/**
 * Parse and semantically validate a role's structured output.
 * @returns {{ ok: true, envelope: object } | { ok: false, reason: string }}
 */
export function parseEnvelope(raw, role = { outputKind: 'reviewer' }) {
  let value = raw
  if (typeof value === 'string') {
    const source = value.trim()
    if (source.length === 0) return { ok: false, reason: 'empty' }
    try { value = JSON.parse(source) } catch { return { ok: false, reason: 'not-json' } }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not-object' }
  }
  const kind = roleOutputKind(role)
  const allowed = TOP_LEVEL_FIELDS[kind] ?? TOP_LEVEL_FIELDS.general
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    return { ok: false, reason: 'unexpected-field' }
  }
  const common = parseCommon(value, kind)
  if (!common.ok) return common
  if (kind === 'reviewer') return parseReviewer(value, common.envelope)
  if (kind === 'advisor') return parseAdvisor(value, common.envelope)
  if (kind === 'designer') return parseDesigner(value, common.envelope)
  return parseGeneral(value, common.envelope)
}

/**
 * Attach a validated role envelope, or mark the structured-output degrade.
 * Never invents a verdict. Packet overflow remains observable.
 */
export function attachEnvelope(result, overflow = [], role = { outputKind: 'reviewer' }) {
  const extras = Array.isArray(overflow) ? overflow.filter((item) => typeof item === 'string' && item.length > 0) : []
  const raw = result?.meta?.structuredOutput
  const parsed = parseEnvelope(raw !== undefined ? raw : result?.answer, role)
  if (parsed.ok) {
    const envelope = parsed.envelope
    if (extras.length > 0) envelope.unknowns = [...envelope.unknowns, ...extras]
    return {
      ...result,
      envelope,
      meta: { ...result.meta, envelopeStatus: 'ok', envelopeKind: envelope.kind },
    }
  }
  return {
    ...result,
    meta: {
      ...result.meta,
      envelopeStatus: raw !== undefined ? 'invalid' : 'raw',
      envelopeKind: roleOutputKind(role),
      envelopeError: parsed.reason,
      ...(extras.length > 0 ? { packetOverflow: extras } : {}),
    },
  }
}
