/**
 * In-memory consultation status store for the live web dock.
 *
 * This module is pure instrumentation. It knows how to hold, truncate and
 * evict status entries; it never calls into the consultation service and can
 * never change a tool result, a ledger settlement or a concurrency slot. The
 * one lifecycle race it owns is session disposal: a cancelled consultation
 * may finish after the session was dropped, and that late finish must not
 * resurrect a card.
 *
 * Entries are newest-first. Capacity is per session; only terminal entries
 * are evicted, so active cards survive a burst of completed history. Active
 * cards are not bounded by the gate — an entry begins BEFORE the gate slot is
 * acquired, and gate waiters can queue — so `begin` also refuses new cards
 * past a hard active ceiling.
 */

export const DOCK_ENTRY_LIMIT = 8
/** Hard ceiling on simultaneously active cards: `limit × factor`. */
export const DOCK_ACTIVE_CEILING_FACTOR = 3

const QUESTION_LIMIT = 140
const ERROR_LIMIT = 240
const ANSWER_LIMIT = 400

const PHASES = new Set(['queued', 'running', 'fallback', 'succeeded', 'failed', 'aborted'])
const TERMINAL_PHASES = new Set(['succeeded', 'failed', 'aborted'])
const DOCK_SOURCES = new Set(['tool', 'panel'])

/** @type {symbol} marks live bookkeeping that never reaches a snapshot. */
const INTERNAL = Symbol('status.internal')

/** @returns {{ text: string, truncated: boolean }} */
function preview(value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true }
}

function positiveLimit(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 && Math.floor(n) === n ? Math.floor(n) : DOCK_ENTRY_LIMIT
}

/** Plain JSON-safe copy of one live entry. */
function snapshotEntry(entry) {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    source: entry.source,
    role: entry.role,
    question: entry.question,
    questionTruncated: entry.questionTruncated,
    phase: entry.phase,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    model: { ...entry.model },
    effort: entry.effort,
    failure: entry.failure,
    error: entry.error,
    errorTruncated: entry.errorTruncated,
    answer: entry.answer,
    answerTruncated: entry.answerTruncated,
    envelopeStatus: entry.envelopeStatus,
    meta: {
      ...entry.meta,
      ...(Array.isArray(entry.meta.rejectedArgs)
        ? { rejectedArgs: entry.meta.rejectedArgs.map((item) => ({ ...item })) }
        : {}),
    },
  }
}

/** Coerce one model patch into the entry's model shape. */
function mergeModel(current, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return current
  const next = { ...current }
  for (const key of ['requested', 'fallback']) {
    if (typeof patch[key] === 'string') next[key] = patch[key]
  }
  if (patch.effective === null || typeof patch.effective === 'string') next.effective = patch.effective
  if (typeof patch.usedFallback === 'boolean') next.usedFallback = patch.usedFallback
  return next
}

/** Coerce one meta patch into the entry's meta shape. */
function mergeMeta(current, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return current
  const next = { ...current }
  for (const key of ['pid', 'outputBytes', 'numTurns', 'cliDurationMs', 'costUsd']) {
    const value = patch[key]
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = value
  }
  for (const key of ['exitCode']) {
    const value = patch[key]
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) next[key] = value
  }
  for (const key of ['exitSignal', 'cliSessionId']) {
    if (typeof patch[key] === 'string') next[key] = patch[key]
  }
  if (Array.isArray(patch.rejectedArgs)) {
    next.rejectedArgs = patch.rejectedArgs
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => ({ arg: String(item.arg ?? ''), reason: String(item.reason ?? '') }))
  }
  return next
}

/**
 * @param {object} options
 * @param {number} [options.maxEntriesPerSession] - terminal-entry cap per session.
 * @param {() => number} [options.now] - clock seam for tests; defaults to Date.now.
 */
export function createConsultationStatusStore({ maxEntriesPerSession = DOCK_ENTRY_LIMIT, now = Date.now } = {}) {
  const limit = positiveLimit(maxEntriesPerSession)
  /** @type {Map<string, { generation: number, entries: Array<object> }>} */
  const sessions = new Map()
  const listeners = new Set()
  let nextId = 0
  let generation = 0

  const emit = (event) => {
    for (const listener of [...listeners]) {
      try { listener(event) } catch { /* instrumentation must survive bad listeners */ }
    }
  }

  const record = (sessionId) => {
    let session = sessions.get(sessionId)
    if (session === undefined) {
      generation += 1
      session = { generation, entries: [] }
      sessions.set(sessionId, session)
    }
    return session
  }

  const evictTerminal = (session, target = limit) => {
    while (session.entries.length > target) {
      let index = -1
      for (let i = session.entries.length - 1; i >= 0; i -= 1) {
        if (TERMINAL_PHASES.has(session.entries[i].phase)) { index = i; break }
      }
      if (index === -1) return
      const [entry] = session.entries.splice(index, 1)
      emit({ type: 'dropped', sessionId: entry.sessionId, id: entry.id })
    }
  }

  const apply = (entry, patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return
    if (typeof patch.phase === 'string' && PHASES.has(patch.phase)
      && !TERMINAL_PHASES.has(patch.phase) && !TERMINAL_PHASES.has(entry.phase)) {
      entry.phase = patch.phase
    }
    entry.model = mergeModel(entry.model, patch.model)
    if (patch.effort === null || typeof patch.effort === 'string') entry.effort = patch.effort
    if (patch.failure === null || typeof patch.failure === 'string') entry.failure = patch.failure
    if (patch.envelopeStatus === null || typeof patch.envelopeStatus === 'string') entry.envelopeStatus = patch.envelopeStatus
    if (patch.error !== undefined) {
      const value = preview(patch.error, ERROR_LIMIT)
      entry.error = value.text.length > 0 ? value.text : null
      entry.errorTruncated = value.truncated
    }
    if (patch.answer !== undefined) {
      const value = preview(patch.answer, ANSWER_LIMIT)
      entry.answer = value.text.length > 0 ? value.text : null
      entry.answerTruncated = value.truncated
    }
    entry.meta = mergeMeta(entry.meta, patch.meta)
  }

  const makeHandle = (entry) => {
    const { sessionId, id } = entry
    const internal = entry[INTERNAL]
    const alive = () => {
      const session = sessions.get(sessionId)
      return session !== undefined
        && session.generation === internal.generation
        && session.entries.includes(entry)
        && entry[INTERNAL] === internal
    }

    /** Update a live entry; terminal entries and dropped sessions ignore it. */
    const update = (patch) => {
      try {
        if (!alive() || TERMINAL_PHASES.has(entry.phase)) return
        apply(entry, patch)
        entry.updatedAt = now()
        emit({ type: 'entry', sessionId, entry: snapshotEntry(entry) })
      } catch { /* status must never throw into the consultation path */ }
    }

    /** Finish a live entry exactly once; terminal phases only. */
    const finish = (phase, fields = undefined) => {
      try {
        if (!alive() || TERMINAL_PHASES.has(entry.phase)) return
        const finalPhase = TERMINAL_PHASES.has(phase) ? phase : 'failed'
        apply(entry, fields)
        entry.phase = finalPhase
        entry.endedAt = now()
        entry.durationMs = Math.max(0, entry.endedAt - entry.startedAt)
        entry.updatedAt = entry.endedAt
        emit({ type: 'entry', sessionId, entry: snapshotEntry(entry) })
        const session = sessions.get(sessionId)
        if (session !== undefined && session.generation === internal.generation) evictTerminal(session)
      } catch { /* status must never throw into the consultation path */ }
    }

    return { id, update, finish }
  }

  return {
    /**
     * Begin one consultation card. Returns a no-op null for blank sessions,
     * the connection test, or a caller that has no business in the dock.
     */
    begin(input) {
      try {
        const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : ''
        const source = input?.source
        const role = typeof input?.role === 'string' ? input.role.trim() : ''
        if (sessionId.length === 0 || !DOCK_SOURCES.has(source) || role.length === 0) return null

        const session = record(sessionId)
        const active = session.entries.filter((entry) => !TERMINAL_PHASES.has(entry.phase)).length
        if (active >= limit * DOCK_ACTIVE_CEILING_FACTOR) return null
        evictTerminal(session, limit - 1)

        nextId += 1
        const entry = {
          [INTERNAL]: { generation: session.generation },
          id: `${sessionId}\u0000${source}\u0000${role}\u0000${nextId}`,
          sessionId,
          source,
          role,
          question: '',
          questionTruncated: false,
          phase: 'queued',
          startedAt: now(),
          updatedAt: now(),
          endedAt: null,
          durationMs: null,
          model: { requested: '', fallback: '', effective: null, usedFallback: false },
          effort: null,
          failure: null,
          error: null,
          errorTruncated: false,
          answer: null,
          answerTruncated: false,
          envelopeStatus: null,
          meta: {},
        }
        const question = preview(input.question, QUESTION_LIMIT)
        entry.question = question.text
        entry.questionTruncated = question.truncated

        session.entries.unshift(entry)
        emit({ type: 'entry', sessionId, entry: snapshotEntry(entry) })
        return makeHandle(entry)
      } catch {
        return null
      }
    },

    /** Detached newest-first snapshot for one session. */
    snapshot(sessionId) {
      try {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return []
        return (sessions.get(sessionId)?.entries ?? []).map(snapshotEntry)
      } catch {
        return []
      }
    },

    stats(sessionId) {
      const entries = sessions.get(sessionId)?.entries ?? []
      return {
        entries: entries.length,
        active: entries.filter((entry) => !TERMINAL_PHASES.has(entry.phase)).length,
      }
    },

    /** Subscribe to structural events (no history). Returns an unsubscriber. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /** Forget one session and tell every subscriber. */
    drop(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id.length === 0 || !sessions.has(id)) return
      sessions.delete(id)
      emit({ type: 'disposed', sessionId: id })
    },

    /** Forget every session (plugin dispose). */
    dropAll() {
      const keys = [...sessions.keys()]
      sessions.clear()
      for (const sessionId of keys) emit({ type: 'disposed', sessionId })
    },
  }
}
