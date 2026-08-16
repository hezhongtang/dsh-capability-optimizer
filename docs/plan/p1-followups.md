# Carried forward from the P0 work

Findings surfaced while implementing `docs/plan/p0-contracts.md` that are real but
out of P0 scope. Recorded so they are not lost; none of them block the P0 release.

## S1 — Ambient `permissions.allow` can pre-approve tools inside a consultation

**Severity: the highest-value finding of the P0 work. Sizing: P1.**

The P0 contract, and the research report it came from, both assumed that Claude
Code's print mode auto-denies anything requiring permission, making the read-only
tool set belt-and-braces. That assumption is wrong in one specific and likely case.

A consultation runs **in the user's project directory**. The plugin does not pass
`--setting-sources` or `--safe-mode`, so user / project / local settings still load —
and a `permissions.allow` entry in that project's own `.claude/settings.json`
(`Bash(git *)`, `Edit`, …) pre-approves those tools with no prompt to show. Print
mode auto-denies only what nobody has pre-approved.

Consequence: `--tools Read,Grep,Glob` is **load-bearing**, not defence-in-depth. On
a CLI new enough to advertise `--tools` (2.1.233 does) the hole is closed. On an
older CLI the feature probe suppresses the flag and the hole is open.

**Lever:** `--setting-sources <sources>` exists on 2.1.233 ("Comma-separated list of
setting sources to load (user, project, local)") — verified present. One flag, root
cause, nothing to keep in sync. Feature-detect it the same way as `--tools`.

**Explicitly rejected alternative:** a `--disallowedTools` denylist. It inverts the
failure mode — every tool a future CLI ships is permitted until someone remembers to
extend the list, so it fails *open*. `--tools` is an allowlist and is self-maintaining.

**Verification status:** the existence of the flags is confirmed against the installed
CLI. The settings-vs-flag *precedence* (deny-over-allow ordering) is documented Claude
Code behaviour but was **not** empirically tested here. Test it before relying on it.

## S2 — `maxBudgetUsd` reaches the CLI but nothing else

**Closed in the P0 integration pass.** The field is now defined (`0` = no cap),
validated, accepted from row config, and forwarded when the installed CLI
advertises `--max-budget-usd`.

## S3 — `extraArgs` rejection should not be able to void the whole settings file

**Closed in the P0 integration pass.** Refused args ride a `rejectedArgs` sibling
channel: the save succeeds, the flag is dropped, and the route reports what was
ignored. `effectiveSettings()` no longer falls back to row config over one bad flag.

## S4 — Client UI does not show what the budget was spent on

`client/client.js:659` renders `counts[role]/cap` only. The ledger now distinguishes
attempts / succeeded / failed / aborted, and `snapshot()` exposes `usage` and
`promised`. A role that burned its entire budget on failures currently looks identical
to one that spent it on successful reviews. Nobody owned `client/client.js` during P0.

## S5 — `filterExtraArgs` assumes positionals are never wanted

Correct today: the question always goes over stdin, so a bare positional can only be a
mistake or a smuggling attempt. Revisit if a positional prompt path is ever added.

## From the research report, unchanged

`docs/research/model-consultation-patterns.md` §5.5–5.11 remain the P1/P2 backlog:
compute-matched evaluation before widening auto-consultation, the structured advice
envelope, the auto-reviewer context packer, `off | remind | required` trigger
semantics, dedupe fingerprints, and second-pass verification for high-risk findings.
The report's own sequencing puts the evaluation baseline (§5.5) before any of the
behaviour changes, and nothing found during P0 contradicts that.
