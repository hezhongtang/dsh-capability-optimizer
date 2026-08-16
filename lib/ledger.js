/**
 * Per-session, per-role consultation ledger.
 *
 * The single source of truth shared by the execution path (the consultation
 * service reserves a slot before spawning) and the proactive-consultation
 * policy (autoconsult.js reads it to decide what to still promise the model
 * and whether a quality gate was actually satisfied).
 *
 * Two axes, deliberately separated:
 *  - **attempts** bound cost. Every started consultation claims one, whatever
 *    it later turns into. A cap that only silences nudges is not a cap, so the
 *    reservation happens before the process is spawned, not after.
 *  - **successes** satisfy quality gates. A consultation that failed, timed out
 *    or was cancelled is not a review; only a usable answer closes the
 *    reviewer/designer anchor.
 *
 * Reservation is atomic by construction: `reserve` reads and writes the counter
 * with no await in between, so on Node's single-threaded loop two callers in
 * flight against a cap of 1 cannot both pass — the second sees the first's
 * claim. `settle` is idempotent so a caller may settle from both a happy path
 * and a `finally` without double-billing.
 *
 * Refund policy: `aborted` gives the slot back (the user cancelled — they
 * should not be billed for it); `failed` does not (a failing CLI still burned
 * quota and wall clock, and refunding it would let a broken configuration
 * retry forever).
 */

/** Cap used when `getCap()` yields nothing usable — mirrors defaultAutoConsult(). */
const FALLBACK_CAP = 3

/** Fresh per-role tally. */
function newRoleUsage() {
  return { attempts: 0, succeeded: 0, failed: 0, aborted: 0 }
}

/** A reservation that never bills: used when there is no session to bill to. */
const FREE_RESERVATION = { ok: true, settle() { /* nothing to bill */ } }

/**
 * @param {object} options
 * @param {() => number} options.getCap - live per-role attempt cap (read on
 *        every reserve, so a config edit hot-applies to running sessions).
 */
export function createLedger({ getCap } = {}) {
  /** @type {Map<string, Map<string, {attempts: number, succeeded: number, failed: number, aborted: number}>>} */
  const sessions = new Map()

  /** Effective cap: a throwing/garbage provider degrades to the documented default, never to "unlimited". */
  function cap() {
    let raw
    try {
      raw = typeof getCap === 'function' ? getCap() : undefined
    } catch {
      return FALLBACK_CAP
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return FALLBACK_CAP
    return Math.floor(n)
  }

  /** Usable session key, or null when the caller has nothing to bill to. */
  function key(sessionId) {
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  }

  /** Existing tally for one role, or null (read paths never allocate). */
  function peek(sessionId, role) {
    const id = key(sessionId)
    if (id === null || typeof role !== 'string') return null
    return sessions.get(id)?.get(role) ?? null
  }

  return {
    /**
     * Atomically claim one attempt for `role` in `sessionId`. Call this BEFORE
     * spawning anything; settle the returned handle exactly once the outcome
     * is known (settling more than once is safe and does nothing).
     *
     * A missing/blank sessionId is not an error — it yields a free reservation
     * so callers that legitimately have no session (a connection test) run
     * unbudgeted instead of being refused.
     *
     * @param {string} sessionId
     * @param {string} role
     * @returns {{ok: true, settle: (outcome: 'success'|'failed'|'aborted') => void}
     *          | {ok: false, used: number, cap: number}}
     */
    reserve(sessionId, role) {
      const id = key(sessionId)
      if (id === null || typeof role !== 'string' || role.length === 0) return FREE_RESERVATION

      const limit = cap()
      let roles = sessions.get(id)
      if (roles === undefined) {
        roles = new Map()
        sessions.set(id, roles)
      }
      let usage = roles.get(role)
      if (usage === undefined) {
        usage = newRoleUsage()
        roles.set(role, usage)
      }
      // Read-and-claim with no await in between: this is what makes the cap
      // real for two panel roles racing against a cap of one.
      if (usage.attempts >= limit) return { ok: false, used: usage.attempts, cap: limit }
      usage.attempts += 1

      let settled = false
      return {
        ok: true,
        settle(outcome) {
          if (settled) return
          settled = true
          if (outcome === 'success') usage.succeeded += 1
          else if (outcome === 'aborted') {
            usage.aborted += 1
            // Refund: the user cancelled, so the slot goes back on the shelf.
            if (usage.attempts > 0) usage.attempts -= 1
          } else usage.failed += 1
        },
      }
    },

    /** Whether `role` produced at least one usable answer in this session. */
    hasSucceeded(sessionId, role) {
      return (peek(sessionId, role)?.succeeded ?? 0) > 0
    },

    /**
     * How many usable answers `role` produced this session. Additive to the
     * frozen contract: autoconsult needs a monotonic counter to tell "reviewed
     * during THIS turn" from "reviewed at some point this session".
     */
    successes(sessionId, role) {
      return peek(sessionId, role)?.succeeded ?? 0
    },

    /** Attempts still claimable for `role` (0 when the budget is spent). */
    attemptsLeft(sessionId, role) {
      return Math.max(0, cap() - (peek(sessionId, role)?.attempts ?? 0))
    },

    /**
     * Detached per-role tallies for one session.
     * @returns {Record<string, {attempts: number, succeeded: number, failed: number, aborted: number}>}
     */
    usage(sessionId) {
      const out = {}
      const id = key(sessionId)
      if (id === null) return out
      for (const [role, usage] of sessions.get(id) ?? []) out[role] = { ...usage }
      return out
    },

    /** Forget one session entirely (session disposal). */
    drop(sessionId) {
      const id = key(sessionId)
      if (id !== null) sessions.delete(id)
    },

    /** The cap currently in force, for UI/policy text. */
    cap,
  }
}
