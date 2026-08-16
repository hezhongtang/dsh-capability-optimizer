/**
 * Headless Claude Code CLI runner for dsh-capability-optimizer.
 *
 * One consultation = one `claude -p` process: the user message goes in via
 * stdin (no argv quoting hazards, no length limits worth worrying about),
 * the role persona via `--append-system-prompt`, and the reply comes back as
 * one JSON document on stdout which we parse defensively. Tool use inside
 * the headless session keeps Claude Code's print-mode default: read-only
 * tools may run, anything requiring permission is auto-denied — we never
 * pass a permission-bypassing flag.
 */
import { spawn } from 'node:child_process'

/** Hard cap on captured stdout/stderr so a runaway CLI cannot exhaust host memory. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
/** Grace period between SIGTERM and SIGKILL when the timeout fires. */
const KILL_GRACE_MS = 5000
/** Legal `--effort` levels (the CLI's own enum for thinking effort). */
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

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
 * Run one headless consultation.
 *
 * @param {object} options
 * @param {string} options.userMessage - full stdin message (question + material).
 * @param {string} options.systemPrompt - role persona for `--append-system-prompt`.
 * @param {string} [options.model] - model alias (`opus`, `sonnet`, ...) or full id.
 * @param {string} [options.effort] - thinking-effort level (`low|medium|high|xhigh|max`).
 * @param {number} [options.maxTurns] - agentic turn cap inside the CLI.
 * @param {number} [options.timeoutMs] - wall-clock cap for the whole process.
 * @param {string} [options.cwd] - working directory (defaults to process cwd).
 * @param {string[]} [options.extraArgs] - raw extra CLI args from config.
 * @param {{ cliPath?: string }} [options.config] - plugin config (cliPath).
 * @returns {Promise<{ok: true, answer: string, meta: object} | {ok: false, error: string, meta: object}>}
 */
export function runClaudeConsult(options) {
  const {
    userMessage,
    systemPrompt,
    model,
    effort,
    maxTurns,
    timeoutMs = 300000,
    cwd,
    extraArgs,
    config,
  } = options

  const file = resolveClaudeCommand(config)
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', systemPrompt]
  if (typeof model === 'string' && model.trim().length > 0) args.push('--model', model.trim())
  if (typeof effort === 'string' && EFFORT_LEVELS.has(effort)) args.push('--effort', effort)
  if (Number.isFinite(maxTurns) && maxTurns > 0) args.push('--max-turns', String(Math.floor(maxTurns)))
  if (Array.isArray(extraArgs)) {
    for (const arg of extraArgs) if (typeof arg === 'string' && arg.length > 0) args.push(arg)
  }

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: `failed to start ${file}: ${error instanceof Error ? error.message : String(error)}`, meta: {} })
      return
    }

    const meta = {}
    let stdout = ''
    let stderr = ''
    let settled = false

    const capture = (current, chunk) =>
      current.length + chunk.length > MAX_CAPTURE_BYTES
        ? current
        : current + chunk

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk) })

    const timer = setTimeout(() => {
      if (settled) return
      meta.timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, KILL_GRACE_MS).unref()
    }, timeoutMs)
    timer.unref()

    const finish = (failure) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const parsed = parseResultJson(stdout)
      Object.assign(meta, parsed.meta)

      if (meta.timedOut) {
        resolve({ ok: false, error: `claude CLI exceeded ${timeoutMs}ms and was killed`, meta })
        return
      }
      if (failure !== undefined) {
        resolve({ ok: false, error: `${failure}${stderrExcerpt(stderr)}`, meta })
        return
      }
      if (parsed.result === null) {
        // Non-JSON stdout with exit 0 should not happen with --output-format
        // json; degrade to raw text rather than losing the run.
        if (stdout.trim().length > 0) {
          resolve({ ok: true, answer: stdout.trim(), meta: { ...meta, rawOutput: true } })
        } else {
          resolve({ ok: false, error: `claude CLI produced no output${stderrExcerpt(stderr)}`, meta })
        }
        return
      }
      if (parsed.result.isError) {
        resolve({ ok: false, error: `claude CLI reported an error run: ${parsed.result.answer}${stderrExcerpt(stderr)}`, meta })
        return
      }
      resolve({ ok: true, answer: parsed.result.answer, meta })
    }

    child.on('error', (error) => {
      const message = error.code === 'ENOENT'
        ? `${file} was not found — install Claude Code (npm i -g @anthropic-ai/claude-code) or set the plugin's cliPath config`
        : `failed to run ${file}: ${error.message}`
      finish(message)
    })
    child.on('close', (code, signal) => {
      if (code === 0) finish()
      else finish(`claude CLI exited with ${signal !== null ? `signal ${signal}` : `code ${code}`}`)
    })

    child.stdin.on('error', () => { /* EPIPE when the CLI dies early; close handler reports the failure */ })
    child.stdin.end(userMessage)
  })
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
  return { result: { answer, isError }, meta }
}

/** A short stderr tail for error surfaces, never the full firehose. */
function stderrExcerpt(stderr) {
  const text = stderr.trim()
  if (text.length === 0) return ''
  const tail = text.slice(-600)
  return `\nstderr: ${tail}`
}
