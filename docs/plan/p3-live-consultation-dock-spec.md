# P3 live consultation dock — specification

> Date: 2026-08-19
> Status: implemented — P3.0 polling dock shipped; P3.1 SSE remains pending
> Plan: [`p3-live-consultation-dock.md`](./p3-live-consultation-dock.md)
> Parent decision record: [`model-consultation-patterns.md`](../research/model-consultation-patterns.md)

This is the frozen contract for a session-scoped status dock rendered above the
web composer. It shows the lifecycle of `consult_expert` / `consult_panel`
calls in the current session and a bounded preview of the final Claude Code
reply, updating in near real time.

## 1. Product contract

### In scope

- One dock rendered above the chat input (`conversation.input.dock`) for the
  active session. It appears when that session has consultation status
  entries and disappears when the last entry is dismissed or the session ends.
- One card per physical consultation (one spawned `claude` process; the
  model-level fallback hop stays inside the same card). A `consult_panel`
  produces one card per role.
- Phases visible in near real time: `queued → running → [fallback] →
  succeeded | failed | aborted`.
- On terminal state, a bounded preview of the final answer or the machine
  failure reason. No token-level streaming in P3.
- Explicit per-card dismiss and "clear completed" actions. State is UI-local
  only; no new persistent setting.
- Web chat seat only. The settings `/test` panel keeps its own result display;
  the connection test is excluded from the dock.

### Out of scope

- Token-level streaming of Claude's reply (`stream-json` is a separate P4
  candidate; P3 does not change the runner's `--output-format json` protocol).
- TUI / headless surfaces.
- Cross-session monitoring or an admin panel.
- Persistence across plugin reloads. The store is host-memory.
- Changing tool results, ledger settlement, budget, or concurrency semantics.

## 2. Host slot contract

The dock is registered into the host slot **`conversation.input.dock`**:

```js
ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
  name: 'conversation.input.dock',
  id: 'capability-optimizer',
  order: 30,
  locale: NS,
}, ConsultationDock))
```

Verified against the installed `@deepseek-ai/dsh-client-ui-conversation`
bundle: `conversation.input.dock` is a **list slot, session-scoped**, and is
rendered in the composer stack immediately **before** `conversation.composer.bar`
(i.e. above the input bar). The component receives the standard session props;
`AutoConsultControl` already consumes `sessionId` and locale-bound `t` the same
way.

Compatibility rule: the dock must render `null` when `sessionId` is absent.
If an older host does not provide the slot, the registration is simply never
mounted; nothing else in the plugin may depend on it.

## 3. Server status model

### 3.1 Frozen vocabulary

```ts
type DockPhase =
  | 'queued'     // attempt reserved; waiting for a global/session gate slot
  | 'running'    // slot acquired; CLI invocation in progress
  | 'fallback'   // first model failed model-level; fallback hop is running
  | 'succeeded'  // terminal: usable answer produced
  | 'failed'     // terminal: non-abort failure (all existing FailureKinds)
  | 'aborted'    // terminal: caller or session cancellation

type DockSource = 'tool' | 'panel'   // 'test' and blank session are never docked
```

Terminal set: `succeeded`, `failed`, `aborted`. `fallback` is a sub-phase of
running, not a second attempt.

Failure vocabulary is the existing frozen set plus the two service kinds:
`spawn | not-found | timeout | aborted | output-overflow | no-output |
cli-run | cli-error | rejected-args | budget | concurrency |
invalid-request | internal`.

### 3.2 `DockEntry`

Plain JSON-safe object, newest first in every snapshot:

```ts
interface DockEntry {
  id: string                      // non-empty, unique per store
  sessionId: string
  source: DockSource
  role: string
  question: string                // first 140 UTF-16 code units, no context/artifacts
  questionTruncated: boolean
  phase: DockPhase
  startedAt: number               // epoch ms, store clock
  updatedAt: number               // epoch ms, changes on every phase update
  endedAt: number | null          // epoch ms, set only by finish()
  durationMs: number | null       // store wall clock: endedAt - startedAt
  model: {
    requested: string             // '' = follow CLI default
    fallback: string              // '' = no fallback configured
    effective: string | null      // final actual model when known
    usedFallback: boolean
  }
  effort: string | null           // resolved --effort, '' treated as null
  failure: string | null          // FailureKind; null unless failed/aborted
  error: string | null            // human error, first 240 UTF-16 code units
  errorTruncated: boolean
  answer: string | null           // final answer, first 400 UTF-16 code units
  answerTruncated: boolean
  envelopeStatus: string | null   // meta.envelopeStatus when succeeded
  meta: {
    pid?: number
    outputBytes?: number          // stdout bytes captured so far
    exitCode?: number | null
    exitSignal?: string | null
    numTurns?: number
    cliDurationMs?: number
    costUsd?: number
    cliSessionId?: string
    rejectedArgs?: Array<{ arg: string, reason: string }>
  }
}
```

Content rules:

- `question` is a preview, not the packet. `context`, `brief`, artifacts and
  untrusted material never enter the store.
- `error` / `answer` are truncated server-side; the booleans tell the client
  whether to say "truncated".
- `meta.rejectedArgs` is copied from the result meta and never grown.
- A terminal entry ignores later `update()` calls; `finish()` is idempotent.

## 4. New module: `lib/consultation-status.js`

### 4.1 API

```js
export const DOCK_ENTRY_LIMIT = 8

export function createConsultationStatusStore({
  maxEntriesPerSession = DOCK_ENTRY_LIMIT,
  now = Date.now,
} = {})
```

Returned store:

```js
{
  begin(input): StatusHandle | null
  snapshot(sessionId): DockEntry[]
  stats(sessionId): { entries: number, active: number }
  subscribe(listener): () => void
  drop(sessionId): void
  dropAll(): void
}
```

`begin({ sessionId, source, role, question })` returns `null` (a no-op handle)
when `sessionId` is blank, `source === 'test'`, `role` is blank, or the input
shape is invalid. Otherwise it creates the entry in phase `queued` with
`model.requested: ''`, `effort: null`, `startedAt: now()` and returns:

```js
{
  id,
  update(patch): void,   // shallow-merge valid fields; no-op after terminal
  finish(phase, fields): void, // terminal phases only; sets endedAt/durationMs
}
```

### 4.2 Invariants

- `update` / `finish` must **never throw** for caller-supplied data; invalid
  fields are dropped. The status path is instrumentation and must not fail a
  consultation.
- `finish` only accepts `succeeded | failed | aborted`; anything else is
  treated as `failed`. Calling it twice is a no-op.
- `snapshot` returns detached plain objects (mutating one does not mutate the
  store) ordered newest first.
- Capacity: on `begin`, evict the oldest **terminal** entries until at most
  `maxEntriesPerSession - 1` remain; active entries are never evicted. On
  `finish`, evict the oldest terminal entries until at most
  `maxEntriesPerSession` remain.
- Active ceiling: `begin` returns `null` when the session already has
  `maxEntriesPerSession × DOCK_ACTIVE_CEILING_FACTOR` active cards. Queued
  entries are created before the gate admits them, so the gate's in-flight cap
  does NOT bound active-card memory by itself; the explicit ceiling does.
- `subscribe` receives structural events after the store has changed:

```ts
type StatusStoreEvent =
  | { type: 'entry',   sessionId: string, entry: DockEntry }
  | { type: 'dropped', sessionId: string, id: string }
  | { type: 'disposed', sessionId: string }
```

  Listeners are called synchronously; a throwing listener is caught and
  swallowed. No history is replayed.
- `drop(sessionId)` removes the session's entries and emits `disposed`.
  `dropAll()` removes everything and emits `disposed` per affected session.
- After `drop(sessionId)`, any outstanding handles from that session become
  no-ops: a late `finish` from a cancelled consultation must not resurrect a
  card. The existing disposal path cancels consultations and drops the ledger;
  the status store must tolerate the in-flight finish arriving after the drop.

## 5. Runner progress contract: `lib/claude.js`

`runClaudeConsult` gains one optional option; the return shape is unchanged:

```js
runClaudeConsult({ ..., onProgress })
```

`onProgress` is called synchronously with structural events only — never with
stdout/stderr **content**:

```ts
type RunnerProgressEvent =
  | { type: 'spawn',     pid: number }
  | { type: 'stdout',    bytes: number, totalBytes: number }
  | { type: 'stderr',    bytes: number, totalBytes: number }
  | { type: 'terminate', reason: 'timeout' | 'aborted' }
  | { type: 'exit',      code: number | null, signal: string | null }
```

Timing rules:

- `spawn` fires once after `child_process.spawn` returns when `child.pid` is
  defined, before stdin is ended.
- `stdout` / `stderr` fire once per readable `data` chunk, after the capture
  cap check. After stop or overflow no further output events fire.
- `terminate` fires once inside `terminate()` with the first reason.
- `exit` fires once from the child `close` handler before `finish()`.
- Exceptions thrown by `onProgress` are caught and swallowed; progress is
  advisory and cannot alter settle semantics.
- `onProgress === undefined` behaves exactly like today.

## 6. Consultation service integration: `lib/consultation.js`

`createConsultationService` gains one optional dependency:

```js
createConsultationService({ ..., status = null })
// status must expose: { begin(input): handle|null }
```

Event points, in execution order — instrumentation only, no semantic change:

1. **Begin after de-duplication and after the abort-at-entry check.**
   Identical in-flight calls share one physical run and therefore one card;
   a second joined caller creates no duplicate entry. A call already aborted
   at entry creates no card.
2. **`queued`** immediately at begin, carrying resolved `model.requested`,
   `model.fallback`, and `effort`.
3. **Reservation refused** (`ledger.reserve` returns `ok: false`) →
   `finish('failed', { failure: 'budget', error })`.
4. **Slot wait cancelled** → `finish('aborted', { failure, error })` with the
   same `concurrency` / `aborted` classification as the result.
5. **Slot acquired** → phase `running`.
6. **Fallback eligible and invoked** → phase `fallback` (the same entry, the
   same attempt, the same card).
7. **Terminal classification** from the same result / `mark` already used for
   ledger settlement:
   `ok` → `succeeded`; `failure === 'aborted'` → `aborted`; else `failed`.
   Include `failure`, `error`, `answer`, `envelopeStatus`, effective model,
   effort, `usedFallback`, and the bounded `meta` fields.
8. **`finally` safety net:** if the entry is not terminal when `perform`
   exits (including a thrown runner/workspace error), finish it as `aborted`
   when the merged signal aborted, otherwise `failed`. This mirrors the
   existing reservation settlement so no card can stay `running` forever.

Additional rules:

- Every status call is wrapped so a broken/absent store cannot change tool
  results, budget settlement, or slot release.
- `source === 'test'` and blank `sessionId` are ignored by the store; the
  service may still call `begin` and receive `null`.
- Runner progress is wired only inside the service (`spawn`, `stdout`,
  `stderr`, `exit`, `terminate`) to update `pid`, `outputBytes`, `exitCode`,
  `exitSignal` on the live entry. The final tool result shape is unchanged.

## 7. HTTP contract: `lib/routes.js`

`mountOptimizerRoutes(host, runtime)` accepts a new optional runtime field
`consultationStatus` (the store, or `null`).

### 7.1 Polling endpoint — P3.0

```
GET /dsh-capability-optimizer/consultation-status?session=<id>
```

- Method other than `GET` → `405 { allow: 'GET' }`.
- Missing/blank `session` → `400 { error: 'missing session' }`.
- If an `Origin` header is present and its host differs from `Host`, or it
  parses to `null`, → `403 { error: 'same-origin only' }`. An absent
  `Origin` is accepted, matching the existing GET `/autoconsult` route and
  real same-origin browser fetches, which do not always send `Origin` on GET.
  The response carries no CORS headers, so a cross-site reader cannot read it.
- Store absent → `503 { error: 'status store unavailable' }`.
- Success `200`, `content-type: application/json; charset=utf-8`,
  `cache-control: no-store`:

```json
{
  "session": "<trimmed session id>",
  "now": 1760000000000,
  "entries": [ "DockEntry newest-first" ]
}
```

The endpoint returns exactly one session. There is no list route.

### 7.2 SSE endpoint — P3.1 (optional, frozen now)

```
GET /dsh-capability-optimizer/consultation-events?session=<id>
```

- Same method / origin-when-present / session validation as 7.1.
- `200` with `content-type: text/event-stream; charset=utf-8`,
  `cache-control: no-store`, `connection: keep-alive`.
- First event is `retry: 1000`, then `event: snapshot` whose `data` is the
  same JSON object as 7.1.
- Subsequent events (the route drops any store event whose `sessionId` is not
  the requested session):
  - `event: entry` — `data: JSON.stringify(entry)`
  - `event: dropped` — `data: JSON.stringify({ session, id })`
  - `event: disposed` — `data: JSON.stringify({ session })` then end.
- A `: ping` comment every 15s; end on `response` close. The route disposer
  closes every open connection and the per-route listener it subscribed.
- Client must reconnect with backoff on stream loss. The store emits no
  history, so every reconnect starts with a fresh `snapshot`.

## 8. Client contract: `client/client.js`

### 8.1 Seat

Third seat registered as in §2. Component:

```js
ConsultationDock({ sessionId, t })
```

### 8.2 Data acquisition

- Poll `/dsh-capability-optimizer/consultation-status?session=...` with
  `cache: 'no-store'` through the existing `api()` helper.
- Cadence (single recursive timer, never overlapping):
  - any active entry (`queued | running | fallback`): **1000 ms**
  - only terminal entries visible, or no entries yet: **8000 ms**
- A hidden document pauses polling (1s recheck) and becomes visible → one
  immediate poll; the `visibilitychange` listener is torn down with the effect.
- Transient errors double the current delay (capped at **8s**); success resets
  it. Five consecutive failures of any kind stop polling for this mount.
- An HTTP `404` (host predates the route) stops polling for this mount,
  keyed on `error.status`, never on the message text.
- Responses after session change or unmount are ignored.
- Before first successful data, errors render `null` (the dock is an
  enhancement; a missing route on an older host must not paint an error bar).
  After data has been shown, errors keep the last snapshot and mark it stale.

### 8.3 Render rules

- `sessionId` blank → `null`.
- No entries and no retained last snapshot → `null`; the dock consumes no
  vertical space when idle.
- One card per entry:
  - header: `role` + phase pill + wall-clock duration + per-card dismiss;
  - question preview line (single-line ellipsis) so the shipped field has a
    consumer;
  - model line: requested/effective model, effort, fallback badge when
    `usedFallback`;
  - running: localized waiting text plus captured stdout byte count when
    present;
  - succeeded: `envelopeStatus` badge and `answer` preview; a toggle expands
    the full preview (still server-truncated); append "已截断/truncated" when
    `answerTruncated`;
  - failed/aborted: `failure` code + `error` preview, truncated marker;
  - terminal cards stay until dismissed. A footer button clears all terminal
    cards for the session.
- Container: max height 180px, vertical scroll, `aria-live="polite"`,
  phase pills have both color and text (never color alone).
- Dismiss state is component-local, pruned to ids still present in the newest
  snapshot on every successful poll, and reset on session change. No
  `localStorage`.
- Duration uses `dockNow(snapshot, clientNow)` — server time plus elapsed
  client time from one captured `receivedAt`, never an accumulating tick.
  Terminal cards use `durationMs`.

### 8.4 Localization and styles

- All user-visible strings come from `zh` / `en` dictionaries; the existing
  parity test keeps them in lockstep.
- New style prefix `.dco-cd-*`, appended to the existing single `<style>`
  element. Use the host design tokens (`--dsw-alias-*`,
  `--dsw-alias-state-*`) exactly as the auto-consult popover does.
- The bundle remains hand-authored CJS with no build step and `react` as the
  only external.

## 9. Wiring and lifecycle: `lib/index.js` / `lib/tools.js`

- Create one store per plugin apply:
  `createConsultationStatusStore()`.
- Pass it into `registerConsultTools(..., { ledger, status })`; the tools
  service passes it to `createConsultationService`.
- Pass it into `mountOptimizerRoutes(..., { ..., consultationStatus })`.
- Add one `ctx.on('session/disposed', ...)` listener that calls
  `statusStore.drop(session.id)`. This is in addition to the existing
  `autoRuntime.dropSession(sessionId)` cleanup; it never cancels consultations
  itself.
- Plugin dispose calls `statusStore.dropAll()`.
- Settings hot-apply rebuilds services; the store survives re-registration,
  so an in-flight consultation keeps updating its card across a settings save.

## 10. Safety, privacy, and degradation

- The store holds question previews, final answers, error text, and metadata
  for the user's own live session only; the HTTP route is origin-gated when
  the header is present and session-filtered, and emits no CORS headers. No
  `context` / `brief` / artifacts / stderr content.
- All strings are truncated server-side; the client renders with React text
  escaping only (never `dangerouslySetInnerHTML`).
- Status instrumentation must be fail-closed for the consultation itself:
  a store bug may lose a card, never a tool result.
- Store memory is bounded by §4.2 and emptied on `session/disposed`.
- If the host lacks the slot or the route (version skew), the dock does not
  mount or silently renders nothing; settings and tools are unaffected.

## 11. Test contract

New `test/consultation-status.test.mjs`:

- begin ignores blank session / `test` source / invalid role and returns `null`.
- begin → queued; update running/fallback; finish terminal is idempotent.
- update after finish is a no-op; `update` cannot jump to a terminal phase;
  invalid phase in finish becomes `failed`.
- snapshot newest-first, detached, and question/error/answer truncation booleans.
- cap evicts oldest terminal entries, never active ones; finish re-enforces cap.
- an all-active session refuses `begin` past
  `maxEntriesPerSession × DOCK_ACTIVE_CEILING_FACTOR`.
- subscribe sees `entry`, `dropped`, `disposed`; throwing listener is swallowed.
- drop clears one session only; dropAll clears all.
- a handle's late finish after `drop(sessionId)` is a no-op and does not
  resurrect the entry.

Extend `test/consultation.test.mjs` (fake `status` implementing `begin`):

- success path records `queued → running → succeeded` with final fields.
- model-level failure records `queued → running → fallback → failed`.
- budget refusal records a terminal `failed/budget` entry and never reaches
  runner.
- queued wait abort records `aborted/concurrency`.
- a thrown runner still finishes the card `failed` and releases the gate.
- two overlapping identical calls create exactly one entry.
- no status dependency → all existing behavior unchanged.

Extend `test/claude.test.mjs`:

- onProgress emits `spawn`, `stdout`, `exit` for a normal run.
- timeout and abort emit `terminate` with the correct reason.
- listener exceptions do not change the result; no event contains content.

Extend `test/consultation.test.mjs` route section:

- `GET /consultation-status` requires GET, rejects a mismatched `Origin`
  when one is present, and requires a non-blank session.
- returns the wired store's snapshot for only that session.
- returns 503 when no store is wired.

Update `test/client-bundle.test.mjs`:

- registered seat names become
  `['conversation.input.dock', 'conversation.input.left', 'settings.section']`.
- export and validate `isConsultationStatus` for JSON shape and HTML-shell
  rejection.
- export and test `dockPollDelay` (1000 active / 8000 settled-or-empty) and
  `dockNow` (server time + client elapsed, no tick accumulation).
- `api()` attaches `error.status`; the dock stops on `error.status === 404`
  and after five consecutive failures.
- zh/en dictionary parity continues to pass with the new keys.
- dock CSS is present in the injected style text.

New `test/index-wiring.test.mjs`:

- applying the plugin with an injected status-store seam registers a
  `session/disposed` listener that calls `store.drop(session.id)`.
- the returned disposer calls `store.dropAll()`.

## 12. Self-check record (performed before writing the plan)

| Check | Result | Evidence |
|---|---|---|
| Host has a first-class slot above the input bar | pass | `dsh-client-ui-conversation` bundle renders `conversation.input.dock` before `conversation.composer.bar` inside `composerStack` |
| Slot is session-scoped and provides `sessionId` | pass | slot declaration `scope: 'session'`; existing `AutoConsultControl` consumes the same prop |
| SSE / held-open responses are allowed by the host | pass | `dsh-host-webserver` route contract says a handler "may hold the response open, e.g. SSE"; upgrade routes also exist |
| Success cannot be derived from `tool/result` | pass | `lib/autoconsult.js` documents failed consults return normal results; status must be settled in the execution path like the ledger |
| Hook points exist without changing execution order | pass | `perform` reserve/acquire/finally and `run` fallback/mark map one-to-one to §6 |
| Runner can expose progress without protocol change | pass | `claude.js` owns stdout capture, terminate, and close; adding `onProgress` does not alter argv or parsing |
| Token streaming is a different feature | pass | production runner pins `--output-format json`; `argfilter.js` refuses `--output-format`; `stream-json` exists only in live measurement tests |
| Existing tests establish a green baseline | pass | `npm test`: 213 pass, 0 fail, 3 skipped (`DCO_LIVE_CLI=1` opt-in) |
| Client is a zero-build CJS bundle with dictionary parity test | pass | `test/client-bundle.test.mjs` loads the real bundle body and compares zh/en keys |
| Existing session cleanup point exists | pass | `wireAutoConsult` already listens for `session/disposed`; status store reuses the same event |
| Content is untrusted and bounded | pass | packet labels all material `UNTRUSTED EVIDENCE`; §10 caps and escapes every preview |

Open items intentionally deferred:

- SSE is specified in §7.2 but may ship after the polling MVP; the frozen
  event names prevent a later fork.
- Whether the dock auto-collapses after N minutes of terminal-only state is a
  UI polish decision; P3 keeps terminal cards until dismissed, so the user can
  read the final reply.
