# dsh-capability-optimizer

[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH core](https://img.shields.io/badge/DSH-%3E%3D%200.1.0--rc.6-5B4CF0?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Zero build](https://img.shields.io/badge/zero--build-no%20bundler-2EA44F?style=flat-square)](lib)
[![GitHub stars](https://img.shields.io/github/stars/hezhongtang/dsh-capability-optimizer?style=flat-square&logo=github)](https://github.com/hezhongtang/dsh-capability-optimizer/stargazers)

**External-expert consultation for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh): the agent headlessly invokes the Claude Code CLI with role personas — advisor, reviewer, designer, or your own — and weighs the subscription model's replies as reference answers.**

<p align="center">
  <img src="assets/screenshot-zh.png" width="640" alt="The Expert Consult settings workspace: one tab per harness CLI (Claude Code live, six reserved), general defaults with model / thinking-effort / fallback, the role roster, and a live connectivity test." />
</p>

English | [中文](README.zh-cn.md)

## Why this exists

A single harness has one perspective. When the DSH agent hits a decision point, finishes risky work, or starts significant new code, a second opinion from a *different* model — Claude, on your existing Claude Code subscription — is cheap insurance and a genuine quality lift. This plugin makes that a first-class tool call instead of a copy-paste detour: the agent consults, Claude answers in role, and the reply is framed as advice to **weigh, not obey** (the same contract Oh My Pi's advisors use).

Phase 1 speaks only to the Claude Code CLI. The settings schema (v2, one workspace per harness), the UI tab catalog, and the runner seam are already multi-backend: `codex`, `zcode`, `kimi-code`, `pi`, `opencode`, and `omp` each land later as a runner behind the same three tools.

## Features

| | |
|---|---|
| 🎭 **Role personas** | Built-in advisor / reviewer / designer, or your own (name, prompt, dedicated model, dedicated fallback, dedicated thinking effort). omp-style `enabled` toggle parks a role without deleting it |
| 🧠 **Thinking effort** | Native `--effort` (low / medium / high / xhigh / max) at three levels: per-call argument > role > global default |
| 🔄 **Model fallback** | One-hop retry on model-level errors (`unrecognized_model`, model-not-found, …) with `usedFallback` recorded in run metadata |
| 🤖 **Agent tools** | `consult_expert` (one role, one question) · `consult_panel` (up to N roles in parallel, one wall-clock wait) · `consult_roles` (live roster) |
| 🎛 **Auto consult** | Composer-seat toggle (permissions row) picks roles per session; a policy section rides the system prompt and lifecycle nudges fire at write/finish anchors, budgeted per role per session |
| 🖥 **Settings workspace** | One tab per harness CLI; saves hot-apply — role edits reach the agent's next model step without a dsh restart |
| 🔬 **Connectivity test** | One real consultation end-to-end (CLI + login + proxy) with turns, duration, cost, and fallback marker |
| 🛡 **Safe by default** | No permission-bypassing flags, ever; read-only tools inside headless sessions, privileged actions auto-denied |
| 🌐 **Fully bilingual** | Every UI string — including built-in role descriptions, reserved-backend notes, and validation messages — follows the UI language (zh/en); agent tooling keeps stable English identifiers |

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-capability-optimizer

# or straight from the GitHub repo
dsh plugin --profile web add github:hezhongtang/dsh-capability-optimizer
```

Restart `dsh web` (or your profile of choice). Works in any profile — web, tui, headless — because the tools are host-side agent tools.

Requirements: the `claude` CLI (`npm i -g @anthropic-ai/claude-code`) on PATH, logged in.

## Usage

Ask your agent:

> "consult the reviewer on this diff before we call it done"

The agent picks the role, packs the material into context, and calls `consult_expert`. Claude's reply returns as a reference answer with run metadata (session, turns, duration, cost) — advice the agent weighs, not an order it obeys.

| Tool | Read/Write | Purpose |
|---|---|---|
| `consult_expert` | read* | One role, one question, optional material in `context`, optional `model` / `effort` overrides |
| `consult_panel` | read* | Several roles, one question, parallel — all perspectives back together |
| `consult_roles` | read | The live roster (including role-level model/effort) and global defaults |

\* Read-only for your workspace; each call spends your Claude subscription quota — the tool descriptions themselves tell the model to batch material instead of machine-gunning calls.

## Auto consult

The composer toolbar (the permissions control's row) carries an Expert Consult toggle: check roles for this session and the host proactively works them into the loop — no prompting, no re-explaining.

- **Policy section**: every model request carries a short policy block naming the checked roles and when each applies (advisor at decision points, reviewer before declaring work done, designer before significant new code).
- **Lifecycle nudges**: the first file write of a turn arms the designer anchor (the nudge rides the next step of that turn); a turn that changed files and is about to finish without a reviewer pass is steered one more step to consult first.
- **Budget**: `capPerRole` (default 3) counts real `consult_*` calls per role per session — nudges and the model's own discretionary calls share it. At the cap the promise drops out of the policy text and the anchors go quiet.
- **Soft by design**: a nudge guarantees the instruction is delivered, never the tool call — dsh has no forced-call API. A model that declines must state the reason in one line.
- The popover shows live usage counts (`used/cap`) per role; the last selection is remembered per browser. **Settings → Expert Consult → Auto consult** edits the default checked set and budget (row-config key `autoConsult`) — the same layer tui/headless profiles consume.

## Settings UI

**Settings → Expert Consult** is organized as one workspace per harness CLI — a tab bar over the catalog (`claude-code` live; `codex`, `zcode`, `kimi-code`, `pi`, `opencode`, `omp` reserved with a planned-status page and no settings stored until their runners land). The Claude Code workspace manages everything at runtime:

- **General** — CLI path, default model (full catalog: follow-CLI-default, latest aliases, and versioned ids like `claude-opus-5` — extracted from the CLI itself), thinking effort (`--effort`: low/medium/high/xhigh/max), fallback model, per-call timeout, max turns, panel size, extra CLI args.
- **Roles workspace** — add / edit / delete roles, each with name, label, description, system prompt, a dedicated model, a dedicated fallback, and a dedicated thinking effort. A role's switch disables it omp-style: it stays in the roster but leaves the tools' enum until re-enabled.
- **Auto consult** — the default checked set plus the per-role per-session call budget; the composer toggle overrides it per session.
- **Connectivity test** — one real consultation end-to-end (CLI + auth + proxy), with turns, duration, cost, and a fallback-used marker.
- **Save & apply** persists to `~/.dsh/dsh-capability-optimizer/settings.json` (atomic writes, 0600) and hot-applies: the agent tools re-register immediately. **Reset** removes the file and restores defaults.

Per-role `model` and `effort` beat the global defaults; a call-site `effort` argument beats both. `fallbackModel` (role-level or global) retries once when Claude fails with a model-level error (`unrecognized_model`, model-not-found, ...), recording `usedFallback` in the run metadata.

## Configure (composition layer)

The row's config still works as the base layer (settings file wins once saved):

| Key | Default | Meaning |
|---|---|---|
| `cliPath` | `claude` | Path to the CLI when it is not on PATH. |
| `model` | CLI default | Model alias (`opus`, `sonnet`, ...) applied when a call does not specify one. |
| `timeoutMs` | `300000` | Wall-clock cap per consultation. |
| `maxTurns` | `8` | Agentic turn cap inside the CLI. |
| `maxPanelRoles` | `4` | Roles per `consult_panel` call. |
| `maxBudgetUsd` | `0` | Per-run dollar cap (`--max-budget-usd`) when the CLI supports it. `0` means no cap. |
| `extraArgs` | `[]` | Extra CLI args, allowlisted. Flags that widen permissions, break the JSON protocol, or duplicate typed settings are dropped and reported. |
| `roles` | built-ins | Custom roles: add new ones, or override a built-in by reusing its name. |
| `autoConsult` | `{ enabled: [], capPerRole: 3 }` | Default checked set for the auto-consult toggle (role keys like `claude-code:reviewer`) and the per-role per-session budget. |

Example — a security-focused custom role:

```yaml
- id: dsh-capability-optimizer
  name: 'dsh-capability-optimizer'
  config:
    model: sonnet
    roles:
      - name: security
        description: Threat-model focused reviewer for auth, crypto, and injection surfaces.
        systemPrompt: |-
          Role: security reviewer.
          Threat-model the material: authentication, authorization, injection,
          secrets handling, and unsafe parsing. Rate each finding by exploitability.
```

## How a consultation runs

- One `claude -p` process per consultation; the question (plus optional material) goes in via **stdin**, the role persona via `--append-system-prompt`, the reply comes back as one JSON document.
- The headless session is restricted to Read/Grep/Glob when the installed CLI advertises `--tools`. Permission-widening `extraArgs` never reach argv. Caller cancellation (`AbortSignal`) and the wall-clock timeout stay distinguishable.
- Wall-clock timeout (default 5 min) with SIGTERM → SIGKILL escalation; `--max-turns` (default 8) caps agentic turns inside the CLI.
- Every reply carries a shared framing for Claude — *this is a reference answer another agent will weigh* — so even custom roles inherit the "advice, not orders" contract.

## Security & data flow

**What the plugin guarantees:**

- The plugin never passes `--dangerously-skip-permissions` or any permission-bypassing flag. `extraArgs` is an allowlist, not a passthrough. When the installed CLI advertises `--tools`, the consultation is restricted to Read, Grep and Glob.
- Prompts travel as argv/stdin to the local CLI only — the plugin itself adds no third-party service, no telemetry, no credential storage. Routes enforce same-origin; the settings file is 0600 and atomically written; subprocess output is size-capped and timeouts always reap the child.
- Claude's reply is returned to the DSH agent as tool-result **data**, framed as a reference answer to weigh ("advice, not orders"), never as an instruction channel.

**What you should know (inherent to any agent-consults-agent setup):**

- **Your material leaves this machine to your own Claude account.** The question plus any code/diff/plan passed as context is processed by the Claude Code CLI under the account you logged in with — the same data flow as running `claude -p` yourself. Do not paste secrets you would not send to Claude directly.
- **Prompt injection is possible, not eliminated.** If consulted material (e.g. a malicious file Claude reads from the workspace) manipulates its reply, that reply reaches the DSH agent as text. The reference-answer framing and the "weigh, don't blindly obey" contract mitigate this, but treat expert replies with the same skepticism as web search results — the same residual risk class as every dual-model workflow.

## Limitations

- Phase 1 is Claude Code only; the multi-backend settings schema (v2, one workspace per harness) and UI tabs for codex / zcode / kimi-code / pi / opencode / omp are already in place — each lands as a runner behind the same tools.
- Each consultation spends your Claude subscription quota; the tool descriptions tell the model to batch material instead of machine-gunning calls.
- No streaming — one JSON result per call.

## Contributing

Issues and PRs welcome at [hezhongtang/dsh-capability-optimizer](https://github.com/hezhongtang/dsh-capability-optimizer). The codebase is intentionally small and dependency-free — plain ESM on the host, a hand-authored CJS bundle in the browser, no build step to set up. Adding a harness backend = one runner module (see `lib/claude.js`) + flipping `available` in `lib/backends.js`.

## License

[MIT](LICENSE) © 2026 hezhongtang
