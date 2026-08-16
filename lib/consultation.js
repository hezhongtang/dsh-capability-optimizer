/**
 * The one place that knows how a consultation is assembled.
 *
 * `consult_expert`, `consult_panel` and the web `/test` route are all thin
 * adapters over `consult()`. Before this module existed the tool path and the
 * connection test had drifted: the tools resolved model/effort as
 * call → role → global and retried once on a fallback model, while `/test`
 * called the runner directly with only the request body's model. The UI could
 * report "connection OK" for a command the tools never issue. One service
 * removes the possibility.
 *
 * Order of operations inside `consult()` — deliberate, do not reorder:
 *   role resolution → budget reserve → concurrency slot → model/effort
 *   resolution → run → one-hop model fallback → ledger settle → meta assembly.
 * Reserving before the slot (and therefore before any spawn) is what makes the
 * per-session attempt cap a real cap rather than a hint; the fallback retry
 * lives inside the same reservation and the same slot, because it is a retry
 * of one attempt, not a second consultation.
 *
 * Concurrency is bounded process-wide, not per service instance: settings
 * saves rebuild the service (and the tools), so an instance-local semaphore
 * would reset the host's in-flight count on every save. The module-level gate
 * survives re-registration and is re-configured from the newest settings.
 */
import { createHash } from 'node:crypto'
import { buildSystemPrompt } from './roles.js'
import { runClaudeConsult, EFFORT_LEVELS } from './claude.js'
import { isModelLevelError } from './settings.js'
import { buildConsultationPacket } from './packet.js'
import { attachEnvelope } from './envelope.js'

/** Global in-flight consultations when settings do not say otherwise. */
export const DEFAULT_MAX_CONCURRENT = 4
/** Wall-clock cap for a `/test` ping, however generous the real timeout is. */
const TEST_TIMEOUT_MS = 180000
/** Turn cap for a `/test` ping: enough for one tool-free answer. */
const TEST_MAX_TURNS = 2

/**
 * Failure kind for a request the service refuses before doing any work
 * (unknown/disabled role, empty question). NOT in the frozen FailureKind set —
 * see the report accompanying this change; mapping these onto `rejected-args`
 * or `spawn` would lie to the UI, so they get their own kind instead.
 */
export const INVALID_REQUEST = 'invalid-request'

/**
 * Failure kind for a runner that broke its own contract — threw, or returned
 * something that is not a result object. Also NOT in the frozen set, and
 * deliberately not `'spawn'`: `'spawn'` claims "could not start the process at
 * all", which we cannot know here. A thrown runner may have left a live child
 * behind, and telling the user their CLI failed to start would send them to
 * check `cliPath` for what is actually a bug on our side of the boundary.
 */
export const INTERNAL_ERROR = 'internal'

/** Failure kinds a different model could plausibly fix. */
const FALLBACK_ELIGIBLE = new Set(['cli-error', 'cli-run'])
/** Sources the service recognizes; anything else is treated as a tool call. */
const SOURCES = new Set(['tool', 'panel', 'test'])
function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Fingerprint: session + role + normalized question + context digest + phase. */
export function consultationFingerprint({ sessionId = '', role, question, context, phase }) {
  const digest = createHash('sha256').update(normalizeText(context)).digest('hex').slice(0, 16)
  return [sessionId, role, normalizeText(question), digest, phase ?? 'tool'].join('\n')
}

/** First non-empty trimmed string, else ''. */
function pick(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && Math.floor(n) === n && n > 0 ? n : fallback
}

/** Run `fn` at most once, however many times the caller releases. */
function once(fn) {
  let called = false
  return () => {
    if (called) return
    called = true
    fn()
  }
}

/**
 * A global + per-session in-flight gate for CLI processes.
 *
 * `maxPanelRoles` bounds one `consult_panel` call; nothing bounded the host,
 * so N concurrent tool calls spawned N × roles processes. This does. Waiters
 * queue in FIFO order and are admitted out of order only when the head is
 * blocked by its own session cap (which cannot deadlock: a session at its cap
 * has work in flight, and every release pumps the queue).
 *
 * @param {{ maxConcurrent?: number, maxPerSession?: number }} [limits]
 */
export function createConsultationGate(limits = {}) {
  let globalCap = positiveInt(limits.maxConcurrent, DEFAULT_MAX_CONCURRENT)
  let sessionCap = Math.min(globalCap, positiveInt(limits.maxPerSession, globalCap))
  let inFlight = 0
  const perSession = new Map()
  /** @type {Array<{ sessionId: string, admit: () => void }>} */
  const waiters = []

  const sessionCount = (id) => (id.length === 0 ? 0 : perSession.get(id) ?? 0)
  const admits = (id) => inFlight < globalCap && sessionCount(id) < sessionCap

  function take(id) {
    inFlight += 1
    if (id.length > 0) perSession.set(id, sessionCount(id) + 1)
  }

  function give(id) {
    inFlight = Math.max(0, inFlight - 1)
    if (id.length > 0) {
      const left = sessionCount(id) - 1
      if (left > 0) perSession.set(id, left)
      else perSession.delete(id)
    }
    pump()
  }

  function pump() {
    let index = 0
    while (index < waiters.length && inFlight < globalCap) {
      const waiter = waiters[index]
      if (!admits(waiter.sessionId)) {
        index += 1
        continue
      }
      waiters.splice(index, 1)
      waiter.admit()
    }
  }

  return {
    /** Re-apply caps from the newest settings snapshot; may release waiters. */
    configure(next = {}) {
      globalCap = positiveInt(next.maxConcurrent, globalCap)
      sessionCap = Math.min(globalCap, positiveInt(next.maxPerSession, sessionCap))
      pump()
    },

    /**
     * Claim one slot, waiting when the host is saturated.
     * @param {string} [sessionId] - '' when the caller has no session (web test).
     * @param {AbortSignal} [signal] - aborting while queued gives up the wait.
     * @returns {Promise<{ ok: true, release: () => void } | { ok: false }>}
     */
    acquire(sessionId = '', signal = undefined) {
      const id = typeof sessionId === 'string' ? sessionId : ''
      if (signal?.aborted === true) return Promise.resolve({ ok: false })
      return new Promise((resolve) => {
        let settled = false
        const onAbort = () => {
          if (settled) return
          settled = true
          const index = waiters.indexOf(entry)
          if (index >= 0) waiters.splice(index, 1)
          resolve({ ok: false })
        }
        const refuse = () => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve({ ok: false })
        }
        const entry = {
          sessionId: id,
          admit() {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', onAbort)
            take(id)
            resolve({ ok: true, release: once(() => give(id)) })
          },
          refuse,
        }
        waiters.push(entry)
        signal?.addEventListener('abort', onAbort, { once: true })
        pump()
      })
    },

    /**
     * Reject waiters for one session. Does not release in-flight slots —
     * those free themselves when their consult settles after abort.
     */
    dropSession(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId : ''
      if (id.length === 0) return
      let index = 0
      while (index < waiters.length) {
        if (waiters[index].sessionId !== id) {
          index += 1
          continue
        }
        const [waiter] = waiters.splice(index, 1)
        waiter.refuse()
      }
    },

    /** Observability for tests and future UI surfacing. */
    stats() {
      return { inFlight, waiting: waiters.length, maxConcurrent: globalCap, maxPerSession: sessionCap }
    },
  }
}

/** Process-wide gate: survives the settings-save re-registration cycle. */
const sharedGate = createConsultationGate()

/** In-flight/queued abort controllers, keyed by session, for dropSession. */
const sessionControllers = new Map()

/** Watch one consultation so `cancelConsultationSession` can abort it. */
function watchSession(sessionId) {
  if (sessionId.length === 0) return { signal: undefined, release() {} }
  const controller = new AbortController()
  let set = sessionControllers.get(sessionId)
  if (set === undefined) {
    set = new Set()
    sessionControllers.set(sessionId, set)
  }
  set.add(controller)
  return {
    signal: controller.signal,
    release: once(() => {
      set.delete(controller)
      if (set.size === 0) sessionControllers.delete(sessionId)
    }),
  }
}

/** Merge caller and session-dispose signals; either one cancels the run. */
function mergeSignals(a, b) {
  const signals = [a, b].filter((s) => s !== undefined && s !== null && typeof s.addEventListener === 'function')
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const merged = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      merged.abort()
      return merged.signal
    }
    signal.addEventListener('abort', () => merged.abort(), { once: true })
  }
  return merged.signal
}

/**
 * Abort queued and in-flight consultations for one session.
 * Called from `dropSession` (and therefore from `session/disposed`).
 */
export function cancelConsultationSession(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id.length === 0) return
  const set = sessionControllers.get(id)
  if (set !== undefined) {
    for (const controller of [...set]) {
      try { controller.abort() } catch { /* already aborted */ }
    }
  }
  sharedGate.dropSession(id)
}

/** Caps for the gate, derived from one settings snapshot. */
function limitsFrom(settings) {
  const maxConcurrent = positiveInt(settings?.maxConcurrent, DEFAULT_MAX_CONCURRENT)
  const panel = positiveInt(settings?.maxPanelRoles, DEFAULT_MAX_CONCURRENT)
  const perSession = positiveInt(settings?.maxConcurrentPerSession, Math.min(maxConcurrent, panel))
  return { maxConcurrent, maxPerSession: Math.min(maxConcurrent, perSession) }
}

/**
 * Classify a runner failure that predates the runner's own `failure` field.
 * Transitional only: once every result carries `failure`, this never fires.
 */
function classify(result) {
  if (typeof result.failure === 'string' && result.failure.length > 0) return result.failure
  if (result.meta?.timedOut === true) return 'timeout'
  if (result.meta?.aborted === true) return 'aborted'
  return 'cli-run'
}

/**
 * Build the consultation service for one effective-settings snapshot.
 *
 * @param {object} deps
 * @param {object} deps.settings - effective settings (settings.js shape).
 * @param {object|null} [deps.ledger] - per-session attempt ledger (ledger.js);
 *   null disables budgeting entirely.
 * @param {{ cwd: string }} [deps.env] - caller environment facts for grounding.
 * @param {Function} [deps.runner] - test seam; defaults to `runClaudeConsult`.
 * @param {object} [deps.gate] - test seam; defaults to the process-wide gate.
 */
export function createConsultationService({ settings, ledger = null, env = null, runner = runClaudeConsult, gate = null } = {}) {
  const roster = Array.isArray(settings?.roles) ? settings.roles : []
  const roleByName = new Map(roster.map((role) => [role.name, role]))
  const workspace = env !== null && typeof env === 'object' ? env : { cwd: process.cwd() }
  const slots = gate ?? sharedGate
  if (gate === null) slots.configure(limitsFrom(settings))
  const inflightByKey = new Map()

  const enabledNames = roster.filter((role) => role.enabled !== false).map((role) => role.name)

  const fail = (role, error, failure, meta) => ({ ok: false, role, error, failure, meta })

  /**
   * One consultation, end to end.
   * Identical in-flight calls join; a short cooldown reuses a successful
   * result. A changed context digest is a different key.
   */
  async function consult(req) {
    const source = SOURCES.has(req?.source) ? req.source : 'tool'
    const requested = typeof req?.role === 'string' ? req.role.trim() : ''
    const role = roleByName.get(requested)
    if (role === undefined || role.enabled === false) {
      const valid = enabledNames.length > 0 ? enabledNames.join(', ') : '(none enabled)'
      return fail(requested, `unknown or disabled role "${requested}" — valid roles: ${valid}`, INVALID_REQUEST, { source })
    }

    const question = typeof req?.question === 'string' ? req.question.trim() : ''
    if (question.length === 0) {
      return fail(role.name, 'question must not be empty', INVALID_REQUEST, { source })
    }

    const sessionId = typeof req?.sessionId === 'string' ? req.sessionId.trim() : ''
    const context = typeof req?.artifacts === 'string' && req.artifacts.trim().length > 0
      ? req.artifacts
      : (typeof req?.context === 'string' ? req.context : '')
    const key = consultationFingerprint({ sessionId, role: role.name, question, context, phase: source })
    const pending = inflightByKey.get(key)
    if (pending !== undefined) return pending

    const work = perform({ req, role, question, sessionId, source })
      .finally(() => { inflightByKey.delete(key) })
    inflightByKey.set(key, work)
    return work
  }

  async function perform({ req, role, question, sessionId, source }) {
    // Budget first: a spent session must never reach a spawn.
    const watch = watchSession(sessionId)
    const signal = mergeSignals(req?.signal, watch.signal)
    if (signal?.aborted === true) {
      watch.release()
      return fail(role.name, 'consultation aborted before it started', 'aborted', { source, aborted: true })
    }

    let reservation = null
    if (ledger !== null && sessionId.length > 0) {
      const claim = ledger.reserve(sessionId, role.name)
      if (claim?.ok !== true) {
        // A refused claim holds nothing, so there is nothing to settle here.
        watch.release()
        const used = claim?.used ?? '?'
        const cap = claim?.cap ?? '?'
        return fail(role.name, `attempt budget spent for role "${role.name}" this session (${used}/${cap}) — no consultation was started`, 'budget', { source })
      }
      reservation = claim
    }

    const slot = await slots.acquire(sessionId, signal)
    if (slot.ok !== true) {
      watch.release()
      reservation?.settle('aborted')
      return fail(role.name, 'consultation cancelled while waiting for a free consultation slot', 'concurrency', { source, aborted: true })
    }

    // Settle in a `finally`: an unsettled reservation holds its attempt for
    // the rest of the session (there is no reaper — one would race a slow but
    // live consultation), and `settle` is idempotent, so settling on every
    // exit including a thrown one is strictly safer than settling once on the
    // happy path. A settle is also the ONLY accurate success signal the
    // reviewer/designer gates get: `tool/result` cannot supply one, because a
    // failed consultation is deliberately returned as a normal tool result.
    let outcome = 'pending'
    try {
      return await run({ role, question, req, source, signal, mark: (o) => { outcome = o } })
    } finally {
      watch.release()
      if (reservation !== null) {
        reservation.settle(outcome === 'pending'
          ? (signal?.aborted === true ? 'aborted' : 'failed')
          : outcome)
      }
      slot.release()
    }
  }

  /** The part that holds a slot: model/effort resolution, run, fallback, settle. */
  async function run({ role, question, req, source, signal, mark }) {
    const primary = pick(req.model, role.model, settings.model)
    const fallbackModel = pick(role.fallbackModel, settings.fallbackModel)
    const requestedEffort = pick(req.effort, role.effort, settings.effort)
    const effort = EFFORT_LEVELS.has(requestedEffort) ? requestedEffort : ''

    const budgetUsd = Number(settings.maxBudgetUsd)
    const packet = buildConsultationPacket({
      question,
      context: req.context,
      objective: req.objective,
      constraints: req.constraints,
      currentAttempt: req.currentAttempt,
      artifacts: req.artifacts,
      verification: req.verification,
      unknowns: req.unknowns,
      maxBytes: req.maxPacketBytes,
    })
    const invoke = async (model) => {
      const options = {
        userMessage: packet.text,
        systemPrompt: buildSystemPrompt(role, workspace),
        maxTurns: source === 'test' ? TEST_MAX_TURNS : positiveInt(settings.maxTurns, 8),
        timeoutMs: source === 'test'
          ? Math.min(positiveInt(settings.timeoutMs, 300000), TEST_TIMEOUT_MS)
          : positiveInt(settings.timeoutMs, 300000),
        cwd: workspace.cwd,
        extraArgs: settings.extraArgs,
        config: settings,
        ...(model.length > 0 ? { model } : {}),
        ...(effort.length > 0 ? { effort } : {}),
        ...(Number.isFinite(budgetUsd) && budgetUsd > 0 ? { maxBudgetUsd: budgetUsd } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }
      try {
        const result = await runner(options)
        if (result === null || typeof result !== 'object') {
          return { ok: false, error: 'consultation runner returned no result', failure: INTERNAL_ERROR, meta: {} }
        }
        return { ...result, meta: result.meta ?? {} }
      } catch (error) {
        return {
          ok: false,
          error: `consultation runner threw: ${error instanceof Error ? error.message : String(error)}`,
          failure: INTERNAL_ERROR,
          meta: {},
        }
      }
    }

    let result = await invoke(primary)
    let effectiveModel = primary
    let usedFallback = false

    // One hop, inside the same attempt and the same slot: a model-level
    // failure re-runs on the role's fallback model (else the global one).
    const eligible = !result.ok
      && fallbackModel.length > 0
      && fallbackModel !== primary
      && signal?.aborted !== true
      && FALLBACK_ELIGIBLE.has(classify(result))
      && isModelLevelError(result.error)
    if (eligible) {
      const firstError = result.error
      result = await invoke(fallbackModel)
      effectiveModel = fallbackModel
      usedFallback = true
      result.meta = { ...result.meta, fallbackError: firstError, ...(primary.length > 0 ? { originalModel: primary } : {}) }
    }

    const failure = result.ok ? null : classify(result)
    mark(result.ok ? 'success' : (failure === 'aborted' ? 'aborted' : 'failed'))

    const meta = {
      ...result.meta,
      effectiveModel,
      effectiveEffort: effort,
      usedFallback,
      source,
    }
    if (!result.ok) return { ok: false, role: role.name, error: result.error, failure, meta }
    const attached = attachEnvelope({ ok: true, answer: result.answer, meta }, packet.overflow)
    return { ...attached, role: role.name }
  }

  return {
    /** Live roster view for consult_roles and the UI. */
    describe() {
      return {
        roles: roster.map((role) => ({
          name: role.name,
          description: role.description,
          enabled: role.enabled !== false,
          ...(pick(role.model).length > 0 ? { model: role.model } : {}),
          ...(pick(role.effort).length > 0 ? { effort: role.effort } : {}),
        })),
        defaults: {
          ...(pick(settings.model).length > 0 ? { model: settings.model } : {}),
          ...(pick(settings.effort).length > 0 ? { effort: settings.effort } : {}),
        },
      }
    },

    /** Enabled role names, in roster order — the tools' enum. */
    roleNames: enabledNames,

    consult,
  }
}
