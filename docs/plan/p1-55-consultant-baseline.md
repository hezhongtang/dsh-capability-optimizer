# §5.5 consultant-layer baseline protocol

Layer 1 of report §5.5 / §7 stage 1. This document **pre-registers** the
experiment. A number that is not produced under these pins is not this
baseline.

It answers one question only:

> On these frozen review tasks, at `claude-opus-5`, is one reviewer at
> `--effort max` more accurate per dollar than three roles at `--effort high`?

It does **not** answer whether DSH ships better code with the plugin. That
is manager-layer §5.5 and is out of scope.

The haiku grid in `eval/results/2026-08-17T07-08-05-680Z-haiku.*` is a
harness smoke test. It is not this baseline and must not be pooled with it.

## 1. Pins

| Pin | Value | Why |
|---|---|---|
| Tasks | `session-cache`, `token-verify`, `event-page` as they sit in this commit | Editing a manifest invalidates comparison; add a new id instead |
| Seeds | 9 defects (4 + 2 + 3) | Fixed vocabulary and line numbers in each `eval/tasks/<id>/manifest.json` |
| Model | `claude-opus-5` (versioned id, not the floating `opus` alias) | Consultant must be a stronger coder than the DSH manager. See §1a |
| Effort | `max` on the single arm; `high` on every panel role | Thinking budget on the *same* top-tier model, not a capability drop |
| Fallback | off (`fallbackModel: ''`) | A silent model switch breaks the pin |
| `maxBudgetUsd` | 0 (unset) | A cap would truncate arms unequally |
| `maxTurns` | 8 | Product default; max thinking may use the extra tool turns |
| `timeoutMs` | 1200000 (20 min) | Opus 5 / max will blow the 5 min smoke timeout |
| Containment | whatever the shipped runner applies | Recorded per row; not an experimental variable |
| Ledger | none | The session cap is a product guardrail; it must not truncate a trial |
| Scorer | `eval/lib/score.mjs` after the amendment in §3 | Deterministic; no second model |
| Arms | `single-max`, `panel-3-high` | Same model; effort and agent count trade off |
| Trials | 5 per (task, arm) | 3 × 2 × 5 = **30 trials**; 60 consultations |
| Order | task → arm → trial, serial | Current runner; do not parallelise this run |
| CLI | whatever `claude --version` reports at start, recorded in provenance | Different CLI versions are not comparable |

## 1a. Consultant must outrank the manager

The DSH agent is the one doing the work. A consult is only meaningful when
the advice-giver has **higher intelligence and coding ability** than that
manager. Asking a weaker or peer model for a second opinion is not this
product, and it is not this baseline.

Consequences, pre-registered:

- Formal-grid consultant is `claude-opus-5`. `haiku`, `sonnet`, `fable`, and
  the floating `opus` alias are not substitutes.
- **Advisor** is the high-intelligence role. Settings defaults it to
  `claude-opus-5`, the roster marks it as top-tier, and a save that would
  put it on haiku/sonnet is refused. A live eval run that includes
  `advisor` and a non-top-tier model is refused by
  `lib/consultant-model.js`. Dry-run plumbing is exempt.
- Reviewer and designer on the formal panel stay on the same top-tier id
  (the runner has one `--model` for the grid). Do not build a mixed-capability
  panel to save money.
- `--effort high` on the panel is **not** a downgrade of the model. It is
  less thinking on Opus 5. `--model sonnet` would be the forbidden
  downgrade.
- The haiku smoke grid can still exercise reviewer-only arms. It cannot
  answer the product question and must not be pooled with this baseline.

The intended trade-off is the product question: spend the thinking budget on
**one deepest pass**, or **split it across three roles at a lower effort**.
Do not run `panel-3-max` as the treatment — that spends more agents *and*
keeps max effort, so a win cannot tell those apart.

Grid cost is a subscription spend. Fifteen Opus 5 / max consults plus
forty-five Opus 5 / high consults will be expensive; budget **$80–250** and
several hours wall-clock. Abort mid-grid is not a baseline — finish or discard.

## 2. Arms and the comparison that counts

| Arm | Roles | Effort | Role in the comparison |
|---|---|---|---|
| `single-max` | reviewer | max | Control: one deepest pass |
| `panel-3-high` | reviewer + advisor + designer | high | Treatment: three shallower passes |

**Primary contrast:** `panel-3-high` vs `single-max`. Read `recallPerUsd`
first, then `recallMean`.

**Spend check:** record `costUsdMean(panel-3-high) / costUsdMean(single-max)`.
The hypothesis is that three `high` passes sit in the same spend band as one
`max` pass. If the ratio is **> 3**, the panel is just a more expensive
configuration — say so, and do not treat a recall win as a compute-matched
result. A ratio **< 0.5** means the panel was cheaper; a recall loss then
still answers the product question (splitting did not pay).

**Forbidden:** `panel-3-max` vs `single-max` as the formal ranking (same
effort, 3× agents). Also forbidden: pooling these rows with the haiku smoke
grid.

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
node eval/run.mjs --dry-run --model claude-opus-5 --arms single-max,panel-3-high --trials 1

# 2. Envelope smoke — one trial, both arms, all tasks (12 consultations)
node eval/run.mjs --model claude-opus-5 --arms single-max,panel-3-high \
  --trials 1 --max-turns 8 --timeout-ms 1200000

# 3. Formal grid only if step 2 is 100% envelope ok
node eval/run.mjs --model claude-opus-5 --arms single-max,panel-3-high \
  --trials 5 --max-turns 8 --timeout-ms 1200000
```

Step 2 is a go/no-go, not part of the baseline. If it degrades, fix or stop
before spending the grid.

Results land in `eval/results/<iso>-claude-opus-5.jsonl` and `.summary.json`.
Dry-run files stay gitignored. The formal pair is committed with the
reading note in §7.

## 6. How to read the summary

Look at fields in this order:

1. `meta.cliVersion`, `meta.model`, `meta.pluginVersion` — must match the pins.
2. Envelope rate (compute from the jsonl if the summary does not print it).
3. `failureRate` per arm.
4. `recallPerUsd` for `panel-3-high` vs `single-max`, plus the spend ratio.
5. `recallMean`, `seededPrecisionMean`, `findingCountMean`.
6. Human pass over `unmatched` in the jsonl — these may be real extra
   defects; they must not be averaged into precision.

Allowed conclusions after a clean grid:

- **One deep pass wins:** `single-max` `recallPerUsd` higher, or equal
  recall at lower spend. Default product stays one reviewer, not a panel.
- **Splitting wins on the matched dollar:** `panel-3-high` `recallPerUsd`
  higher *and* `recallMean` not worse, with spend ratio ≤ 3. Still not a
  “DSH writes better code” claim.
- **Inconclusive:** envelope < 100%, spend ratio > 3 with a panel recall
  win, or costs missing (`costUsd` null must not be treated as free).

Not allowed: changing README quality copy; defaulting panel; wiring
`required`; starting §5.10.

## 7. Deliverables

| Artifact | Commit? |
|---|---|
| This protocol | yes |
| Scoring amendment + tests | yes, before the grid |
| `eval/README.md` pointer at this protocol and the gates | yes |
| Formal `<stamp>-claude-opus-5.jsonl` + `.summary.json` | yes |
| `docs/plan/p1-55-consultant-baseline-reading.md` — one page, numbers + the one allowed sentence | yes, after the grid |
| Amend `docs/plan/p1-review.md` §5.5 paragraph so it no longer says “not run” | yes, after the reading note |

## 8. Out of scope

- New tasks or seed edits
- Manager-layer arms (DSH alone, lifecycle auto consult)
- Product changes driven by the numbers
- Parallelising the runner
- Treating unmatched findings as false positives
- Mixing haiku (or any other model/effort) rows with this grid
- Using the floating `opus` alias instead of `claude-opus-5`
- Putting `advisor` (or the formal panel) on haiku/sonnet “to save quota”
