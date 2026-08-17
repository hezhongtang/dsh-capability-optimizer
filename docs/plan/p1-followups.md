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
setting sources to load (user, project, local)") — verified present. Applied when
the installed CLI advertises the flag: the runner passes `--setting-sources user`,
which excludes `project` and `local` (the files that can pre-approve tools in the
repo being consulted). An older CLI that does not advertise the flag skips it.

**Explicitly rejected alternative:** a `--disallowedTools` denylist. It inverts the
failure mode — every tool a future CLI ships is permitted until someone remembers to
extend the list, so it fails *open*. `--tools` is an allowlist and is self-maintaining.

**Verification status: closed, and the finding above is superseded.** It was
measured against CLI 2.1.233 — see `docs/plan/s1-consultant-permission-surface.md`
for the full method and result tables, and `test/live-cli.test.mjs`
(`DCO_LIVE_CLI=1 npm test`) to re-run the shipped-containment arms.

Three corrections to what is written above:

1. **`permissions.allow` is gated by workspace trust.** In an untrusted
   workspace the CLI ignores those entries outright and says so on stderr. The
   escalation this section describes is real only in a workspace the user has
   already trusted — which, for the repo they work in daily, it will be.
2. **The bigger lever is `permissions.defaultMode`, which is gated by nothing.**
   The same project settings file, in an *untrusted* workspace, moved a
   consultation into `acceptEdits` (file writes) and `bypassPermissions`
   (arbitrary shell execution, zero denials). `--setting-sources user` closes it;
   so does `--tools`; so does a pinned `--permission-mode`, which is the only one
   of the three that also covers the `user` source we still load.
3. **`--tools` never bounded MCP tools.** It selects from the *built-in* set, so
   a consultation kept every MCP server in the user's own config — on the machine
   under test, 45 tools including browser automation with arbitrary JS
   evaluation, arbitrary outbound requests, and desktop input control. Given the
   packet deliberately carries `UNTRUSTED EVIDENCE`, that was an injection
   egress path. `--strict-mcp-config` reduces the surface to exactly
   `Read, Grep, Glob`.

`lib/claude.js` now passes all five flags through one `consultContainmentArgs()`
seam, each on feature detection, and records what was applied in
`meta.tools` / `meta.strictMcp` / `meta.permissionMode`.

Still unrun: the trusted-workspace `permissions.allow` arm, which would require
writing a trust entry into the user's real `~/.claude.json`.

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
