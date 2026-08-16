/**
 * Structured advice envelope for one consultation.
 *
 * The outer consult result stays `{ ok, role, answer, meta }`. This module
 * only parses and validates the inner envelope. A missing or malformed
 * payload is a degrade, never a forged `pass`.
 */

export const VERDICTS = new Set(['pass', 'revise', 'uncertain'])
export const SEVERITIES = new Set(['blocker', 'high', 'medium', 'low', 'nit'])

/** JSON Schema passed to `claude --json-schema` when the CLI advertises it. */
export const ADVICE_ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'checked_scope', 'unknowns'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'confidence', 'location', 'evidence', 'impact', 'minimal_action'],
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          confidence: { type: 'number' },
          location: { type: 'string' },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          minimal_action: { type: 'string' },
        },
      },
    },
    checked_scope: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
}

/**
 * Parse a structured-output object or a JSON string into a validated envelope.
 * @returns {{ ok: true, envelope: object } | { ok: false, reason: string }}
 */
export function parseEnvelope(raw) {
  let value = raw
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return { ok: false, reason: 'empty' }
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'not-json' }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not-object' }
  }
  if (!VERDICTS.has(value.verdict)) return { ok: false, reason: 'bad-verdict' }

  const findings = []
  if (Array.isArray(value.findings)) {
    for (const entry of value.findings) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (!SEVERITIES.has(entry.severity)) continue
      const confidence = Number(entry.confidence)
      findings.push({
        severity: entry.severity,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        location: asString(entry.location),
        evidence: asString(entry.evidence),
        impact: asString(entry.impact),
        minimal_action: asString(entry.minimal_action),
      })
    }
  }

  return {
    ok: true,
    envelope: {
      verdict: value.verdict,
      summary: asString(value.summary),
      findings,
      checked_scope: stringList(value.checked_scope),
      unknowns: stringList(value.unknowns),
    },
  }
}

/**
 * Attach a validated envelope to a successful consult, or mark the degrade.
 * Never invents `verdict: pass`. Packet overflow is recorded on the envelope
 * when present, else on meta.
 */
export function attachEnvelope(result, overflow = []) {
  const extras = Array.isArray(overflow) ? overflow.filter((item) => typeof item === 'string' && item.length > 0) : []
  const raw = result?.meta?.structuredOutput
  const parsed = parseEnvelope(raw !== undefined ? raw : result?.answer)
  if (parsed.ok) {
    const envelope = parsed.envelope
    if (extras.length > 0) envelope.checked_scope = [...envelope.checked_scope, ...extras]
    return {
      ...result,
      envelope,
      meta: { ...result.meta, envelopeStatus: 'ok' },
    }
  }
  return {
    ...result,
    meta: {
      ...result.meta,
      envelopeStatus: raw !== undefined ? 'invalid' : 'raw',
      ...(extras.length > 0 ? { packetOverflow: extras } : {}),
    },
  }
}
