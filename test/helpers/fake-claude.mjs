#!/usr/bin/env node
/**
 * Stub `claude` CLI for the contract tests.
 *
 * It emulates `claude -p --output-format json` closely enough to exercise the
 * runner's argument construction, JSON parsing, timeout, abort and failure
 * classification paths without touching a real subscription.
 *
 * Env knobs (all optional):
 *   FAKE_CLAUDE_MODE      ok | error | garbage | empty | nonzero | hang | flood
 *   FAKE_CLAUDE_ANSWER    the `result` string for mode=ok        (default 'PONG')
 *   FAKE_CLAUDE_DELAY_MS  sleep before writing anything          (default 0)
 *   FAKE_CLAUDE_EXIT      exit code for mode=nonzero             (default 1)
 *   FAKE_CLAUDE_STDERR    text written to stderr before exiting
 *   FAKE_CLAUDE_RECORD    path to write { argv, stdin, pid, env } as JSON
 *   FAKE_CLAUDE_HELP      text printed for `--help` (feature-probe fixture)
 *
 * Modes:
 *   ok       one well-formed JSON result document, exit 0
 *   error    JSON document with is_error true, exit 0
 *   garbage  non-JSON text on stdout, exit 0
 *   empty    nothing on stdout, exit 0
 *   nonzero  stderr text + FAKE_CLAUDE_EXIT
 *   hang     never exits on its own; ignores SIGTERM so SIGKILL escalation is
 *            observable. Used for timeout and abort tests.
 *   flood    writes past any sane capture cap, then exits 0
 */
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(process.env.FAKE_CLAUDE_HELP ?? defaultHelp())
  process.exit(0)
}

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok'
const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0)
const record = process.env.FAKE_CLAUDE_RECORD ?? ''

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => { start() })
process.stdin.on('error', () => { start() })

function start() {
  if (record.length > 0) {
    try {
      writeFileSync(record, JSON.stringify({ argv, stdin, pid: process.pid }, null, 2))
    } catch { /* the test will notice the missing record */ }
  }
  if (mode === 'hang') {
    // Deliberately unkillable-by-SIGTERM so the runner's SIGKILL escalation is
    // exercised. Keep the loop alive with a long timer.
    process.on('SIGTERM', () => { /* swallow */ })
    setInterval(() => {}, 1 << 30)
    return
  }
  setTimeout(emit, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0)
}

function emit() {
  const stderr = process.env.FAKE_CLAUDE_STDERR ?? ''
  if (stderr.length > 0) process.stderr.write(stderr)

  switch (mode) {
    case 'error':
      process.stdout.write(JSON.stringify(doc({
        is_error: true,
        subtype: 'error_during_execution',
        result: process.env.FAKE_CLAUDE_ANSWER ?? 'model not supported',
      })))
      process.exit(0)
      break
    case 'garbage':
      process.stdout.write('not json at all\n')
      process.exit(0)
      break
    case 'empty':
      process.exit(0)
      break
    case 'nonzero':
      process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 1))
      break
    case 'flood': {
      // Must respect backpressure: process.exit() truncates pending pipe
      // writes, so a naive write loop delivers one pipe buffer (64 KiB) and
      // no consumer can ever reach a multi-MiB capture cap. Drain, then let
      // the process end on its own once stdout has flushed.
      const block = 'x'.repeat(1024 * 1024)
      const total = Number(process.env.FAKE_CLAUDE_FLOOD_MIB ?? 12)
      let sent = 0
      const pump = () => {
        while (sent < total) {
          sent += 1
          if (!process.stdout.write(block)) {
            process.stdout.once('drain', pump)
            return
          }
        }
        process.exitCode = 0
      }
      pump()
      break
    }
    default:
      process.stdout.write(JSON.stringify(doc({
        is_error: false,
        subtype: 'success',
        result: process.env.FAKE_CLAUDE_ANSWER ?? 'PONG',
      })))
      process.exit(0)
  }
}

function doc(overrides) {
  const out = {
    type: 'result',
    session_id: 'fake-session-0001',
    num_turns: 2,
    duration_ms: 1234,
    total_cost_usd: 0.0042,
    ...overrides,
  }
  const structured = process.env.FAKE_CLAUDE_STRUCTURED
  if (structured !== undefined && structured.length > 0 && out.structured_output === undefined) {
    try {
      out.structured_output = JSON.parse(structured)
    } catch {
      out.structured_output = structured
    }
  }
  return out
}

// Function declaration, not a const: the `--help` branch above runs before
// this point in the module body.
function defaultHelp() {
  return `Usage: claude [options] [command] [prompt]

Options:
  -p, --print                     Print response and exit
  --output-format <format>        Output format (text, json, stream-json)
  --json-schema <schema>          Validate output against a JSON schema
  --append-system-prompt <text>   Append to the system prompt
  --model <model>                 Model for the session
  --effort <level>                Thinking effort (low, medium, high, xhigh, max)
  --max-turns <n>                 Limit agentic turns
  --max-budget-usd <n>            Stop once the run costs more than this
  --no-session-persistence        Do not persist the session (--print only)
  --tools <tools...>              Specify the list of available tools from the
                                  built-in set
  --setting-sources <sources>     Comma-separated list of setting sources to load
                                  (user, project, local)
  --strict-mcp-config             Only use MCP servers from --mcp-config,
                                  ignoring all other MCP configurations
  --allowedTools, --allowed-tools <tools...>
                                  Tools allowed without prompting
  --disallowedTools, --disallowed-tools <tools...>
                                  Tools denied
  --permission-mode <mode>        Permission mode to use for the session
                                  (choices: "acceptEdits", "auto",
                                  "bypassPermissions", "manual", "dontAsk",
                                  "plan")
  --dangerously-skip-permissions  Bypass all permission checks
  -h, --help                      Display help
`
}
