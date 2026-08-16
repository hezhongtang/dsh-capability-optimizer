/**
 * Proactive-consultation runtime for dsh-capability-optimizer.
 *
 * Turns the composer toggle into model-facing behavior through two channels:
 *  - a systemPrompt section whose text is re-derived on every assemble (the
 *    provider receives the assembling agent, so the policy is per session);
 *  - lifecycle nudges with two anchors: the designer anchor queues a short
 *    instruction when a turn's first file-write lands (the pre-step waterfall
 *    injects it into the next step of the same turn), and the reviewer
 *    anchor steers a turn that is about to stop after changing files without
 *    a reviewer pass (agent/turn-stopping + agent.steer runs one more step).
 *
 * Enforcement stays model-mediated by design: a nudge guarantees delivery of
 * the instruction, never the tool call — dsh has no forced-call API and this
 * module does not pretend otherwise. Counting is per session and per role
 * against the policy budget; when a role's budget is exhausted its promise
 * drops out of the policy text and its anchors go quiet, degrading cleanly
 * back to model discretion. A refused nudge is not re-sent within the same
 * turn; the next qualifying anchor (or the next turn) gets one more chance
 * while budget remains.
 *
 * State is host-memory keyed by session id. The web composer pushes per-
 * session overrides over the routes; sessions without an override follow the
 * config-layer defaults live, so tui/headless profiles get the same behavior
 * and config edits hot-apply.
 */
import { randomUUID } from 'node:crypto'
import { normalizeAutoRoleKey, parseActiveRoleKey } from './settings.js'

const PLUGIN = 'dsh-capability-optimizer'

/** Static "when" gloss per built-in role; custom roles lean on their roster entry. */
const ROLE_WHEN = {
  advisor: 'at decision points',
  reviewer: 'before declaring work done',
  designer: 'before significant new code',
}

/**
 * Tools whose invocation counts as "this turn changed workspace files".
 * Matched case-insensitively; substring fallbacks catch naming variants
 * across harness toolsets (write/edit/patch families, minus readers).
 */
function isWriteTool(name) {
  if (typeof name !== 'string') return false
  const tool = name.toLowerCase()
  if (['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'applypatch'].includes(tool)) return true
  return /write|edit|patch/.test(tool) && !tool.includes('read')
}

/** Fresh per-turn anchor flags. */
function newTurn() {
  return { wrote: false, consulted: new Set(), nudged: new Set() }
}

/**
 * Build the nudge as a harness-shaped user message. Prefers the real factory
 * from @deepseek-ai/dsh-llm; the hand-rolled fallback mirrors its shape
 * ({ role: "user", id: uuid, content, source }, frozen by publication).
 * @returns {Promise<{ message: object, fallback: boolean }>}
 */
async function buildNudgeMessage(text, summary) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') {
      return { message: mod.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: PLUGIN, form: 'instructions', summary },
      }), fallback: false }
    }
  } catch { /* fall through to the local shape */ }
  return { message: {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN, form: 'instructions', summary },
  }, fallback: true }
}

/**
 * @param {object} options
 * @param {() => { enabled: string[], capPerRole: number }} options.getDefaults
 *        effective config-layer policy (settings.js effectiveAutoConsult) —
 *        read live so config edits hot-apply to sessions without an override.
 */
export function createAutoConsultRuntime({ getDefaults }) {
  /** @type {Map<string, {override: Set<string> | null, counts: Map<string, number>, turn: object, pending: Set<string>}>} */
  const sessions = new Map()

  function state(sessionId) {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { override: null, counts: new Map(), turn: newTurn(), pending: new Set() }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  /** Effective enabled key set for one session: override ?? live defaults. */
  function enabledKeys(sessionId) {
    const entry = sessions.get(sessionId)
    if (entry !== undefined && entry.override !== null) return entry.override
    return new Set(getDefaults().enabled)
  }

  /** Bare active-backend role names the policy currently asks for. */
  function enabledRoles(sessionId) {
    const roles = []
    for (const key of enabledKeys(sessionId)) {
      const role = parseActiveRoleKey(key)
      if (role !== null) roles.push(role)
    }
    return roles
  }

  function cap() {
    return getDefaults().capPerRole
  }

  function budgetLeft(sessionId, role) {
    const used = sessions.get(sessionId)?.counts.get(role) ?? 0
    return used < cap()
  }

  return {
    /** Forget one session's runtime state (anchor flags, counts, override). */
    dropSession(sessionId) {
      sessions.delete(sessionId)
    },

    /**
     * Composer toggle push: replaces the session override wholesale;
     * `null` clears it (back to following the config-layer defaults live).
     */
    setOverride(sessionId, enabled) {
      if (enabled === null) {
        state(sessionId).override = null
        return
      }
      const keys = new Set()
      for (const entry of Array.isArray(enabled) ? enabled : []) {
        const key = normalizeAutoRoleKey(entry)
        if (key.length > 0) keys.add(key)
      }
      state(sessionId).override = keys
    },

    /** UI snapshot: defaults plus this session's live override and usage. */
    snapshot(sessionId) {
      const entry = sessions.get(sessionId)
      const counts = {}
      if (entry !== undefined) for (const [role, n] of entry.counts) counts[role] = n
      return {
        defaults: getDefaults(),
        session: {
          override: entry !== undefined && entry.override !== null ? [...entry.override] : null,
          enabled: enabledRoles(sessionId),
          counts,
        },
      }
    },

    /** Turn boundary bookkeeping: per-turn anchors reset on turn/start. */
    onTurnStart(sessionId) {
      state(sessionId).turn = newTurn()
    },

    /** Turn bookkeeping close-out (turn/end); flags reset here as a safety net. */
    onTurnEnd(sessionId) {
      state(sessionId).turn = newTurn()
    },

    /**
     * Consultation counting (any origin: policy nudge or model discretion).
     * Counts per role against the budget; a consult_panel call counts once
     * per named role. Also satisfies the current turn's anchors.
     * @param {string} tool - tool name, e.g. 'consult_expert'.
     * @param {{ role?: unknown, roles?: unknown }} args
     */
    onConsultCall(sessionId, tool, args) {
      const names = []
      if (tool === 'consult_expert' && typeof args?.role === 'string') names.push(args.role)
      if (tool === 'consult_panel' && Array.isArray(args?.roles)) {
        for (const role of args.roles) if (typeof role === 'string') names.push(role)
      }
      if (names.length === 0) return
      const entry = state(sessionId)
      for (const name of names) {
        entry.counts.set(name, (entry.counts.get(name) ?? 0) + 1)
        entry.turn.consulted.add(name)
        entry.pending.delete(name)
      }
    },

    /**
     * File-write observation (tool/call for any non-consult tool). Marks the
     * turn as having changed files and arms the designer anchor: first write
     * of a turn with the designer enabled, unconsulted, under budget, and
     * not yet nudged queues a nudge for the next step of this same turn.
     */
    onWriteTool(sessionId, tool) {
      if (!isWriteTool(tool)) return
      const entry = state(sessionId)
      entry.turn.wrote = true
      if (entry.turn.nudged.has('designer') || entry.turn.consulted.has('designer')) return
      if (enabledRoles(sessionId).includes('designer') && budgetLeft(sessionId, 'designer')) {
        entry.turn.nudged.add('designer')
        entry.pending.add('designer')
      }
    },

    /**
     * Reviewer anchor for agent/turn-stopping: a turn that changed files and
     * is about to stop without a reviewer pass earns one steer. Returns the
     * nudge roles to deliver, or null when the gate stays closed.
     */
    reviewerGate(sessionId) {
      const entry = sessions.get(sessionId)
      if (entry === undefined) return null
      if (!entry.turn.wrote) return null
      if (entry.turn.consulted.has('reviewer') || entry.turn.nudged.has('reviewer')) return null
      if (!enabledRoles(sessionId).includes('reviewer') || !budgetLeft(sessionId, 'reviewer')) return null
      entry.turn.nudged.add('reviewer')
      return ['reviewer']
    },

    /**
     * Drain the queued designer nudge for the pre-step injector. Returns the
     * nudge roles once, then clears the queue.
     */
    consumeNudge(sessionId) {
      const entry = sessions.get(sessionId)
      if (entry === undefined || entry.pending.size === 0) return null
      const roles = [...entry.pending]
      entry.pending.clear()
      return roles
    },

    /** Policy section text for one session ('' when nothing is enabled). */
    policyText(sessionId) {
      const roles = enabledRoles(sessionId)
      if (roles.length === 0) return ''
      const lines = [
        'Expert-consultation policy (set by the user for this session):',
        `- Consult these expert roles (${roles.includes('advisor') ? 'advisor is best-effort; the rest are expected, not optional' : 'expected, not optional'}):`,
        ...roles.map((role) => `  - ${role} — ${ROLE_WHEN[role] ?? 'at the moments its roster description calls for'}.`),
        `- Budget: at most ${cap()} consultation call(s) per role per session, shared with your own discretionary calls.`,
        '- Replies stay reference answers to weigh. Skipping a listed consultation requires a one-line reason in your reply.',
      ]
      const entry = sessions.get(sessionId)
      if (entry !== undefined && entry.counts.size > 0) {
        lines.push(`- Already used this session: ${[...entry.counts].map(([role, n]) => `${role} ${n}/${cap()}`).join(', ')}.`)
      }
      return lines.join('\n')
    },
  }
}

/**
 * Wire one runtime into the host: the policy section, the session-event
 * observers, and both nudge anchors. Every listener is optional-by-design —
 * a missing service degrades to "policy only", never to a profile boot
 * failure.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {ReturnType<typeof createAutoConsultRuntime>} runtime
 * @returns {() => void} disposer removing every listener and the section.
 */
export function wireAutoConsult(ctx, runtime) {
  const disposers = []
  const log = (level, message) => ctx.logger?.[level]?.(`[dsh-capability-optimizer] ${message}`)

  // Policy section. The text provider runs on every assemble (each step) and
  // receives the assembling agent, so the policy follows the session's live
  // toggle state and budget without re-registration.
  const uninjectPrompt = ctx.inject(['systemPrompt'], (scope) => {
    disposers.push(scope.systemPrompt.section({
      name: 'capability-optimizer:auto-consult',
      order: 90,
      text: (context) => {
        const sessionId = context?.agent?.session?.id
        return typeof sessionId === 'string' ? runtime.policyText(sessionId) : ''
      },
    }))
  })
  disposers.push(() => { try { uninjectPrompt?.() } catch { /* best effort */ } })

  // Observation + anchor bookkeeping on the session event bus (synchronous
  // dispatch; keep the listener free of awaits). Agentless sessions (no live
  // agent registered) are skipped — replayed history must not move counters.
  disposers.push(ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (typeof ctx.agents?.get === 'function' && ctx.agents.get(sessionId) === undefined) return
    if (event?.type === 'turn/start') runtime.onTurnStart(sessionId)
    else if (event?.type === 'turn/end') runtime.onTurnEnd(sessionId)
    else if (event?.type === 'tool/call') {
      const { name, arguments: raw } = event.data ?? {}
      if (name === 'consult_expert' || name === 'consult_panel') {
        let args = {}
        try { args = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : {} } catch { args = {} }
        runtime.onConsultCall(sessionId, name, args)
      } else {
        runtime.onWriteTool(sessionId, name)
      }
    }
  }))

  // Reviewer anchor: turn-stopping fires when the model would close a turn
  // with nothing queued; steering one nudge runs another step that starts
  // with the instruction. The listener must await the steer: the loop
  // re-checks the inbox right after the serial dispatch, so a floating
  // promise would race the turn close. Refusals are not chased — nudged
  // once per turn.
  disposers.push(ctx.on('agent/turn-stopping', async ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return
    const roles = runtime.reviewerGate(sessionId)
    if (roles === null) return
    const { message } = await buildNudgeMessage(nudgeText(roles), `${PLUGIN}: reviewer gate`)
    try { agent.steer(message) } catch (error) { log('warn', `reviewer steer failed: ${error instanceof Error ? error.message : String(error)}`) }
  }))

  // Designer anchor: drain the queued nudge and append it after the claimed
  // messages so the model meets it as the newest instruction.
  disposers.push(ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return decision
    const roles = runtime.consumeNudge(sessionId)
    if (roles === null) return decision
    signal?.throwIfAborted?.()
    const { message } = await buildNudgeMessage(nudgeText(roles), `${PLUGIN}: designer gate`)
    return { kind: 'enter', messages: [...decision.messages, message] }
  }))

  return () => { for (const dispose of disposers) { try { dispose() } catch { /* best effort */ } } }
}

/** Shared nudge copy for both anchors (roles rendered in tool-call form). */
function nudgeText(roles) {
  const asks = roles.map((role) => `call consult_expert with role "${role}" (${ROLE_WHEN[role] ?? 'as its roster description calls for'})`).join(' and ')
  return `[Consultation policy] Before continuing, ${asks}, passing the relevant code/diff/plan as context. If you decide to skip it, state the reason in one line.`
}
