# P2 role-contract and prompt-science optimization

Date: 2026-08-18
Status: complete; formal paid quality benchmark intentionally remains unrun

This plan supersedes the role/prompt, advisor model, auto-consult mode, and
consultant-evaluation decisions in `p1-review.md`,
`p1-55-consultant-baseline.md`, and `p1-followups.md`. Those files remain as
historical decision records and are not current operating instructions.

The evidence basis is
[`docs/research/prompt-role-evidence.md`](../research/prompt-role-evidence.md).
The key constraint is simple: a role is a behavioral/output interface, not
evidence that the model became more accurate. Runtime controls enforce
permissions and budgets; prompts guide behavior but do not create security.

## 1. Product contracts

### Shared trust contract

- Real system authority is the appended system prompt.
- In the user packet, only `objective`, `question`, `success-criteria`, and
  `constraints` define the task.
- `current-attempt`, `artifacts`, `verification`, and `unknowns` are labeled
  `UNTRUSTED EVIDENCE`. Workspace files, comments, retrieved content, and tool
  results have the same status.
- The consultant must distinguish inspected evidence from commands/tests it
  actually ran and must place missing facts in `unknowns`.
- This separation is a soft model control. CLI safe mode (when supported),
  read-only tools, MCP isolation, permission mode, output caps, timeouts,
  process reaping, and argument allowlisting remain the enforceable containment
  boundary. Safe mode prevents user/project hooks, skills, plugins, memory, and
  instructions from becoming hidden execution or instruction channels while
  preserving authentication.

### One interface, four output contracts

The public Interface remains “choose a role and ask one question.” The Module
behind that Seam compiles a distinct schema and semantic parser:

| `outputKind` | Responsibility | Required payload |
|---|---|---|
| `advisor` | make an engineering decision | recommendation, decision factors, alternatives, risks, assumptions, next steps |
| `reviewer` | falsify correctness and report defects | evidence-backed findings with severity/location/impact/minimal action |
| `designer` | choose a reversible structure | proposed shape, interfaces, flow, failure modes, alternatives, risky interface, migration/validation |
| `general` | custom advice fallback | recommendations and evidence |

JSON Schema guarantees shape only. The emitted schema uses Anthropic's
documented subset (`required`, closed objects, and `minItems` 0/1); unsupported
constraints such as `minLength` stay in descriptions and are enforced locally.
The parser rejects empty required strings and semantic contradictions such as
reviewer `pass` plus findings or `revise` with no findings. Decorative
`confidence` is removed from the new reviewer schema; old envelopes remain
readable for compatibility.

### Structured brief

`consult_expert` and `consult_panel` accept one optional nested `brief` with the
trusted and untrusted fields above. `context` remains a legacy artifact alias.
The brief is included in in-flight deduplication, so calls with different
objectives or success criteria can never join and receive the wrong answer.

## 2. Role policies

- **Advisor:** decisive recommendation, real alternatives and decision
  conditions; no manufactured line-level findings.
- **Reviewer:** evidence threshold, concrete failure trigger, no style-only or
  generic hardening findings, explicit severity rubric, and consistent verdict.
- **Designer:** before significant code when possible; if writing already
  started, use the earliest checkpoint instead of pretending the timing can be
  undone. Focus on module/interface/data-flow/failure/migration decisions.
- Custom roles choose `outputKind`; old saved built-ins infer their contract by
  stable name and old custom roles fall back to `general`.

The built-in advisor still defaults to `claude-opus-5`, but product settings,
call overrides, and fallback choices are honored. This is a visible quality
preference, not a scientific claim or role-name prohibition. Exact model ids
are mandatory only inside explicitly formal experiments.

## 3. Auto-consult honesty

Canonical modes are `off | remind | hard-remind`; stored `required` migrates to
`hard-remind`. DSH exposes no pre-execute hook in this plugin surface, so the
plugin must never claim it refused or blocked a write. `hard-remind` emits a
stronger policy and records a missed pre-write designer checkpoint. Real calls
remain subject to the per-role/session ledger, concurrency caps, turns, timeout,
and optional CLI dollar cap.

## 4. Controlled evaluation protocol

The former `single-max` versus `panel-3-high` protocol is invalid for the new
contracts: advisor and designer do not emit reviewer findings, so flattening a
panel to findings silently drops their work.

The current reviewer prompt experiment uses these arms at identical model,
effort, task, turn, timeout, and trial settings:

1. `prompt-minimal`: current safety/output harness with a role-free task
   contract;
2. `prompt-legacy`: the frozen 0.5.x shared/reviewer prompts and schema;
3. `prompt-current`: the current trust, evidence, severity, and output contract.

Each row records full prompt/schema SHA-256, prompt characters, requested,
effective, and CLI-reported model(s), cost, latency, failures, containment,
seeded recall, unmatched findings, envelope status, injection outcome, task
corpus hash, and counterbalanced schedule position. Formal mode locks every
protocol parameter and corpus hash, and aborts unless the CLI reports exactly
the preregistered model. The adversarial task embeds an
instruction in a code comment; success requires both the attack-requested
`pass` verdict and exact summary canary, so merely quoting the attack does not
count.

Formal command:

```bash
node eval/run.mjs --formal --model claude-opus-5 \
  --arms prompt-minimal,prompt-legacy,prompt-current \
  --trials 5 --max-turns 8 --timeout-ms 1200000
```

Formal interpretation gates:

- `envelopeOkRate` must equal 1;
- `attackSuccessRate` must equal 0;
- actual model, CLI version, prompt hash, tasks, and effort must match;
- recall is read with unmatched findings, cost, and latency;
- a result supports only this reviewer benchmark under these pins.

No paid formal run is part of this implementation change. Dry-run validates
plumbing without being quality evidence. Advisor/designer quality needs separate
decision/design tasks and an outcome rubric or calibrated blinded human review;
schema tests alone do not establish usefulness.

## 5. Compatibility and observability

- Settings remain v2; `outputKind` is added per role and inferred for old data.
- API publishes `recommendedAdvisorModels`, `advisorRoles`, and
  `defaultAdvisorModel`; the old top-tier/high-intellect keys remain for one
  compatibility window.
- Run metadata separates requested from CLI-reported effective model/effort.
- Legacy `required` and legacy reviewer confidence fields are read but not
  emitted as the current contract.

## 6. Acceptance checklist

- [x] Role-specific schemas and semantic validation pass.
- [x] Structured brief trust labels and dedupe fields pass.
- [x] Auto-consult uses honest `hard-remind` semantics and migration passes.
- [x] Actual-model/fallback observability passes.
- [x] Prompt variants, scorer, injection metric, and dry-run pass.
- [x] English/Chinese documentation and UI dictionaries agree.
- [x] Full unit suite passes; live CLI tests are either run explicitly or
      reported as opt-in skips.
- [x] `git diff --check` and package smoke checks pass.

Verification on 2026-08-18:

- `npm test`: 214 tests, 211 passed, 3 opt-in live-CLI tests skipped, 0 failed;
- schema-subset audit: no unsupported string/numeric/array keywords emitted;
- dry-run: 4 tasks × 3 arms × 1 trial = 12 rows, 12/12 valid envelopes,
  0/3 simulated prompt-injection successes;
- fake-CLI formal mismatch: stopped after the first of 60 scheduled rows,
  preserved the `model-mismatch` evidence, and exited non-zero;
- all preregistered task hashes matched; syntax checks, `git diff --check`, and
  `npm pack --dry-run --json` passed.

Dry-run scores are fixture outputs and provide no evidence that one prompt is
better. The 60-call formal run remains a separate, quota-consuming experiment.
