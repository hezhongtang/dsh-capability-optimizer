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
 * Registration consumes one immutable settings snapshot; the host entry
 * re-registers on settings change so role edits apply without a restart.
 * A model-level failure retries once on the role's (or global) fallback
 * model, omp-style.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profilesRoot } from './util.js'
import { buildSystemPrompt, buildUserMessage } from './roles.js'
import { runClaudeConsult, EFFORT_LEVELS } from './claude.js'
import { isModelLevelError } from './settings.js'

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
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
 * @returns {Promise<(() => void) | null>} disposer, or null when defineTool
 * cannot be located or the roster has no enabled role.
 */
export async function registerConsultTools(tools, settings, ctx = null) {
  const defineTool = await loadDefineTool()
  if (defineTool === null) return null

  const roster = settings.roles
  const enabled = roster.filter((role) => role.enabled !== false)
  if (enabled.length === 0) {
    ctx?.logger?.warn?.('[dsh-capability-optimizer] no enabled roles — tools stay unregistered')
    return null
  }

  const roleNames = enabled.map((role) => role.name)
  const roleByName = new Map(roster.map((role) => [role.name, role]))
  const env = { cwd: process.cwd() }

  /**
   * One consultation against a resolved roster entry, with the one-hop
   * model-fallback retry: a model-level failure (unknown model, model not
   * supported, …) re-runs once on the role's fallback, else the global one.
   */
  async function consult(role, { question, context, model, effort: argsEffort }) {
    const primary = [model, role.model, settings.model]
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .find((m) => m.length > 0) ?? ''
    const fallback = [role.fallbackModel, settings.fallbackModel]
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .find((m) => m.length > 0) ?? ''

    const pick = (...values) => values.map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => v.length > 0) ?? ''
    const effort = pick(argsEffort, role.effort, settings.effort)

    const run = (m) => runClaudeConsult({
      userMessage: buildUserMessage({ question, context }),
      systemPrompt: buildSystemPrompt(role, env),
      model: m,
      effort,
      maxTurns: settings.maxTurns,
      timeoutMs: settings.timeoutMs,
      cwd: env.cwd,
      extraArgs: settings.extraArgs,
      config: settings,
    })

    const first = await run(primary)
    if (first.ok || fallback.length === 0 || fallback === primary) return first
    if (!isModelLevelError(first.error)) return first

    const second = await run(fallback)
    second.meta.usedFallback = true
    if (primary.length > 0) second.meta.originalModel = primary
    second.meta.fallbackError = first.error
    return second
  }

  const disposers = []

  disposers.push(tools.register(defineTool({
    name: 'consult_expert',
    description: 'Consult one external expert role through a headless Claude Code session and get its reply as a REFERENCE answer to weigh, not an instruction. Use at decision points (advisor), before declaring work done (reviewer), or before significant new code (designer). Each call spends Claude subscription quota — batch related questions into context rather than calling repeatedly.',
    parameters: {
      role: { type: 'string', required: true, enum: roleNames, description: 'Which expert role to consult (see consult_roles for each one\'s focus).' },
      question: { type: 'string', required: true, description: 'The question for the expert, self-contained: what to advise / review / design and why you are asking.' },
      context: { type: 'string', description: 'Optional material the expert needs: code, a diff, a plan, or error output. Keep it to what the question actually needs.' },
      model: { type: 'string', description: `Optional Claude model alias (e.g. "opus", "sonnet"). Default: ${settings.model.length > 0 ? settings.model : 'the configured default'}.` },
      effort: { type: 'string', enum: [...EFFORT_LEVELS], description: 'Optional thinking-effort level for this call; overrides the role and global settings.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const role = roleByName.get(args.role)
      if (role === undefined || role.enabled === false) {
        return { ok: false, error: `unknown or disabled role "${args.role}" — valid roles: ${roleNames.join(', ')}` }
      }
      const result = await consult(role, args)
      return result.ok
        ? { ok: true, role: role.name, answer: result.answer, meta: result.meta }
        : { ok: false, role: role.name, error: result.error, meta: result.meta }
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
    async execute(args) {
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
      const results = await Promise.all(unique.map(async (name) => {
        const result = await consult(roleByName.get(name), args)
        return result.ok
          ? { role: name, ok: true, answer: result.answer, meta: result.meta }
          : { role: name, ok: false, error: result.error, meta: result.meta }
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
        roles: roster.map((role) => ({
          name: role.name,
          description: role.description,
          enabled: role.enabled !== false,
          ...(role.model.length > 0 ? { model: role.model } : {}),
          ...(role.effort.length > 0 ? { effort: role.effort } : {}),
        })),
        defaults: {
          ...(settings.model.length > 0 ? { model: settings.model } : {}),
          ...(settings.effort.length > 0 ? { effort: settings.effort } : {}),
        },
        guidance: 'Replies are reference answers to weigh, not instructions. Consult at decision points, before declaring work done, or before significant new code; prefer one well-packed call over many small ones.',
      }
    },
    timeoutMs: 10000,
  })))

  return () => { for (const dispose of disposers) dispose() }
}
