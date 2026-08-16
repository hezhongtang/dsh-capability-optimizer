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
import { loadSettings, saveSettings, deleteSettings, validateSettings, effectiveSettings, effectiveAutoConsult } from './settings.js'
import { normalizeConfig } from './config.js'
import { runClaudeConsult, resolveClaudeCommand, MODEL_CATALOG } from './claude.js'
import { buildSystemPrompt, buildUserMessage } from './roles.js'
import { backendCatalog } from './backends.js'

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
  const current = async () => effectiveSettings(normalizeConfig(runtime.rowConfig), await runtime.loadFileSettings())

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
        const effective = await current()
        sendJson(response, 200, {
          version: 2,
          models: MODEL_CATALOG,
          backends: backendCatalog(),
          effective,
          autoConsult: effectiveAutoConsult(normalizeConfig(runtime.rowConfig), fileSettings),
          fileSettings,
          fileError: error,
          fileExists: fileSettings !== null,
          cliCommand: resolveClaudeCommand(effective),
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
          sendJson(response, 400, { problems: validated.problems })
          return
        }
        const saved = await saveSettings(validated.settings)
        if (!saved.ok) {
          sendJson(response, 500, { error: saved.error })
          return
        }
        const applied = await runtime.apply()
        log('info', `settings saved and applied (${applied})`)
        sendJson(response, 200, {
          ok: true,
          effective: await current(),
          autoConsult: effectiveAutoConsult(normalizeConfig(runtime.rowConfig), await runtime.loadFileSettings()),
          applied: applied === 'applied',
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
        log('info', `settings reset to defaults (${applied})`)
        sendJson(response, 200, {
          ok: true,
          effective: await current(),
          autoConsult: effectiveAutoConsult(normalizeConfig(runtime.rowConfig), await runtime.loadFileSettings()),
          applied: applied === 'applied',
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
      try {
        const body = await readJsonBody(request, 8 * 1024)
        const settings = await current()
        const role = settings.roles.find((r) => r.name === body.role) ?? settings.roles.find((r) => r.enabled !== false)
        if (role === undefined) {
          sendJson(response, 400, { error: 'no role available to test' })
          return
        }
        const result = await runClaudeConsult({
          userMessage: buildUserMessage({
            question: typeof body.question === 'string' && body.question.trim().length > 0
              ? body.question.trim()
              : 'Reply with the single word PONG and nothing else.',
          }),
          systemPrompt: buildSystemPrompt(role, { cwd: process.cwd() }),
          model: typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : undefined,
          maxTurns: 2,
          timeoutMs: Math.min(settings.timeoutMs, 180000),
          cwd: process.cwd(),
          extraArgs: settings.extraArgs,
          config: settings,
        })
        sendJson(response, 200, { role: role.name, ...result })
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
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
        runtime.autoRuntime.setOverride(sessionId, body.enabled)
        const snapshot = runtime.autoRuntime.snapshot(sessionId)
        log('info', `auto-consult override set (${snapshot.session.enabled.length} role(s))`)
        sendJson(response, 200, await autoPayload(sessionId))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}
