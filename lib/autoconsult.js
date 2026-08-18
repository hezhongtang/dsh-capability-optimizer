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
 * module does not pretend otherwise. What IS enforced lives in the ledger
 * (ledger.js): the execution path reserves an attempt before spawning, so the
 * per-role budget refuses an over-quota call instead of merely going quiet.
 * When a role's budget is exhausted its promise drops out of the policy text
 * and its anchors go quiet, degrading cleanly back to model discretion. A
 * refused nudge is not re-sent within the same turn; the next qualifying
 * anchor (or the next turn) gets one more chance while budget remains.
 *
 * Attempts and successes are distinct: an attempt bounds cost, but only a
 * consultation that produced a usable answer *during this turn* satisfies the
 * turn's reviewer/designer anchor. A consultation that failed, timed out or
 * was cancelled leaves the gate open. The success signal is the ledger, not a
 * session event — see wireAutoConsult for why the event bus cannot supply it.
 *
 * The policy only ever promises roles that are live: present and enabled in
 * the roster at read time, and still holding attempts. A composer override
 * naming an unknown, disabled or other-backend role is dropped with a reason
 * the snapshot surfaces to the UI.
 *
 * State is host-memory keyed by session id and released on session/disposed.
 * The web composer pushes per-session overrides over the routes; sessions
 * without an override follow the config-layer defaults live, so tui/headless
 * profiles get the same behavior and config edits hot-apply.
 */
import { randomUUID } from 'node:crypto'
import { normalizeAutoRoleKey, parseActiveRoleKey } from './settings.js'
import { createLedger } from './ledger.js'
import { cancelConsultationSession } from './consultation.js'

const PLUGIN = 'dsh-capability-optimizer'

/** Static "when" gloss per built-in role; custom roles lean on their roster entry. */
const ROLE_WHEN = {
  advisor: 'at decision points',
  reviewer: 'before declaring work done',
  designer: 'before significant new code; if that was missed, at the early post-write architecture checkpoint',
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

/**
 * Fresh per-turn anchor flags.
 * @param {Record<string, number>} successBase - per-role success counts as of
 *        the turn's start; a gate is satisfied only by a success ABOVE this
 *        watermark, so last turn's review does not close this turn's gate.
 */
function newTurn(successBase) {
  return { wrote: false, attempted: new Set(), nudged: new Set(), successBase, warnedWrite: false }
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
 * @param {() => Array<{name: string, enabled?: boolean}>} [options.getRoster]
 *        live role roster (effectiveSettings().roles), so the policy can drop
 *        roles that were deleted or disabled since the toggle was set. When
 *        absent the roster is treated as unknown and no role is filtered out —
 *        an unwired host degrades to the old behavior, never to a mute policy.
 */
export function createAutoConsultRuntime({ getDefaults, getRoster } = {}) {
  /**
   * @type {Map<string, {
   *   override: Set<string> | null,
   *   overrideDropped: Array<{key: string, reason: string}>,
   *   turn: {wrote: boolean, attempted: Set<string>, nudged: Set<string>, successBase: Record<string, number>},
   *   pending: Set<string>,
   * }>}
   */
  const sessions = new Map()

  // Attempts and successes live here, shared with the execution path: the
  // consultation service reserves against this same instance, which is what
  // makes the cap a refusal rather than a suggestion.
  const ledger = createLedger({ getCap: () => getDefaults().capPerRole })

  const rosterKnown = typeof getRoster === 'function'

  /** Live roster as name -> entry; empty (and treated as unknown) when unwired. */
  function roster() {
    if (!rosterKnown) return null
    let entries
    try {
      entries = getRoster()
    } catch {
      return null
    }
    if (!Array.isArray(entries)) return null
    const map = new Map()
    for (const entry of entries) {
      if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string') map.set(entry.name, entry)
    }
    return map
  }

  /** Why `role` is not usable right now, or null when it is. */
  function rosterProblem(map, role) {
    if (map === null) return null // roster unknown: cannot judge, so do not drop
    const entry = map.get(role)
    if (entry === undefined) return 'unknown-role'
    if (entry.enabled === false) return 'disabled-role'
    return null
  }

  /** Per-role success watermark for a fresh turn. */
  function successBaseline(sessionId) {
    const base = {}
    for (const [role, usage] of Object.entries(ledger.usage(sessionId))) base[role] = usage.succeeded
    return base
  }

  function state(sessionId) {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { override: null, overrideDropped: [], turn: newTurn(successBaseline(sessionId)), pending: new Set() }
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

  /**
   * Bare active-backend role names the policy currently asks for, filtered to
   * roles the live roster still offers. Config-layer defaults go through the
   * same filter, so a role deleted or disabled after being enabled in the
   * config never reaches the model as a promise.
   */
  function enabledRoles(sessionId) {
    const map = roster()
    const roles = []
    for (const key of enabledKeys(sessionId)) {
      const role = parseActiveRoleKey(key)
      if (role !== null && rosterProblem(map, role) === null) roles.push(role)
    }
    return roles
  }

  /** Roles the policy may still promise: enabled in the roster AND under budget. */
  function promisedRoles(sessionId) {
    return enabledRoles(sessionId).filter((role) => ledger.attemptsLeft(sessionId, role) > 0)
  }

  function cap() {
    return getDefaults().capPerRole
  }

  /** `off | remind | hard-remind`. Legacy `required` migrates in place. */
  function mode() {
    const raw = getDefaults()?.mode
    if (raw === 'off' || raw === 'hard-remind') return raw
    if (raw === 'required') return 'hard-remind'
    return 'remind'
  }

  /** Whether `role` produced a usable answer since this turn started. */
  function succeededThisTurn(sessionId, role) {
    const entry = sessions.get(sessionId)
    if (entry === undefined) return false
    return ledger.successes(sessionId, role) > (entry.turn.successBase[role] ?? 0)
  }

  /** Anchor precondition shared by both gates. */
  function anchorOpen(sessionId, role) {
    if (succeededThisTurn(sessionId, role)) return false
    if (!enabledRoles(sessionId).includes(role)) return false
    return ledger.attemptsLeft(sessionId, role) > 0
  }

  return {
    /**
     * Attempt/success ledger, shared with the execution path. The integrator
     * hands this to the consultation service so both sides bill one budget.
     */
    ledger,

    /** Forget one session's runtime state and abort its consultations. */
    dropSession(sessionId) {
      sessions.delete(sessionId)
      ledger.drop(sessionId)
      cancelConsultationSession(sessionId)
    },

    /**
     * Composer toggle push: replaces the session override wholesale;
     * `null` clears it (back to following the config-layer defaults live).
     * Keys that name an unknown, disabled or other-backend role are dropped
     * with a reason, which `snapshot()` surfaces so the UI can explain why a
     * box the user ticked is not in force.
     * @returns {{enabled: string[], dropped: Array<{key: string, reason: string}>}}
     */
    setOverride(sessionId, enabled) {
      if (enabled === null) {
        const entry = state(sessionId)
        entry.override = null
        entry.overrideDropped = []
        return { enabled: [], dropped: [] }
      }
      const map = roster()
      const keys = new Set()
      const dropped = []
      for (const candidate of Array.isArray(enabled) ? enabled : []) {
        const key = normalizeAutoRoleKey(candidate)
        if (key.length === 0) {
          dropped.push({ key: typeof candidate === 'string' ? candidate : String(candidate), reason: 'invalid' })
          continue
        }
        if (keys.has(key)) continue
        const role = parseActiveRoleKey(key)
        if (role === null) {
          // Another backend's role: no runner exists for it in this build.
          dropped.push({ key, reason: 'other-backend' })
          continue
        }
        const problem = rosterProblem(map, role)
        if (problem !== null) {
          dropped.push({ key, reason: problem })
          continue
        }
        keys.add(key)
      }
      const entry = state(sessionId)
      entry.override = keys
      entry.overrideDropped = dropped
      return { enabled: [...keys], dropped }
    },

    /** UI snapshot: defaults plus this session's live override, budget and usage. */
    snapshot(sessionId) {
      const entry = sessions.get(sessionId)
      const usage = ledger.usage(sessionId)
      // `counts` stays a flat role -> attempts map: the composer popover reads
      // it directly. `usage` carries the attempt/success breakdown beside it.
      const counts = {}
      for (const [role, tally] of Object.entries(usage)) counts[role] = tally.attempts
      return {
        defaults: getDefaults(),
        session: {
          override: entry !== undefined && entry.override !== null ? [...entry.override] : null,
          overrideDropped: entry !== undefined ? entry.overrideDropped : [],
          enabled: enabledRoles(sessionId),
          promised: promisedRoles(sessionId),
          counts,
          usage,
        },
      }
    },

    /**
     * Opt-in `hard-remind` checkpoint: flag the first write-family tool of a
     * turn when no consultation has succeeded. The host has no pre-execute
     * hook, so this is deliberately a missed-policy diagnostic, not a refusal.
     * @returns {{ missed: boolean, reason?: string }}
     */
    writeCheckpoint(sessionId, tool) {
      if (mode() !== 'hard-remind') return { missed: false }
      if (!isWriteTool(tool)) return { missed: false }
      if (!enabledRoles(sessionId).includes('designer')) return { missed: false }
      if (ledger.attemptsLeft(sessionId, 'designer') <= 0) return { missed: false }
      if (succeededThisTurn(sessionId, 'designer')) return { missed: false }
      const entry = state(sessionId)
      if (entry.turn.warnedWrite === true) return { missed: false }
      entry.turn.warnedWrite = true
      return {
        missed: true,
        reason: 'hard-remind designer checkpoint missed: designer did not answer before this turn wrote files; the write was observed, not blocked',
      }
    },

    /** Turn boundary bookkeeping: per-turn anchors reset on turn/start. */
    onTurnStart(sessionId) {
      state(sessionId).turn = newTurn(successBaseline(sessionId))
    },

    /** Turn bookkeeping close-out (turn/end); flags reset here as a safety net. */
    onTurnEnd(sessionId) {
      state(sessionId).turn = newTurn(successBaseline(sessionId))
    },

    /**
     * Consultation attempt observation (any origin: policy nudge or model
     * discretion). This records that the model tried — it does NOT count
     * against the budget (the ledger already claimed the slot on the
     * execution path) and it does NOT satisfy an anchor, because an attempt
     * is not a review. A `consult_panel` call records one attempt per role.
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
      for (const name of names) entry.turn.attempted.add(name)
    },

    /**
     * File-write observation (tool/call for any non-consult tool). Marks the
     * turn as having changed files and arms the designer anchor: first write
     * of a turn with the designer enabled in the live roster, not yet
     * successfully consulted this turn, under budget, and not yet nudged
     * queues a nudge for the next step of this same turn.
     */
    onWriteTool(sessionId, tool) {
      if (mode() === 'off') return
      if (!isWriteTool(tool)) return
      const entry = state(sessionId)
      entry.turn.wrote = true
      if (entry.turn.nudged.has('designer')) return
      if (anchorOpen(sessionId, 'designer')) {
        entry.turn.nudged.add('designer')
        entry.pending.add('designer')
      }
    },

    /**
     * Reviewer anchor for agent/turn-stopping: a turn that changed files and
     * is about to stop without a *successful* reviewer pass earns one steer.
     * A reviewer consultation that failed, timed out or was cancelled leaves
     * this gate open. Returns the nudge roles to deliver, or null when the
     * gate stays closed.
     */
    reviewerGate(sessionId) {
      if (mode() === 'off') return null
      const entry = sessions.get(sessionId)
      if (entry === undefined) return null
      if (!entry.turn.wrote) return null
      if (entry.turn.nudged.has('reviewer')) return null
      if (!anchorOpen(sessionId, 'reviewer')) return null
      entry.turn.nudged.add('reviewer')
      return ['reviewer']
    },

    /**
     * Drain the queued designer nudge for the pre-step injector. Returns the
     * nudge roles once, then clears the queue. A role that succeeded, lost its
     * budget or left the roster between arming and draining is dropped here,
     * so the model is never told to do something the policy no longer asks for.
     */
    consumeNudge(sessionId) {
      if (mode() === 'off') return null
      const entry = sessions.get(sessionId)
      if (entry === undefined || entry.pending.size === 0) return null
      const roles = [...entry.pending].filter((role) => anchorOpen(sessionId, role))
      entry.pending.clear()
      return roles.length > 0 ? roles : null
    },

    /** Policy section text for one session ('' when nothing is promisable). */
    policyText(sessionId) {
      if (mode() === 'off') return ''
      const roles = promisedRoles(sessionId)
      if (roles.length === 0) return ''
      const lines = [
        'Expert-consultation policy (set by the user for this session):',
        `- Auto-consult mode: ${mode()}${modeGloss(mode())}.`,
        '- Enabled expert roles and their trigger conditions:',
        ...roles.map((role) => `  - ${role} — ${ROLE_WHEN[role] ?? 'at the moments its roster description calls for'}.`),
        '- Consult a role only when its trigger condition actually occurs and the answer is not already available from deterministic checks. Enabling a role is not a blanket call requirement.',
        `- Budget: at most ${cap()} consultation attempt(s) per role per session, shared with your own discretionary calls. A call past the cap is refused, not queued.`,
        '- Replies stay reference answers to weigh. If a trigger occurs but consultation would not add evidence, state the reason in one line.',
      ]
      const usage = Object.entries(ledger.usage(sessionId)).filter(([, tally]) => tally.attempts > 0 || tally.succeeded > 0)
      if (usage.length > 0) {
        lines.push(`- Already used this session: ${usage.map(([role, tally]) => `${role} ${tally.attempts}/${cap()} attempted, ${tally.succeeded} answered`).join('; ')}.`)
      }
      return lines.join('\n')
    },
  }
}

/**
 * Wire one runtime into the host: the policy section, the session-event
 * observers, both nudge anchors, and session disposal. Every listener is
 * optional-by-design — a missing service degrades to "policy only", never to
 * a profile boot failure.
 *
 * On the success signal: DSH does publish a `tool/result` session event
 * (`@deepseek-ai/dsh-session` types, appended by `@deepseek-ai/dsh-agent-loop`),
 * but it cannot tell a successful consultation from a failed one here. Its
 * `message.content[0].isError` reflects whether the *tool* threw or was
 * cancelled, and the consult tools deliberately return `{ ok: false, error }`
 * as a normal result so the model can read the reason — so a failed
 * consultation arrives as isError:false. `consult_panel` compounds this: one
 * result covers several roles with mixed outcomes. Success is therefore taken
 * from the ledger, which the execution path settles per role.
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
    else if (event?.type === 'tool/call' || event?.type === 'tool/before') {
      const { name, arguments: raw } = event.data ?? {}
      if (name === 'consult_expert' || name === 'consult_panel') {
        runtime.onConsultCall(sessionId, name, parseToolArguments(raw))
      } else {
        const checkpoint = runtime.writeCheckpoint(sessionId, name)
        if (checkpoint.missed) log('info', checkpoint.reason)
        runtime.onWriteTool(sessionId, name)
      }
    }
  }))

  // Session lifecycle: dsh-session emits session/disposed exactly once when an
  // announced session leaves the store (including publication rollback), with
  // the session itself as the only argument. Dropping here is what keeps
  // overrides, budgets, pending nudges and turn flags from outliving a closed
  // session. Deliberately NOT gated on ctx.agents: by disposal time the agent
  // is usually gone, and cleanup must run regardless.
  disposers.push(ctx.on('session/disposed', (session) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    runtime.dropSession(sessionId)
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

/**
 * Hosts send `tool/call` arguments as a JSON string or as an already-parsed
 * object. Either shape has to reach `onConsultCall`; treating an object as a
 * string dropped the turn's "already tried" mark.
 */
export function parseToolArguments(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function modeGloss(value) {
  if (value === 'hard-remind') {
    return ' (emphatic reminder: when designer is enabled, a missed pre-write designer checkpoint is logged, never presented as a blocked write)'
  }
  if (value === 'off') return ' (policy and nudges off)'
  return ' (default remind; nudges only, writes are never blocked)'
}

/** Shared nudge copy for both anchors (roles rendered in tool-call form). */
function nudgeText(roles) {
  const asks = roles.map((role) => `call consult_expert with role "${role}" (${ROLE_WHEN[role] ?? 'as its roster description calls for'})`).join(' and ')
  return `[Consultation policy] A configured trigger occurred. Before continuing, ${asks}, passing a focused brief with objective, success criteria, constraints, and relevant artifacts. If deterministic evidence already answers the question or the consult would add no evidence, state the reason in one line.`
}
