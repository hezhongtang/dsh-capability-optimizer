# P1 implementation review

> **Historical / superseded 2026-08-18.** In particular, `required` never had a
> host pre-execute enforcement seam, and the panel evaluation mixed incompatible
> role outputs. Current behavior and evaluation are specified in
> [`p2-role-contract-optimization.md`](p2-role-contract-optimization.md).

Review of the work against `docs/research/model-consultation-patterns.md` §5.5–5.11
and 2026 public evidence. Written after the product changes landed, not as a
second spec.

## What shipped (§5.6–5.8)

- **Envelope.** A successful consult can carry `{ verdict, summary, findings[], checked_scope, unknowns }` on the same `ok/role/meta` path. `verdict` is only `pass | revise | uncertain`, and only when a payload actually parses. Garbage `structured_output` or a CLI without `--json-schema` degrades to raw text (`meta.envelopeStatus` is `invalid` or `raw`). Nothing invents `pass`.
- **`--json-schema`.** Feature-detected like `--tools`. When advertised, the runner passes the advice schema. The CLI’s documented result field is `structured_output` ([CLI wrapper notes, Feb 2026](https://avasdream.com/blog/claude-cli-agentic-wrapper)).
- **Packet.** Auto and explicit consults send a labeled, size-bounded packet. User text, code, logs and diffs are marked `UNTRUSTED EVIDENCE`. Overflow is recorded in `checked_scope` / `unknowns` / `meta.packetOverflow`.
- **Triggers.** `autoConsult.mode` is exactly `off | remind | required`. Shipped default is `remind` (nudge only). `required` refuses **one** write-family tool until a consult has succeeded this turn, then allows writes. Designer copy now says the nudge is **after the first file write of a turn, on the next step**.
- **Dedupe.** Identical in-flight `(session, role, normalized question, context digest, phase)` calls join one CLI spawn. A changed digest is a new spawn. Sequential repeats still hit the attempt ledger (see deviations).

## What did not ship, and why

### §5.5 live compute-matched evaluation

**Not run here.** A four-arm experiment (DSH-only vs one advisor/reviewer vs auto anchors vs panel, plus extra-token single-agent controls) needs a frozen task set, model pin, and repeated live subscription runs. This environment cannot honestly produce that.

That omission is load-bearing. Anthropic’s own multi-agent research write-up attributes ~80% of the measured gain to token spend and notes coding often lacks enough independent subtasks ([Anthropic, 2025](https://www.anthropic.com/engineering/multi-agent-research-system)). A 2026 controlled study finds that under equal thinking-token budgets, single-agent systems match or beat multi-agent ones on multi-hop reasoning; reported MAS wins are often unaccounted compute ([Tran & Kiela, arXiv:2604.02460](https://arxiv.org/abs/2604.02460)). Until we run §5.5 on *this* plugin’s tasks, we must not claim the new envelope or `required` mode improves code quality.

### §5.9 leftovers

`maxBudgetUsd`, `--no-session-persistence`, and basic failure kinds already shipped in P0. We did not add OTEL, quota/rate-limit taxonomy, or schema-retry loops (the CLI may retry `--json-schema` internally; we only consume the public result).

### §5.10–5.11 (P2)

Second-pass verification and FIFO advisor state stay off. 2026 debate evidence still does not justify defaulting them: vanilla multi-agent debate is not a stable upgrade over a strong single pass, and extra agents cost tokens. The report’s own sequencing puts evaluation before these.

## Independent judgment vs the report

The report’s **architecture call is still right**: keep manager → isolated consultant → reference answer. Do not handoff, do not default panel, do not import an orchestration runtime.

Where I differ from a naive “finish every P1 bullet”:

1. **Do not treat `--json-schema` as truth.** 2026 CLI write-ups are explicit: schema validation is after generation, not constrained decoding. We parse and degrade; we do not trust `pass`.
2. **`required` is a seatbelt, not a quality gate.** A refused write only forces a pause. Advisor `verdict` is still advice. Ending a turn because a consultant said `pass` would violate report §6.7.
3. **No post-success cooldown.** A cooldown that reused a successful answer would let a second tool call skip the attempt ledger. Overlapping joins are enough to stop double-spawn; sequential repeats must still pay the cap.
4. **`required` seam.** DSH does not expose a documented pre-execute hook in this plugin’s inject surface. The shipped decision is `runtime.refuseWrite(sessionId, tool)`. Wiring observes `session/event` `tool/call` and `tool/before` if the host ever emits the latter. A true block of the host Write tool still needs a DSH pre-execute API.

## P0 contracts

Abort vs timeout, extraArgs allowlist, ledger-bound tool path, and `/test` sharing the production consult path remain. Envelope and packet sit on that path; they do not fork it.

## Amended after S1 was measured

Written before the containment work in `docs/plan/s1-consultant-permission-surface.md`.
One line above needs qualifying: marking the packet's material as
`UNTRUSTED EVIDENCE` was, at the time this review was written, the *only* thing
standing between injected instructions and a live tool. Measurement showed the
consultant was also holding every MCP tool in the user's own config — `--tools`
governs the built-in set only — which gave a successful injection a network
egress path and desktop control. `--strict-mcp-config` and a pinned
`--permission-mode` now close that; the labelling is back to being one layer of
several rather than the last one.

Nothing here changes the §5.5 conclusion below. Containment is not quality.

## Bottom line

Ship the P1 *product* surface (envelope, packet, honest triggers, in-flight dedupe). Do not ship a quality claim. The next honest step is still report §5.5, not §5.10.
