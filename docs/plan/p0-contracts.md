# P0 contracts — pinned interfaces

> Source: `docs/research/model-consultation-patterns.md` §5.1–5.4.
>
> These signatures are **frozen** for the duration of the P0 work. Three agents
> implement behind them in parallel with disjoint file ownership. If you believe
> a signature is wrong, say so in your report — do not change it unilaterally,
> because someone else is already coding against it.

## File ownership

| Owner | Files (exclusive write access) |
|---|---|
| **Agent A — runner & arg safety** | `lib/claude.js`, `lib/argfilter.js` (new), the `extraArgs` block of `lib/settings.js`, `test/argfilter.test.mjs`, `test/claude.test.mjs` |
| **Agent B — ledger & lifecycle** | `lib/ledger.js` (new), `lib/autoconsult.js`, `test/ledger.test.mjs`, `test/autoconsult.test.mjs` |
| **Agent C — consultation service** | `lib/consultation.js` (new), `lib/tools.js`, `lib/routes.js`, `test/consultation.test.mjs` |
| **Integrator (main session)** | `lib/index.js`, `package.json`, `test/helpers/**`, `README*.md` |

Nobody else edits `lib/index.js`. If you need a wiring change there, state it in
your report as a requirement; the integrator applies it.

## Shared vocabulary

### `FailureKind`

Every failed consultation carries a machine-readable kind. Frozen set:

```
'spawn'            // could not start the process at all
'not-found'        // CLI binary missing (ENOENT)
'timeout'          // wall-clock timeoutMs elapsed, we killed it
'aborted'          // caller's AbortSignal fired
'output-overflow'  // stdout exceeded MAX_CAPTURE_BYTES
'no-output'        // exit 0 with empty stdout
'cli-run'          // non-zero exit / signal death
'cli-error'        // valid JSON, is_error true (includes model-level errors)
'rejected-args'    // configured extraArgs were refused; nothing was spawned
'budget'           // per-session/per-role attempt cap already spent
'concurrency'      // in-flight cap reached and the wait was aborted
```

### `Meta`

Additive only — existing keys keep their meaning.

```js
{
  // from the CLI's JSON document (unchanged)
  subtype, sessionId, numTurns, durationMs, costUsd,
  // runner-added
  timedOut?: boolean, aborted?: boolean, rawOutput?: boolean,
  rejectedArgs?: Array<{ arg: string, reason: string }>,
  // service-added
  effectiveModel?: string, effectiveEffort?: string,
  usedFallback?: boolean, originalModel?: string, fallbackError?: string,
  source?: 'tool' | 'panel' | 'test',
}
```

## Agent A — `lib/argfilter.js` (new)

```js
/**
 * @returns {{ args: string[], rejected: Array<{ arg: string, reason: string }> }}
 */
export function filterExtraArgs(extraArgs)

/** Human-readable policy for UI/README/error surfaces. */
export const ARG_POLICY: { allowed: string[], reasons: Record<string, string> }
```

Allowlist, not denylist. Refuse anything that (a) widens permissions, (b) breaks
the JSON protocol, or (c) duplicates a field the plugin already owns. At minimum
refuse: `--dangerously-skip-permissions`, `--permission-mode`, `--allowedTools`,
`--disallowedTools`, MCP config flags, `--system-prompt`, `--append-system-prompt`,
`--output-format`, `--json-schema`, `--model`, `--effort`, `--max-turns`,
`--max-budget-usd`, `-p`/`--print`, `--resume`/`--continue`. Handle `--flag=value`,
`--flag value`, and bare `-x` short forms; a value token following a rejected flag
must be dropped with it.

## Agent A — `lib/claude.js`

```js
export function runClaudeConsult({
  userMessage, systemPrompt, model, effort, maxTurns,
  maxBudgetUsd,          // NEW, optional -> --max-budget-usd
  timeoutMs, cwd, extraArgs, config,
  signal,                // NEW, optional AbortSignal
})
=> Promise<
     { ok: true,  answer: string, meta: Meta }
   | { ok: false, error: string, failure: FailureKind, meta: Meta }
   >
```

Requirements:

- Settle **exactly once**, and only after the child's `close` event — never
  resolve while the process is still alive.
- `signal` already aborted at entry → resolve `aborted` without spawning.
- On abort: stop reading, SIGTERM, escalate to SIGKILL after `KILL_GRACE_MS`,
  resolve `aborted` after `close`. Remove the signal listener on settle.
- Distinguish `timeout` from `aborted`; never collapse either into `cli-run`.
- Safe defaults, **feature-detected once** against `claude --help` (cache the
  probe; silently skip a flag the installed CLI does not advertise):
  read-only tool restriction and `--no-session-persistence`.
- `filterExtraArgs` gates every configured arg. Rejections go into
  `meta.rejectedArgs`. Rejecting an arg does not fail the run — it drops the arg
  and records it — **except** that nothing may ever reach argv unfiltered.

## Agent B — `lib/ledger.js` (new)

Per-session, per-role attempt/success ledger. Single source of truth shared by
the tool path and the auto-consult policy.

```js
export function createLedger({ getCap })   // getCap(): number

// returns:
{
  /** Atomically claim one attempt. Reserve BEFORE spawning. */
  reserve(sessionId, role):
      { ok: true, settle(outcome: 'success'|'failed'|'aborted'): void }
    | { ok: false, used: number, cap: number },

  /** Has this role produced at least one usable answer this session? */
  hasSucceeded(sessionId, role): boolean,

  attemptsLeft(sessionId, role): number,

  /** { [role]: { attempts, succeeded, failed, aborted } } */
  usage(sessionId): object,

  drop(sessionId): void,
}
```

`settle` is idempotent. An `aborted` outcome refunds the attempt (the user
cancelled; they should not be billed a slot); `failed` does not refund.

## Agent B — `lib/autoconsult.js`

- `createAutoConsultRuntime({ getDefaults, getRoster })` — `getRoster()` returns
  the live `settings.roles` array so the policy can drop roles that are disabled
  or absent. Expose the ledger as `runtime.ledger` for the integrator to hand to
  the tools.
- Counting moves off `tool/call`. Attempts are owned by the ledger (reserved on
  the tool path); autoconsult observes `tool/result` (or the equivalent DSH
  result event — **verify the real event name against the installed
  `@deepseek-ai/dsh-tools` / DSH source before relying on it**, and report what
  you found) to mark success. Only a *success* satisfies a reviewer/designer
  anchor; a failed or aborted consultation must leave the gate open.
- `policyText()` lists only roles that are enabled in the live roster **and**
  have attempts left.
- `setOverride()` filters unknown / disabled / other-backend keys and reports
  what it dropped, so `snapshot()` can surface the reason to the UI.
- `wireAutoConsult` additionally listens for `session/disposed` and calls
  `dropSession()`. Verify the event name against DSH before relying on it.

## Agent C — `lib/consultation.js` (new)

The one place that knows how a consultation is assembled. `consult_expert`,
`consult_panel` and the `/test` route all become thin adapters over it.

```js
export function createConsultationService({ settings, ledger, env })

// returns:
{
  /** Live roster view for consult_roles / UI. */
  describe(): { roles: [...], defaults: {...} },

  /**
   * @param {object} req
   * @param {string} req.role
   * @param {string} req.question
   * @param {string} [req.context]
   * @param {string} [req.model]     call-level override
   * @param {string} [req.effort]    call-level override
   * @param {string} [req.sessionId] for the ledger; omit to skip budgeting
   * @param {'tool'|'panel'|'test'} [req.source]
   * @param {AbortSignal} [req.signal]
   */
  consult(req): Promise<
      { ok: true,  role: string, answer: string, meta: Meta }
    | { ok: false, role: string, error: string, failure: FailureKind, meta: Meta }
  >,
}
```

Owns, in this order: role resolution → budget reserve → concurrency slot →
model/effort resolution (call → role → global) → run → one-hop model fallback →
ledger settle → meta assembly.

- **Concurrency**: a global in-flight semaphore (`settings.maxConcurrent`,
  default 4) plus a per-session cap. Queue waits must reject on `req.signal`
  with `failure: 'concurrency'`. `maxPanelRoles` only bounds one call; the
  semaphore is what bounds the host.
- **Fallback** is an internal retry of the *same* attempt — it does not consume
  a second ledger slot. Say so in `meta.usedFallback`.
- `meta.effectiveModel` / `meta.effectiveEffort` always reflect what actually
  ran, so `/test` can prove it exercised the production path.

## Agent C — `lib/tools.js`

- All three tools take `execute(args, exec)` and forward `exec?.signal` into the
  service. **Verify the real second-parameter shape against the installed
  `@deepseek-ai/dsh-tools` before coding to it** and report what you found.
- The tool session id comes from `exec`; if it is not reachable, report that —
  do not invent one, and degrade to "no budgeting" rather than mis-billing.
- `consult_panel` maps over the service; partial success is preserved as today.

## Agent C — `lib/routes.js`

`/dsh-capability-optimizer/test` calls `service.consult({ source: 'test' })`
instead of `runClaudeConsult` directly, and returns `effectiveModel`,
`effectiveEffort`, `usedFallback`, `failure` and `rejectedArgs` so the UI proves
the production path.

## Test harness (already in place — use it, don't rebuild it)

- Runner: `node --test`, via `npm test`. Tests live in `test/*.test.mjs`.
- `test/helpers/fake-claude.mjs` is an executable stub CLI. Point the runner at
  it with `config: { cliPath: fakeClaudePath }` and drive it with env vars —
  see the header of that file for the full knob list. It records the argv and
  stdin it received to `FAKE_CLAUDE_RECORD`, which is how you assert on
  generated arguments.
- `test/helpers/harness.mjs` exports `fakeClaudePath`, `withRecord()` and
  `readRecord()`.
