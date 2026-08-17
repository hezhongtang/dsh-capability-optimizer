# §5.5 evaluation baseline

The research report (`docs/research/model-consultation-patterns.md` §5.5, §7) puts
one gate before every behaviour change: measure whether consultation helps, with
**compute-matched controls**, on this plugin's own tasks. Without that, more
tokens read as better architecture. Anthropic's own multi-agent write-up
attributes ~80% of its measured gain to token spend, and a 2026 controlled study
finds single-agent systems match or beat multi-agent ones at equal thinking-token
budgets.

This directory is that harness. It runs real consultations through the shipped
path and reports every quality number next to the spend that bought it.

**Consultant-layer formal baseline** (layer 1) is pre-registered in
[`docs/plan/p1-55-consultant-baseline.md`](../docs/plan/p1-55-consultant-baseline.md):
model `claude-opus-5`, arms `single-max` (effort `max`) vs `panel-3-high`
(effort `high`), 5 trials, envelope must be 100% before any architecture ranking.
Advisor is a high-intelligence role and may only consult a top-tier model
(`claude-opus-5`); a live run that would put it on haiku/sonnet is refused.
The haiku grid in `results/` is a smoke test, not that baseline.

## What it measures, and what it cannot

**Measured here** — the *consultant layer*:

- **finding-level**: seeded-defect recall, seeded precision, finding count
  (duplication across panel roles shows up here), envelope reliability;
- **resource-level**: cost, wall-clock, failure kinds, and `recallPerUsd`, which
  is the number the compute-matched comparison actually turns on.

**Not measured here** — the *manager layer*. The report's arms 1 and 3 ("DSH
alone", "lifecycle auto reviewer/designer") need DSH itself as the manager under
test, and DSH is not in this repo. Those arms are **unrun**, not approximated
with a stand-in manager: a substitute manager would measure the substitute.
Anything claiming consultation improves end-to-end task outcomes still needs
them.

So: this harness can tell you whether a panel finds more seeded defects than one
consultant given the same budget. It cannot tell you whether DSH ships better
code with the plugin than without it.

## The arms

| arm | roles | effort | role in the comparison |
|---|---|---|---|
| `single-max` | reviewer | max | **baseline control** — one deepest pass |
| `panel-3-high` | reviewer + advisor + designer | high | **baseline treatment** — three shallower passes |
| `single-low` / `single-high` / `single-xhigh` / `panel-3` / `panel-3-max` | (smoke) | various | optional; not the formal baseline |

The formal contrast is `panel-3-high` against `single-max`. `panel-3-max` is
not that contrast: it spends more agents and keeps max effort, so a win cannot
tell those apart.

## Running it

```bash
node eval/run.mjs --dry-run                        # plumbing only, spends nothing
node eval/run.mjs --model haiku --trials 2         # reviewer-only smoke (not the baseline)
node eval/run.mjs --model claude-opus-5 --arms single-max,panel-3-high \
  --trials 5 --max-turns 8 --timeout-ms 1200000   # formal layer-1 grid
```

Every run writes `results/<timestamp>-<model>.jsonl` (one row per trial, with
raw findings kept verbatim) and a `.summary.json` carrying CLI version, plugin
version, model, platform and the arm arguments. Runs with different `cliVersion`
or `model` are **not** comparable and must not be pooled.

Real consultations spend subscription quota. The grid is
`tasks × arms × trials` trials, and `panel-3` costs three consultations per
trial.

## Scoring

`lib/score.mjs` matches a finding to a seeded defect on file **and** line
proximity **and** the defect's vocabulary. It is deliberately strict, and one
finding can satisfy at most one defect — otherwise a single vague finding that
name-drops every keyword would score full recall.

A finding that matches nothing is recorded in `unmatched`, **never** counted as
a false positive. Seeded-defect evaluation cannot distinguish a hallucination
from a real defect nobody thought to seed. Read `unmatched` before drawing any
conclusion about precision; `seededPrecision` is the share of findings that land
on a seed, which is not the same claim as "share of findings that are correct".

## Reading the output honestly

- **Check `structured envelopes` first.** A degraded envelope yields zero
  findings, so recall would be measuring envelope reliability rather than review
  quality. If that line is not 100%, the recall numbers are not a quality result.
- `recall: null` means the task seeded nothing — it never averages in as zero.
- A failed consultation is not a measurement. It moves `failureRate` and
  `recallMeanCountingFailures`, not `recallMean`.
- A missing `costUsd` stays `null` rather than counting as free, because a
  subscription run that reports no cost would otherwise look infinitely
  efficient and destroy the matched comparison.
- Trial counts here are small. Treat a single run as a pilot, not a baseline.

## Tasks

Each `tasks/<id>/manifest.json` freezes a review question, the files the
consultant is shown, and the defects seeded in them with locations and matching
vocabulary. Editing a task invalidates comparison with earlier results — add a
new task instead.

Current set: `session-cache` (4 seeds), `token-verify` (2), `event-page` (3).
Small on purpose: the harness and its honesty properties matter more than
breadth, and breadth is cheap to add once the shape is right.
