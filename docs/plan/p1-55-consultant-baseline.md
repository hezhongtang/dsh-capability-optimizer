# §5.5 consultant-layer baseline protocol

Layer 1 of report §5.5 / §7 stage 1. This document **pre-registers** the
experiment. A number that is not produced under these pins is not this
baseline.

It answers one question only:

> On these frozen review tasks, does a three-role panel find more seeded
> defects per dollar than one reviewer given more thinking effort?

It does **not** answer whether DSH ships better code with the plugin. That
is manager-layer §5.5 and is out of scope.

The haiku grid in `eval/results/2026-08-17T07-08-05-680Z-haiku.*` is a
harness smoke test. It is not this baseline and must not be pooled with it.

## 1. Pins

| Pin | Value | Why |
|---|---|---|
| Tasks | `session-cache`, `token-verify`, `event-page` as they sit in this commit | Editing a manifest invalidates comparison; add a new id instead |
| Seeds | 9 defects (4 + 2 + 3) | Fixed vocabulary and line numbers in each `eval/tasks/<id>/manifest.json` |
| Model | `sonnet` (CLI alias, no fallback) | Production consult default; haiku is too cheap/noisy to rank architecture |
| Fallback | off (`fallbackModel: ''`) | A silent model switch breaks the pin |
| `maxBudgetUsd` | 0 (unset) | A cap would truncate arms unequally |
| `maxTurns` | 6 | Same as the smoke grid |
| Containment | whatever the shipped runner applies | Recorded per row; not an experimental variable |
| Ledger | none | The session cap is a product guardrail; it must not truncate a trial |
| Scorer | `eval/lib/score.mjs` after the amendment in §3 | Deterministic; no second model |
| Arms | `single-low`, `single-high`, `single-xhigh`, `panel-3` | Same as `eval/run.mjs` |
| Trials | 5 per (task, arm) | 3 × 4 × 5 = **60 trials**; 90 consultations (panel is three roles) |
| Order | task → arm → trial, serial | Current runner; do not parallelise this run |
| CLI | whatever `claude --version` reports at start, recorded in provenance | Different CLI versions are not comparable |

Grid cost is a subscription spend. The haiku smoke was ~$1.27 for 36
consultations. Sonnet with thinking is typically several times that; budget
**$15–40** and one to three hours wall-clock. Abort mid-grid is not a
baseline — finish or discard.

## 2. Arms and the comparison that counts

| Arm | Roles | Effort | Role in the comparison |
|---|---|---|---|
| `single-low` | reviewer | low | Floor. Used only to detect “effort does not move the score” |
| `single-high` | reviewer | high | Compute-matched control |
| `single-xhigh` | reviewer | xhigh | Stronger single-agent control |
| `panel-3` | reviewer + advisor + designer | low | Treatment: more agents, not more effort |

**Primary contrast:** `panel-3` vs the single-agent arm whose mean `costUsd`
is closest (`single-xhigh` expected). Read `recallPerUsd` first, then
`recallMean`.

**Forbidden contrast:** `panel-3` vs `single-low`. That is the error §5.5
exists to prevent.

**Sanity check, not a ranking:** if `single-low.recallMean` >
`single-high.recallMean`, the grid is too noisy to rank architecture. Report
the numbers, declare ranking inconclusive, do not promote panel.

## 3. Scoring amendment (must land before the formal run)

Smoke data showed a measurement bug, not a product bug. Consultants often
write `Line 21–22` or `lines 21–25` with no path. `parseLocation` then treats
`Line` as the file, `samePath` fails, and a correct finding becomes
`unmatched` with `recall: 0`. That is why the haiku grid has
`single-low > single-high` and why `token-verify` looked like a total miss
while the unmatched prose named both seeds.

**Pre-registered rule**, single-file tasks only (all three current tasks):

- If `parseLocation` returns an empty file, or a token that is not a path
  (no `/` and no source-file extension), **and** the task `files` array has
  exactly one entry, score against that file.
- Multi-file tasks still require a recognisable path.
- Vocabulary and the ±8 line window do not change.
- Unmatched findings are still never called false positives.

Land this in `eval/lib/score.mjs` with a failing test first
(`test/eval-score.test.mjs`). Re-score the haiku jsonl as a **sensitivity
check only**, in a note, not as the baseline.

## 4. Envelope gate

`eval/run.mjs` already warns: a degraded envelope yields zero findings, so
recall measures protocol reliability.

**Pre-registered:**

- Let *envelope rate* = share of consultations whose `envelopeStatus` is
  `ok` (panel rows contribute one status per role).
- If envelope rate is **< 100%**, do not publish an architecture ranking.
  Publish the rate, inspect the raw rows, and either rerun the failed
  consultations under the same pins or stop.
- A failed spawn (`ok: false`) is a reliability number (`failureRate`,
  `recallMeanCountingFailures`), not a quality miss in `recallMean`.

## 5. What to run

Do not start the formal grid until §3 is committed and `npm test` is green.

```bash
# 1. Plumbing (no quota)
node eval/run.mjs --dry-run --model sonnet --trials 1

# 2. Envelope smoke — one trial, all arms, all tasks (12 consultations)
node eval/run.mjs --model sonnet --trials 1

# 3. Formal grid only if step 2 is 100% envelope ok
node eval/run.mjs --model sonnet --trials 5
```

Step 2 is a go/no-go, not part of the baseline. If it degrades, fix or stop
before spending the grid.

Results land in `eval/results/<iso>-sonnet.jsonl` and `.summary.json`.
Dry-run files stay gitignored. The formal pair is committed with the
reading note in §7.

## 6. How to read the summary

Look at fields in this order:

1. `meta.cliVersion`, `meta.model`, `meta.pluginVersion` — must match the pins.
2. Envelope rate (compute from the jsonl if the summary does not print it).
3. `failureRate` per arm.
4. `recallPerUsd` for `panel-3` vs the spend-matched single arm.
5. `recallMean`, `seededPrecisionMean`, `findingCountMean`.
6. Human pass over `unmatched` in the jsonl — these may be real extra
   defects; they must not be averaged into precision.

Allowed conclusions after a clean grid:

- **Panel is more expensive than it is better:** `panel-3` recall ≥ single
  control but `recallPerUsd` is clearly lower. Product keeps panel optional.
- **Panel wins on the matched dollar:** `recallPerUsd` higher *and*
  `recallMean` not worse. Still not a “DSH writes better code” claim.
- **Inconclusive:** envelope < 100%, or the low/high inversion, or costs
  missing (`costUsd` null must not be treated as free).

Not allowed: changing README quality copy; defaulting panel; wiring
`required`; starting §5.10.

## 7. Deliverables

| Artifact | Commit? |
|---|---|
| This protocol | yes |
| Scoring amendment + tests | yes, before the grid |
| `eval/README.md` pointer at this protocol and the gates | yes |
| Formal `<stamp>-sonnet.jsonl` + `.summary.json` | yes |
| `docs/plan/p1-55-consultant-baseline-reading.md` — one page, numbers + the one allowed sentence | yes, after the grid |
| Amend `docs/plan/p1-review.md` §5.5 paragraph so it no longer says “not run” | yes, after the reading note |

## 8. Out of scope

- New tasks or seed edits
- Manager-layer arms (DSH alone, lifecycle auto consult)
- Product changes driven by the numbers
- Parallelising the runner
- Treating unmatched findings as false positives
- Mixing haiku and sonnet rows
