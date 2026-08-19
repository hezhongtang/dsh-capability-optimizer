/**
 * Headless Claude Code CLI runner for dsh-capability-optimizer.
 *
 * One consultation = one `claude -p` process: the user message goes in via
 * stdin (no argv quoting hazards, no length limits worth worrying about),
 * the role contract via `--append-system-prompt`, and the reply comes back as
 * one JSON document on stdout which we parse defensively. Tool use inside
 * the headless session keeps Claude Code's print-mode default and is narrowed
 * further to a read-only built-in set — we never pass a permission-bypassing
 * flag, and `filterExtraArgs` makes sure a config cannot pass one for us.
 *
 * Lifecycle: the promise settles exactly once and only after the child's
 * `close` event, so a caller that has been told the run is over is never
 * racing a process that is still alive. Caller cancellation (`signal`) and the
 * wall-clock timeout both terminate the child and stay distinguishable in the
 * result (`failure: 'aborted'` vs `'timeout'`).
 */
import { spawn } from 'node:child_process'
import { filterExtraArgs } from './argfilter.js'
import { ADVICE_ENVELOPE_SCHEMA } from './envelope.js'

/** Hard cap on captured stdout/stderr so a runaway CLI cannot exhaust host memory. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
/** Grace period between SIGTERM and SIGKILL when the timeout fires. */
const KILL_GRACE_MS = 5000
/** Wall-clock cap for the one-off `claude --help` capability probe. */
const HELP_PROBE_TIMEOUT_MS = 10000
/** Enough of `--help` to find every flag; a runaway help text is not our problem. */
const MAX_HELP_BYTES = 256 * 1024
/**
 * Built-in tools a consultant needs and nothing more. The expert reads the
 * project to ground its answer; it never edits, runs commands or reaches the
 * network on our behalf.
 */
const READ_ONLY_TOOLS = 'Read,Grep,Glob'
/** Legal `--effort` levels (the CLI's own enum for thinking effort). */
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * The model catalog the CLI itself accepts, extracted from its binary:
 * latest-generation aliases plus versioned full ids. `''` (empty) means
 * "follow the CLI's own default" and is represented by the select's explicit
 * first option, not by an alias. The catalog is served to the client; a
 * stored value outside it still renders via a passthrough option.
 */
export const MODEL_CATALOG = {
  aliases: ['opus', 'sonnet', 'fable', 'haiku', 'opusplan'],
  versioned: [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ],
}

/**
 * Resolve the CLI to invoke: an explicit config path wins, else the bare
 * `claude` name resolved through PATH by spawn itself.
 * @param {{ cliPath?: string }} [config]
 */
export function resolveClaudeCommand(config) {
  const configured = typeof config?.cliPath === 'string' ? config.cliPath.trim() : ''
  return configured.length > 0 ? configured : 'claude'
}

/**
 * Which optional flags the installed CLI advertises, keyed by resolved command.
 * The probe costs one `claude --help` per binary per process, so it is cached;
 * a probe that could not read any help text is not cached, so a transient
 * failure does not permanently downgrade the safe defaults.
 * @type {Map<string, Promise<CliCapabilities>>}
 */
const capabilityCache = new Map()

/**
 * @typedef {object} CliCapabilities
 * @property {boolean} tools
 * @property {boolean} noSessionPersistence
 * @property {boolean} maxBudgetUsd
 * @property {boolean} settingSources
 * @property {boolean} safeMode
 * @property {boolean} jsonSchema
 * @property {boolean} strictMcpConfig
 * @property {string[]} permissionModes - the `--permission-mode` vocabulary the
 *           installed CLI advertises; empty when it does not publish one.
 * @property {boolean} probed
 */

/** No help text: assume nothing optional is supported. */
const NO_CAPABILITIES = Object.freeze({
  tools: false,
  noSessionPersistence: false,
  maxBudgetUsd: false,
  settingSources: false,
  safeMode: false,
  jsonSchema: false,
  strictMcpConfig: false,
  permissionModes: Object.freeze([]),
  probed: false,
})

/**
 * Sources loaded when the CLI advertises `--setting-sources`.
 * `project` and `local` live in the repo being consulted and can pre-approve
 * Bash/Edit via `permissions.allow`; `user` is the remainder the CLI accepts.
 */
const SETTING_SOURCES = 'user'

/**
 * Permission modes we are willing to pin, most preferred first. Both mean
 * "decide nothing automatically" — which, with no TTY to prompt, is a refusal.
 * `manual` is the current name, `default` the older one; we only ever pass a
 * value the installed CLI advertised, because an unknown enum value fails the
 * whole invocation rather than just the flag.
 */
const PERMISSION_MODE_PREFERENCE = ['manual', 'default']

/** Drop the cached `--help` probe (tests, and a cliPath change at runtime). */
export function resetCliCapabilities() {
  capabilityCache.clear()
}

/**
 * Feature-detect the optional flags we would like to pass by default. We never
 * assume a flag exists: an older CLI would reject the whole invocation, which
 * would turn a safety improvement into an outage.
 * @returns {Promise<{tools: boolean, noSessionPersistence: boolean, maxBudgetUsd: boolean, settingSources: boolean, jsonSchema: boolean, probed: boolean}>}
 */
export function probeCliCapabilities(file) {
  const cached = capabilityCache.get(file)
  if (cached !== undefined) return cached

  const probe = new Promise((resolve) => {
    let child
    try {
      child = spawn(file, ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(NO_CAPABILITIES)
      return
    }
    let help = ''
    let done = false
    const settle = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(help.length > 0 ? parseCapabilities(help) : NO_CAPABILITIES)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { if (help.length < MAX_HELP_BYTES) help += chunk })
    child.on('error', settle)
    child.on('close', settle)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      settle()
    }, HELP_PROBE_TIMEOUT_MS)
    timer.unref()
  }).then((capabilities) => {
    if (!capabilities.probed) capabilityCache.delete(file)
    return capabilities
  })

  capabilityCache.set(file, probe)
  return probe
}

/** Read the flag list out of `claude --help` output. */
function parseCapabilities(help) {
  const advertises = (flag) => new RegExp(`(^|[\\s,])${flag}(?![\\w-])`, 'm').test(help)
  return {
    tools: advertises('--tools'),
    noSessionPersistence: advertises('--no-session-persistence'),
    maxBudgetUsd: advertises('--max-budget-usd'),
    settingSources: advertises('--setting-sources'),
    safeMode: advertises('--safe-mode'),
    jsonSchema: advertises('--json-schema'),
    strictMcpConfig: advertises('--strict-mcp-config'),
    permissionModes: parsePermissionModes(help),
    probed: true,
  }
}

/**
 * The `--permission-mode` enum the installed CLI publishes, in help order.
 * Returns `[]` when the flag is missing or documents no choices — we would
 * rather skip the flag than guess a value the CLI will reject.
 */
function parsePermissionModes(help) {
  const at = help.indexOf('--permission-mode')
  if (at < 0) return []
  const rest = help.slice(at)
  // Bound the entry at the next option line so a later flag's choice list
  // cannot leak in. Wrapped continuation lines are indented far deeper.
  const next = rest.slice(1).search(/\n\s{0,10}-{1,2}[A-Za-z]/)
  const entry = next < 0 ? rest : rest.slice(0, next + 1)
  const choices = entry.match(/choices:([^)]*)\)/i)
  if (choices === null) return []
  return [...choices[1].matchAll(/"([A-Za-z][\w-]*)"/g)].map((match) => match[1])
}

/**
 * Everything that keeps a consultation read-only, in one place.
 *
 * Each flag is applied only when the installed CLI advertises it, and each
 * closes a different escape route — verified against CLI 2.1.233, see
 * `docs/plan/s1-consultant-permission-surface.md`:
 *
 *  - `--tools`             bounds the *built-in* tools. Necessary, not sufficient.
 *  - `--safe-mode`         disables user/project instructions, skills, plugins,
 *                          hooks, MCP, and memory while preserving auth/model/
 *                          built-in tools/permissions.
 *  - `--strict-mcp-config` empties the MCP surface, which `--tools` does not
 *                          govern at all: without it the consultant inherits
 *                          every user-scope MCP tool, browser automation and
 *                          desktop control included.
 *  - `--setting-sources`   drops the project/local settings of the repo being
 *                          consulted, which can pre-approve tools.
 *  - `--permission-mode`   outranks `permissions.defaultMode` from *any*
 *                          settings source, including the user source that
 *                          `--setting-sources user` still loads.
 *
 * Exported so the live-CLI test can assert the shipped containment against a
 * real `claude` binary without restating the rules and drifting from them.
 *
 * @param {CliCapabilities} capabilities
 * @returns {{args: string[], applied: {tools?: string, safeMode?: true, strictMcp?: true, permissionMode?: string}}}
 */
export function consultContainmentArgs(capabilities) {
  const args = []
  const applied = {}
  if (capabilities.tools) {
    args.push('--tools', READ_ONLY_TOOLS)
    applied.tools = READ_ONLY_TOOLS
  }
  if (capabilities.safeMode) {
    args.push('--safe-mode')
    applied.safeMode = true
  }
  if (capabilities.noSessionPersistence) args.push('--no-session-persistence')
  if (capabilities.settingSources) args.push('--setting-sources', SETTING_SOURCES)
  if (capabilities.strictMcpConfig) {
    args.push('--strict-mcp-config')
    applied.strictMcp = true
  }
  const mode = PERMISSION_MODE_PREFERENCE.find((candidate) => capabilities.permissionModes.includes(candidate))
  if (mode !== undefined) {
    args.push('--permission-mode', mode)
    applied.permissionMode = mode
  }
  return { args, applied }
}

/**
 * Run one headless consultation.
 *
 * @param {object} options
 * @param {string} options.userMessage - full stdin message (question + material).
 * @param {string} options.systemPrompt - role contract for `--append-system-prompt`.
 * @param {object} [options.outputSchema] - role-specific structured-output contract.
 * @param {string} [options.model] - model alias (`opus`, `sonnet`, ...) or full id.
 * @param {string} [options.effort] - thinking-effort level (`low|medium|high|xhigh|max`).
 * @param {number} [options.maxTurns] - agentic turn cap inside the CLI.
 * @param {number} [options.maxBudgetUsd] - spend cap for the run, when the CLI supports it.
 * @param {number} [options.timeoutMs] - wall-clock cap for the whole process.
 * @param {string} [options.cwd] - working directory (defaults to process cwd).
 * @param {string[]} [options.extraArgs] - configured extra CLI args, allowlisted here.
 * @param {{ cliPath?: string }} [options.config] - plugin config (cliPath).
 * @param {AbortSignal} [options.signal] - caller cancellation; kills the child.
 * @param {(event: object) => void} [options.onProgress] - structural progress
 *        events only (`spawn`, `stdout`, `stderr`, `terminate`, `exit`); never
 *        carries output content. A throwing listener is swallowed.
 * @param {number} [options.killGraceMs] - SIGTERM→SIGKILL grace (tests shorten it).
 * @param {number} [options.maxCaptureBytes] - stdout/stderr capture cap (tests shrink it).
 * @returns {Promise<{ok: true, answer: string, meta: object} | {ok: false, error: string, failure: string, meta: object}>}
 */
export async function runClaudeConsult(options) {
  const {
    userMessage,
    systemPrompt,
    outputSchema,
    model,
    effort,
    maxTurns,
    maxBudgetUsd,
    timeoutMs = 300000,
    cwd,
    extraArgs,
    config,
    signal,
    onProgress,
    killGraceMs = KILL_GRACE_MS,
    maxCaptureBytes = MAX_CAPTURE_BYTES,
  } = options

  const emitProgress = typeof onProgress === 'function'
    ? (event) => { try { onProgress(event) } catch { /* progress is advisory */ } }
    : null

  const file = resolveClaudeCommand(config)
  const meta = {}

  // Nothing from config reaches argv unfiltered. A refusal is reported, not fatal.
  const filtered = filterExtraArgs(extraArgs)
  if (filtered.rejected.length > 0) meta.rejectedArgs = filtered.rejected

  const listens = signal !== undefined && signal !== null && typeof signal.addEventListener === 'function'
  if (listens && signal.aborted) return abortedResult(meta)

  const capabilities = await probeCliCapabilities(file)
  if (listens && signal.aborted) return abortedResult(meta)

  const schema = outputSchema !== null && typeof outputSchema === 'object' && !Array.isArray(outputSchema)
    ? outputSchema
    : ADVICE_ENVELOPE_SCHEMA
  // Older CLIs cannot enforce the role schema. Keep the contract visible to
  // the model without pretending this prompt-only fallback is enforcement.
  const effectiveSystemPrompt = capabilities.jsonSchema
    ? systemPrompt
    : `${systemPrompt}\n\nThe installed CLI cannot enforce structured output. Return only JSON matching this exact schema: ${JSON.stringify(schema)}`
  if (!capabilities.jsonSchema) meta.schemaInPrompt = true

  const args = ['-p', '--output-format', 'json', '--append-system-prompt', effectiveSystemPrompt]
  const containment = consultContainmentArgs(capabilities)
  args.push(...containment.args)
  Object.assign(meta, containment.applied)
  if (capabilities.jsonSchema) {
    args.push('--json-schema', JSON.stringify(schema))
    meta.jsonSchema = true
  }
  if (typeof model === 'string' && model.trim().length > 0) args.push('--model', model.trim())
  if (typeof effort === 'string' && EFFORT_LEVELS.has(effort)) args.push('--effort', effort)
  if (Number.isFinite(maxTurns) && maxTurns > 0) args.push('--max-turns', String(Math.floor(maxTurns)))
  if (capabilities.maxBudgetUsd && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(maxBudgetUsd))
  }
  args.push(...filtered.args)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        ok: false,
        error: `failed to start ${file}: ${error instanceof Error ? error.message : String(error)}`,
        failure: 'spawn',
        meta,
      })
      return
    }
    if (child.pid !== undefined) emitProgress?.({ type: 'spawn', pid: child.pid })

    let stdout = ''
    let stderr = ''
    let settled = false
    let stopped = false
    let overflowed = false
    /** 'timeout' | 'aborted' — whichever arrived first; never both. */
    let termination = null
    let spawnError = null
    let exitCode = null
    let exitSignal = null
    let killTimer = null

    const settle = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (listens) signal.removeEventListener('abort', onAbort)
      resolve(payload)
    }

    /**
     * Stop consuming output and take the child down. We do not settle here:
     * that waits for `close`, so the caller is never told the run is over
     * while the process is still running.
     */
    const terminate = (reason) => {
      if (settled || termination !== null) return
      termination = reason
      if (reason === 'timeout') meta.timedOut = true
      else meta.aborted = true
      emitProgress?.({ type: 'terminate', reason })
      stopped = true
      try { child.stdin.destroy() } catch { /* already closed */ }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, killGraceMs)
      killTimer.unref()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stopped || overflowed) return
      if (stdout.length + chunk.length > maxCaptureBytes) { overflowed = true; return }
      stdout += chunk
      emitProgress?.({ type: 'stdout', bytes: chunk.length, totalBytes: stdout.length })
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stopped || stderr.length + chunk.length > maxCaptureBytes) return
      stderr += chunk
      emitProgress?.({ type: 'stderr', bytes: chunk.length, totalBytes: stderr.length })
    })

    const timer = setTimeout(() => terminate('timeout'), timeoutMs)
    timer.unref()
    const onAbort = () => terminate('aborted')
    if (listens) signal.addEventListener('abort', onAbort, { once: true })

    const finish = () => {
      if (settled) return
      const parsed = parseResultJson(stdout)
      Object.assign(meta, parsed.meta)

      if (termination === 'aborted') {
        settle({ ok: false, error: 'consultation was cancelled by the caller', failure: 'aborted', meta })
        return
      }
      if (termination === 'timeout') {
        settle({ ok: false, error: `claude CLI exceeded ${timeoutMs}ms and was killed`, failure: 'timeout', meta })
        return
      }
      if (spawnError !== null) {
        const notFound = spawnError.code === 'ENOENT'
        settle({
          ok: false,
          error: notFound
            ? `${file} was not found — install Claude Code (npm i -g @anthropic-ai/claude-code) or set the plugin's cliPath config`
            : `failed to run ${file}: ${spawnError.message}`,
          failure: notFound ? 'not-found' : 'spawn',
          meta,
        })
        return
      }
      if (exitCode !== 0) {
        settle({
          ok: false,
          error: `claude CLI exited with ${exitSignal !== null ? `signal ${exitSignal}` : `code ${exitCode}`}${stderrExcerpt(stderr)}`,
          failure: 'cli-run',
          meta,
        })
        return
      }
      if (overflowed) {
        settle({
          ok: false,
          error: `claude CLI wrote more than ${maxCaptureBytes} bytes to stdout; the result was discarded`,
          failure: 'output-overflow',
          meta,
        })
        return
      }
      if (parsed.result === null) {
        // Non-JSON stdout with exit 0 should not happen with --output-format
        // json; degrade to raw text rather than losing the run.
        if (stdout.trim().length > 0) {
          settle({ ok: true, answer: stdout.trim(), meta: { ...meta, rawOutput: true } })
        } else {
          settle({ ok: false, error: `claude CLI produced no output${stderrExcerpt(stderr)}`, failure: 'no-output', meta })
        }
        return
      }
      if (parsed.result.isError) {
        settle({
          ok: false,
          error: `claude CLI reported an error run: ${parsed.result.answer}${stderrExcerpt(stderr)}`,
          failure: 'cli-error',
          meta,
        })
        return
      }
      settle({ ok: true, answer: parsed.result.answer, meta })
    }

    child.on('error', (error) => {
      spawnError = error
      // A process that never started cannot outlive us, so this is the one
      // case where settling without `close` is safe — and `close` is not
      // guaranteed for a failed spawn on every platform.
      if (child.pid === undefined) finish()
    })
    child.on('close', (code, closeSignal) => {
      exitCode = code
      exitSignal = closeSignal
      emitProgress?.({ type: 'exit', code, signal: closeSignal })
      finish()
    })

    child.stdin.on('error', () => { /* EPIPE when the CLI dies early; close handler reports the failure */ })
    child.stdin.end(userMessage)
  })
}

/** Cancellation before anything was spawned. */
function abortedResult(meta) {
  return {
    ok: false,
    error: 'consultation was cancelled before it started',
    failure: 'aborted',
    meta: { ...meta, aborted: true },
  }
}

/**
 * Parse the CLI's `--output-format json` document without trusting it.
 * @returns {{ result: { answer: string, isError: boolean } | null, meta: object }}
 */
function parseResultJson(stdout) {
  const text = stdout.trim()
  if (text.length === 0) return { result: null, meta: {} }
  // The CLI prints exactly one JSON object for this format, but skip any
  // leading non-JSON noise lines defensively rather than failing the run.
  const start = text.indexOf('{')
  const candidate = start > 0 ? text.slice(start) : text
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return { result: null, meta: {} }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { result: null, meta: {} }

  const answer = typeof parsed.result === 'string' ? parsed.result : ''
  const isError = parsed.is_error === true || (typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error'))
  const meta = {}
  if (typeof parsed.subtype === 'string') meta.subtype = parsed.subtype
  if (typeof parsed.session_id === 'string') meta.sessionId = parsed.session_id
  if (Number.isFinite(parsed.num_turns)) meta.numTurns = parsed.num_turns
  if (Number.isFinite(parsed.duration_ms)) meta.durationMs = parsed.duration_ms
  if (Number.isFinite(parsed.total_cost_usd)) meta.costUsd = parsed.total_cost_usd
  if (typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
    meta.actualModel = parsed.model.trim()
    meta.actualModels = [meta.actualModel]
  } else if (parsed.modelUsage !== null && typeof parsed.modelUsage === 'object' && !Array.isArray(parsed.modelUsage)) {
    const entries = Object.entries(parsed.modelUsage)
    const actualModels = entries.map(([reported, usage]) => {
      const canonical = usage !== null && typeof usage === 'object' && typeof usage.canonicalModel === 'string'
        ? usage.canonicalModel.trim()
        : ''
      return canonical || reported.trim()
    }).filter((model) => model.length > 0)
    if (actualModels.length > 0) {
      meta.actualModels = [...new Set(actualModels)]
      if (meta.actualModels.length === 1) meta.actualModel = meta.actualModels[0]
    }
  }
  if (typeof parsed.effort === 'string' && EFFORT_LEVELS.has(parsed.effort)) meta.actualEffort = parsed.effort
  if (parsed.structured_output !== undefined) meta.structuredOutput = parsed.structured_output
  return { result: { answer, isError }, meta }
}

/** A short stderr tail for error surfaces, never the full firehose. */
function stderrExcerpt(stderr) {
  const text = stderr.trim()
  if (text.length === 0) return ''
  const tail = text.slice(-600)
  return `\nstderr: ${tail}`
}
