/**
 * HTTP routes for dsh-capability-optimizer's settings section and composer
 * toggle.
 *
 * GET  /settings           — current settings + effective roster + defaults + file state.
 * POST /settings-save      — validate, atomically persist, hot-apply (same-origin only).
 * POST /settings/reset     — delete the settings file, revert to row-config defaults.
 * POST /test               — run one tiny real consultation end-to-end (CLI + auth +
 *                            proxy), returning the answer and run metadata.
 * GET  /autoconsult        — one session's toggle snapshot: roster, defaults, override, usage.
 * POST /autoconsult-save   — replace one session's toggle override (same-origin only);
 *                            the auto-consult runtime picks it up live.
 */
import { loadSettings, saveSettings, deleteSettings, validateSettings, inspectSettings } from './settings.js'
import { normalizeConfig } from './config.js'
import { resolveClaudeCommand, MODEL_CATALOG } from './claude.js'
import { createConsultationService } from './consultation.js'
import { backendCatalog } from './backends.js'
import {
  ADVISOR_ROLES,
  DEFAULT_ADVISOR_MODEL,
  FORMAL_CONSULTANT_MODELS,
} from './consultant-model.js'

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sameOrigin(request) {
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    return new URL(origin).host === request.headers?.host
  } catch {
    return false
  }
}

async function readJsonBody(request, limit = 512 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register every route on the webServer service.
 * @param {object} host - injected context exposing `webServer`.
 * @param {object} runtime - shared mutable runtime: { rowConfig, loadFileSettings, apply, autoRuntime }.
 * @returns {() => void} disposer removing all routes.
 */
export function mountOptimizerRoutes(host, runtime) {
  const disposers = []
  const log = (level, message) => host.logger?.[level]?.(`[dsh-capability-optimizer] ${message}`)

  /** Effective settings right now (row config ← settings file). */
  const inspect = async () => inspectSettings(normalizeConfig(runtime.rowConfig), await runtime.loadFileSettings())
  const current = async () => (await inspect()).settings

  /** Toggle payload for one session: snapshot plus the live roster it names. */
  const autoPayload = async (sessionId) => ({
    ...runtime.autoRuntime.snapshot(sessionId),
    roles: (await current()).roles.map((role) => ({ name: role.name, label: role.label, enabled: role.enabled !== false })),
  })

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-capability-optimizer/settings',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const { settings: fileSettings, error } = await loadSettings()
        const inspected = inspectSettings(normalizeConfig(runtime.rowConfig), fileSettings)
        sendJson(response, 200, {
          version: 2,
          models: MODEL_CATALOG,
          backends: backendCatalog(),
          effective: inspected.settings,
          autoConsult: inspected.autoConsult,
          fileSettings,
          fileError: error,
          fileExists: fileSettings !== null,
          validationProblems: inspected.problems,
          repairs: inspected.repairs,
          rejectedArgs: inspected.rejectedArgs,
          recommendedAdvisorModels: [...FORMAL_CONSULTANT_MODELS],
          advisorRoles: [...ADVISOR_ROLES],
          defaultAdvisorModel: DEFAULT_ADVISOR_MODEL,
          // Deprecated 0.5.x keys retained for one compatibility window.
          topTierConsultantModels: [...FORMAL_CONSULTANT_MODELS],
          highIntellectRoles: [...ADVISOR_ROLES],
          defaultTopTierConsultantModel: DEFAULT_ADVISOR_MODEL,
          cliCommand: resolveClaudeCommand(inspected.settings),
        })
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-capability-optimizer/settings-save',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'same-origin only' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const validated = validateSettings(body)
        if (!validated.ok) {
          sendJson(response, 400, { problems: validated.problems, rejectedArgs: validated.rejectedArgs })
          return
        }
        const saved = await saveSettings(validated.settings)
        if (!saved.ok) {
          sendJson(response, 500, { error: saved.error })
          return
        }
        const applied = await runtime.apply()
        const inspected = await inspect()
        log('info', `settings saved and applied (${applied})`)
        sendJson(response, 200, {
          ok: true,
          effective: inspected.settings,
          autoConsult: inspected.autoConsult,
          applied: applied === 'applied',
          rejectedArgs: validated.rejectedArgs,
          repairs: inspected.repairs,
          validationProblems: inspected.problems,
          fileSettings: await runtime.loadFileSettings(),
          fileExists: true,
          fileError: null,
        })
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-capability-optimizer/settings/reset',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'same-origin only' })
        return
      }
      try {
        const removed = await deleteSettings()
        if (!removed.ok) {
          sendJson(response, 500, { error: removed.error })
          return
        }
        const applied = await runtime.apply()
        const inspected = await inspect()
        log('info', `settings reset to defaults (${applied})`)
        sendJson(response, 200, {
          ok: true,
          effective: inspected.settings,
          autoConsult: inspected.autoConsult,
          applied: applied === 'applied',
          validationProblems: [],
          repairs: [],
          fileSettings: null,
          fileExists: false,
          fileError: null,
        })
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-capability-optimizer/test',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'same-origin only' })
        return
      }
      // The connection test runs the PRODUCTION consultation path — same
      // service, same model/effort resolution, same fallback hop — so a green
      // result proves the tools work, not merely that some `claude` command
      // works. Only the ping's turn and timeout budget are trimmed, inside the
      // service. It is deliberately unbudgeted: a web click belongs to no
      // agent session, and billing an arbitrary session would be worse than
      // billing none.
      const aborter = new AbortController()
      let answered = false
      response.on('close', () => { if (!answered) aborter.abort() })
      /** Reply unless the client already hung up (which aborted the run). */
      const reply = (status, payload) => {
        answered = true
        if (response.destroyed === true) return
        sendJson(response, status, payload)
      }
      try {
        const body = await readJsonBody(request, 8 * 1024)
        const settings = await current()
        const role = settings.roles.find((r) => r.name === body.role) ?? settings.roles.find((r) => r.enabled !== false)
        if (role === undefined) {
          reply(400, { error: 'no role available to test' })
          return
        }
        const service = createConsultationService({ settings, ledger: null, env: { cwd: process.cwd() } })
        const result = await service.consult({
          role: role.name,
          question: typeof body.question === 'string' && body.question.trim().length > 0
            ? body.question.trim()
            : 'This is a connectivity check, not a substantive consultation. Return a schema-valid response for your assigned role with the exact summary "PONG", no claimed workspace inspection, and no invented findings or facts.',
          model: typeof body.model === 'string' ? body.model : undefined,
          effort: typeof body.effort === 'string' ? body.effort : undefined,
          source: 'test',
          signal: aborter.signal,
        })
        reply(200, {
          role: result.role,
          ok: result.ok,
          ...(result.ok ? { answer: result.answer } : { error: result.error }),
          failure: result.ok ? null : result.failure,
          meta: result.meta,
          effectiveModel: result.meta.effectiveModel ?? '',
          effectiveEffort: result.meta.effectiveEffort ?? '',
          usedFallback: result.meta.usedFallback === true,
          rejectedArgs: Array.isArray(result.meta.rejectedArgs) ? result.meta.rejectedArgs : [],
          envelopeStatus: result.meta.envelopeStatus ?? null,
          ...(result.envelope !== undefined ? { envelope: result.envelope } : {}),
        })
      } catch (error) {
        reply(500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-capability-optimizer/autoconsult',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const sessionId = new URL(request.url, 'http://localhost').searchParams.get('session') ?? ''
        if (sessionId.trim().length === 0) {
          sendJson(response, 400, { error: 'missing session parameter' })
          return
        }
        sendJson(response, 200, await autoPayload(sessionId))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-capability-optimizer/autoconsult-save',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'same-origin only' })
        return
      }
      try {
        const body = await readJsonBody(request, 64 * 1024)
        const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
        if (sessionId.length === 0) {
          sendJson(response, 400, { error: 'missing session' })
          return
        }
        // setOverride reports what it refused (unknown / disabled / other
        // backend / malformed keys). Swallowing that told the UI the toggle
        // was accepted for a role that was silently dropped, so it travels
        // back with the payload; `snapshot().session.overrideDropped` carries
        // the same list for a later GET.
        const applied = runtime.autoRuntime.setOverride(sessionId, body.enabled)
        const dropped = Array.isArray(applied?.dropped) ? applied.dropped : []
        const snapshot = runtime.autoRuntime.snapshot(sessionId)
        const droppedNote = dropped.length > 0 ? `, ${dropped.length} dropped` : ''
        log('info', `auto-consult override set (${snapshot.session.enabled.length} role(s)${droppedNote})`)
        sendJson(response, 200, { ...await autoPayload(sessionId), dropped })
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}
