# P3 live consultation dock — implementation plan

> Date: 2026-08-19
> Status: P3.0 implemented (polling dock); P3.1 SSE upgrade still pending
> Spec: [`p3-live-consultation-dock-spec.md`](./p3-live-consultation-dock-spec.md)
>
> Implementation record: workstreams A–F are complete and the post-advisor
> client fixes are applied; `npm test` is 245 pass / 0 fail / 3 live-CLI
> skipped. Default `maxTurns` is now 16 (was 8).

This plan implements the session-scoped status dock specified in the sibling
spec. P3.0 ships the polling MVP; P3.1 is the optional SSE upgrade whose
contract is already frozen in spec §7.2.

## 1. Deliverables

| Workstream | Files |
|---|---|
| A — status store | `lib/consultation-status.js` (new), `test/consultation-status.test.mjs` (new) |
| B — runner progress | `lib/claude.js`, `test/claude.test.mjs` |
| C — service instrumentation | `lib/consultation.js`, `test/consultation.test.mjs` |
| D — tools + routes + lifecycle | `lib/tools.js`, `lib/routes.js`, `lib/index.js`, `test/consultation.test.mjs` |
| E — client dock | `client/client.js`, `test/client-bundle.test.mjs` |
| F — docs | `README.md`, `README.zh-cn.md`, this plan, the spec |

## 2. Non-goals

- No `stream-json` / token-level reply streaming.
- No new settings key or persistence.
- No cross-session status API.
- No change to tool result schemas, ledger, budget, gate, or CLI argv.

## 3. Workstreams

### A — `lib/consultation-status.js` (do first)

Pure in-memory store, no plugin dependencies.

Tasks:

1. Implement `createConsultationStatusStore` exactly as spec §4.
2. Truncate at ingest: question 140, error 240, answer 400 UTF-16 code units;
   set the matching `*Truncated` booleans.
3. Keep entries newest-first; terminal-only eviction at `begin` and `finish`.
4. Emit `entry` on every successful update/finish, `dropped` on eviction,
   `disposed` on drop/dropAll; swallow listener exceptions.
5. `dropAll()` snapshots session keys before deleting, then emits one
   `disposed` per key.
6. After `drop(sessionId)`, outstanding handles for that session become
   no-ops (no resurrected card from a late cancellation finish).

Completion criteria:

- `node --test test/consultation-status.test.mjs` passes every invariant in
  spec §11.
- A throwing `update`/`finish` caller cannot observe a thrown status store.

### B — `runClaudeConsult` progress events

Tasks:

1. Add `onProgress` option to `runClaudeConsult` with the five frozen events
   in spec §5.
2. Emit from the exact points in spec §5; never include chunk content.
3. Wrap every listener call in try/catch.
4. Keep the promise shape and settle rules byte-for-byte unchanged.

Completion criteria:

- New tests in `test/claude.test.mjs` cover normal run, timeout, abort,
  no-output, and a throwing listener.
- Existing claude tests stay green.

### C — service instrumentation

Tasks:

1. Add `status = null` dependency to `createConsultationService`.
2. Begin the card after fingerprint de-duplication and the abort-at-entry
   check, before budget reservation (spec §6 points 1–4).
3. Update `queued → running → fallback → terminal` at the exact points in
   spec §6; pass the already-resolved model/effort from `consult()` down so
   `queued` carries them.
4. Wire `onProgress` from `invoke()` into the live entry only
   (`pid`, `outputBytes`, `exitCode`, `exitSignal`).
5. Settle the card in the same terminal classification as the ledger and add
   the `finally` safety net for thrown paths.
6. Wrap all status calls so they can never alter consultation results.

Completion criteria:

- New tests in `test/consultation.test.mjs` cover: success, model-fallback,
  budget refusal, concurrency-wait abort, thrown runner, and the one-entry
  guarantee for overlapping identical calls.
- `status: null` (default) leaves all existing tests passing.

### D — tools, routes, and lifecycle wiring

Tasks:

1. `registerConsultTools` accepts `deps.status` and forwards it to the
   service.
2. `mountOptimizerRoutes` accepts `runtime.consultationStatus` and registers
   `GET /consultation-status` per spec §7.1; keep method, origin-when-present,
   and session validation plus the `503` fallback.
3. `lib/index.js` creates one store per `apply`, passes it to tools and
   routes, registers the status `session/disposed` listener **after**
   `wireAutoConsult` (cancellation starts first), and calls `dropAll()` on
   plugin dispose.
4. Do **not** add the SSE route in P3.0; spec §7.2 remains reserved.

Completion criteria:

- Route tests cover method, origin, missing session, per-session filtering,
  and absent-store 503.
- `test/consultation.test.mjs` and `test/package-peers.test.mjs` stay green.
- Manual check: `/consultation-status?session=x` returns only session `x`.

### E — client dock

Tasks:

1. Add `ConsultationDock({ sessionId, t })` and register the third seat
   `conversation.input.dock` (spec §2).
2. Add `isConsultationStatus` type guard and export it for tests.
3. Polling per spec §8.2 with recursive timer, no overlap, backoff, 404 stop,
   and stale-session discard.
4. Render per spec §8.3: phase pill with text + color, role, duration,
   model/effort/fallback, stdout bytes while running, answer/error preview,
   per-card dismiss, clear-terminal footer, 180px scroll container,
   `aria-live="polite"`.
5. Add zh/en dictionary keys (parity enforced by the existing test) and
   `.dco-cd-*` styles using host tokens.
6. Keep bundle CJS/zero-build.

Completion criteria:

- `test/client-bundle.test.mjs` seat list updated and passing.
- `isConsultationStatus` rejects HTML shells and malformed JSON.
- A rendered dock with a fake snapshot shows every phase without raw text
  injection paths (React text only).

### F — docs and release note

1. Add a "咨询状态卡片" subsection to `README.zh-cn.md` and the English
   equivalent to `README.md`: where the dock appears, what it shows, the
   8-entry in-memory limit, and that token streaming is not included.
2. Update the README screenshot only if a real consultation is available;
   otherwise leave the screenshot alone and note it.
3. Mark this plan and the spec `Status: complete` on merge.

## 4. P3.1 — SSE upgrade (after P3.0 is green)

Implement spec §7.2 behind the same status store:

- Register `GET /consultation-events`; maintain open responses in a `Set`;
  close them on route dispose.
- Subscribe to store events; send `snapshot` first, then `entry` /
  `dropped` / `disposed`; heartbeat every 15s.
- Client falls back to polling automatically on stream error and reconnects
  with the same backoff as §8.2.
- Do not start P3.1 until the polling MVP and its tests have been reviewed.

## 5. Implementation order and rationale

```
A → B → C → D → E → F
```

- A first because C and D both consume it, and it is fully unit-testable
  without touching the consultation path.
- B before C because C wires runner progress into the live entry.
- D after C because routes only expose what the service records.
- E last so the client only speaks to an endpoint that already has tests.
- F is continuous (README updated at the end so it describes shipped
  behavior, not intent).

## 6. Acceptance checklist

Automated:

- [ ] `npm test` fully green (live CLI tests may stay skipped unless
      `DCO_LIVE_CLI=1`).
- [ ] New store, runner-progress, service-status, route, and client-bundle
      tests present and passing.
- [ ] zh/en dictionaries stay equal; seat list includes
      `conversation.input.dock`.

Manual web smoke (fake/real consultation, one session):

- [ ] `consult_expert` success: card appears `queued → running → succeeded`,
      shows answer preview, and can be dismissed.
- [ ] `consult_expert` failure: card ends `failed` with the failure kind and
      error preview.
- [ ] Model fallback: card shows the fallback phase/badge, still one card.
- [ ] Cancel mid-run: card ends `aborted`; gate and ledger recover.
- [ ] Budget spent: attempted call produces a `failed/budget` card.
- [ ] `consult_panel`: one card per role, partial failure visible per role.
- [ ] Closing the session disposes its cards; another session's cards remain.
- [ ] No consultation activity: dock renders nothing and adds no vertical
      space.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Host version lacks `conversation.input.dock` | seat never mounts; nothing else depends on it; P3.0 ships polling only |
| Status instrumentation changes execution semantics | status calls are wrapped/no-throw; C tests assert tool result and gate behavior unchanged |
| Memory growth | 8 entries/session terminal eviction; active entries bounded by the existing gate; `session/disposed` drop |
| Polling load | one local no-store GET per session at 2s idle / 1s active, single-flight, 404 stops |
| Sensitive content in UI | question/answer/error previews truncated server-side; no context/artifacts/stderr; same-origin route; React text escaping |
| Client/bundle breakage | zero-build CJS stays; bundle test loads the real module body; dictionary parity test catches missing keys |
| SSE complexity | deferred to P3.1 with the wire contract already frozen |

## 8. Rollback

The feature is additive. A revert removes:

- `lib/consultation-status.js` and its test;
- the `status` option in `lib/claude.js` / `lib/consultation.js` /
  `lib/tools.js`;
- the route registration block for `consultation-status`;
- the `conversation.input.dock` injection in `client/client.js`.

Existing tool, ledger, gate, and `/test` behavior is untouched by design, so a
revert returns exactly to the pre-P3 state.
