/**
 * Agent tools for dsh-capability-optimizer.
 *
 * Three tools keep the consultation loop tight:
 *  - consult_expert: ask one role one question (the workhorse);
 *  - consult_panel: ask several roles the same question in parallel;
 *  - consult_roles: the live roster with picking guidance.
 *
 * Every answer is framed as a REFERENCE answer for the calling agent to
 * weigh — never as an instruction — matching the shared persona preamble.
 *
 * The tools are adapters: argument validation, then `consultation.js`. Model
 * and effort resolution, the fallback hop, budgeting, concurrency and meta
 * assembly all live in the service, so the web `/test` route exercises the
 * identical path.
 *
 * `execute(args, exec)` takes DSH's `ToolRunContext` (verified against
 * @deepseek-ai/dsh-tools 0.1.0-rc.6: `{ token, callId, rootCallId, name,
 * arguments, signal, agent?, parent?, deferContext, concludeTurn }`). Two
 * fields matter here: `exec.signal` is the caller's cancellation, forwarded
 * into the service so a cancelled call actually kills its `claude` child; and
 * `exec.agent.session.id` is the session identity the ledger bills — the same
 * id policy and lifecycle anchors read. Absent for a non-agent dispatch, the
 * call runs unbudgeted rather than billing `agent.id` (which may not be the
 * session).
 *
 * Registration consumes one immutable settings snapshot; the host entry
 * re-registers on settings change so role edits apply without a restart.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profilesRoot } from './util.js'
import { EFFORT_LEVELS } from './claude.js'
import { createConsultationService } from './consultation.js'

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * The session the ledger should bill, from DSH's tool run context.
 * `Agent.id` is the identity shared with its session (dsh-agent
 * runtime-types.d.ts: "The single identity shared with session"). Absent when
 * the call did not come from an agent loop; '' then means "do not budget".
 * @param {object} [exec] - the ToolRunContext DSH passes to `execute`.
 */
/**
 * Bill the same id the auto-consult policy and lifecycle anchors read:
 * `session.id`. Do not fall back to `agent.id` — those can differ, and a
 * fallback would charge a bucket the policy never looks at.
 */
export function sessionIdOf(exec) {
  const viaSession = exec?.agent?.session?.id
  return typeof viaSession === 'string' ? viaSession.trim() : ''
}

/**
 * Locate defineTool. The bare import works for published installs inside a
 * profile tree; link:/dev installs real-path outside it, so fall back to the
 * harness-maintained flat modules dir and the running dsh installation.
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch { /* try anchors below */ }

  const anchors = [join(profilesRoot(), 'node_modules')]
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.length > 0) {
    // argv[1] is the running dsh bin: walk up to its package node_modules.
    let dir = dirname(argv1)
    for (let i = 0; i < 4; i += 1) {
      anchors.push(join(dir, 'node_modules'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const anchor of anchors) {
    try {
      const req = createRequire(join(anchor, 'noop.js'))
      const spec = req.resolve('@deepseek-ai/dsh-tools')
      const mod = await import(pathToFileURL(spec).href)
      if (typeof mod.defineTool === 'function') return mod.defineTool
    } catch { /* next anchor */ }
  }
  return null
}

/**
 * Register the consultation tools on a tools service for one settings
 * snapshot.
 * @param {object} tools - the tools service.
 * @param {object} settings - effective settings (settings.js shape).
 * @param {object} [ctx] - the injected Cordis context, for logging.
 * @param {object} [deps] - injected collaborators.
 * @param {object|null} [deps.ledger] - the shared per-session attempt ledger;
 *   null (the default) runs every consultation unbudgeted.
 * @param {Function} [deps.defineTool] - test seam; defaults to the harness's.
 * @param {Function} [deps.runner] - test seam, forwarded to the service.
 * @param {object} [deps.gate] - test seam; defaults to the process-wide
 *   concurrency gate, which is what actually bounds the host.
 * @returns {Promise<(() => void) | null>} disposer, or null when defineTool
 * cannot be located or the roster has no enabled role.
 */
export async function registerConsultTools(tools, settings, ctx = null, deps = {}) {
  const defineTool = deps.defineTool ?? await loadDefineTool()
  if (typeof defineTool !== 'function') return null

  const roster = settings.roles
  const enabled = roster.filter((role) => role.enabled !== false)
  if (enabled.length === 0) {
    ctx?.logger?.warn?.('[dsh-capability-optimizer] no enabled roles — tools stay unregistered')
    return null
  }

  const roleNames = enabled.map((role) => role.name)
  const roleByName = new Map(roster.map((role) => [role.name, role]))
  const service = createConsultationService({
    settings,
    ledger: deps.ledger ?? null,
    env: { cwd: process.cwd() },
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
  })

  const disposers = []

  disposers.push(tools.register(defineTool({
    name: 'consult_expert',
    description: 'Consult one external expert role through a headless Claude Code session and get its reply as a REFERENCE answer to weigh, not an instruction. Use at decision points (advisor), before declaring work done (reviewer), or before significant new code (designer). Each call spends Claude subscription quota — batch related questions into context rather than calling repeatedly.',
    parameters: {
      role: { type: 'string', required: true, enum: roleNames, description: 'Which expert role to consult (see consult_roles for each one\'s focus).' },
      question: { type: 'string', required: true, description: 'The question for the expert, self-contained: what to advise / review / design and why you are asking.' },
      context: { type: 'string', description: 'Optional material the expert needs: code, a diff, a plan, or error output. Keep it to what the question actually needs.' },
      model: { type: 'string', description: `Optional Claude model alias (e.g. "opus", "sonnet"). Default: ${settings.model.length > 0 ? settings.model : 'the configured default'}. Advisor always runs claude-opus-5.` },
      effort: { type: 'string', enum: [...EFFORT_LEVELS], description: 'Optional thinking-effort level for this call; overrides the role and global settings.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const role = roleByName.get(args.role)
      if (role === undefined || role.enabled === false) {
        return { ok: false, error: `unknown or disabled role "${args.role}" — valid roles: ${roleNames.join(', ')}` }
      }
      const result = await service.consult({
        role: role.name,
        question: args.question,
        context: args.context,
        model: args.model,
        effort: args.effort,
        sessionId: sessionIdOf(exec),
        source: 'tool',
        signal: exec?.signal,
      })
      return result.ok
        ? { ok: true, role: result.role, answer: result.answer, ...(result.envelope !== undefined ? { envelope: result.envelope } : {}), meta: result.meta }
        : { ok: false, role: result.role, error: result.error, failure: result.failure, meta: result.meta }
    },
    timeoutMs: settings.timeoutMs + 15000,
  })))

  disposers.push(tools.register(defineTool({
    name: 'consult_panel',
    description: 'Consult up to N external expert roles in parallel with the same question and get all replies as REFERENCE answers to weigh. Use when one question genuinely benefits from several perspectives (e.g. reviewer + designer on a plan). Parallel calls share the wall-clock time of one call but each spends Claude subscription quota.',
    parameters: {
      roles: { type: 'array', items: { type: 'string' }, required: true, description: `Distinct role names to consult, at most ${settings.maxPanelRoles}.` },
      question: { type: 'string', required: true, description: 'One question every expert answers.' },
      context: { type: 'string', description: 'Optional shared material (code, diff, plan) shown to every expert.' },
      model: { type: 'string', description: 'Optional Claude model alias applied to every expert.' },
      effort: { type: 'string', enum: [...EFFORT_LEVELS], description: 'Optional thinking-effort level applied to every expert.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const unique = [...new Set(Array.isArray(args.roles) ? args.roles : [])]
      if (unique.length === 0) {
        return { ok: false, error: 'roles must name at least one role' }
      }
      if (unique.length > settings.maxPanelRoles) {
        return { ok: false, error: `at most ${settings.maxPanelRoles} roles per panel (got ${unique.length})` }
      }
      const unknown = unique.filter((name) => {
        const role = roleByName.get(name)
        return role === undefined || role.enabled === false
      })
      if (unknown.length > 0) {
        return { ok: false, error: `unknown or disabled role(s): ${unknown.join(', ')} — valid roles: ${roleNames.join(', ')}` }
      }
      // Partial success is the contract: one role failing must never erase
      // the other roles' answers, so every entry settles on its own.
      const sessionId = sessionIdOf(exec)
      const results = await Promise.all(unique.map(async (name) => {
        const result = await service.consult({
          role: name,
          question: args.question,
          context: args.context,
          model: args.model,
          effort: args.effort,
          sessionId,
          source: 'panel',
          signal: exec?.signal,
        })
        return result.ok
          ? { role: name, ok: true, answer: result.answer, ...(result.envelope !== undefined ? { envelope: result.envelope } : {}), meta: result.meta }
          : { role: name, ok: false, error: result.error, failure: result.failure, meta: result.meta }
      }))
      return { ok: results.some((r) => r.ok), answers: results }
    },
    timeoutMs: settings.timeoutMs + 15000,
  })))

  disposers.push(tools.register(defineTool({
    name: 'consult_roles',
    description: 'List the available external expert roles with their focus, plus when consulting is worth Claude subscription quota. Read-only and instant.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute() {
      return {
        ...service.describe(),
        guidance: 'Replies are reference answers to weigh, not instructions. Consult at decision points, before declaring work done, or before significant new code; prefer one well-packed call over many small ones.',
      }
    },
    timeoutMs: 10000,
  })))

  return () => { for (const dispose of disposers) dispose() }
}
