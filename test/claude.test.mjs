/**
 * Contract tests for the headless runner.
 *
 * Two properties matter more than the individual assertions:
 *   1. the promise settles once, and only after the child process is gone —
 *      a caller that has been told "done" is never racing a live `claude`;
 *   2. cancellation, timeout and CLI failure stay three distinguishable
 *      outcomes, because the layers above route on `failure`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listenerCount } from 'node:events'
import { runClaudeConsult, resetCliCapabilities, probeCliCapabilities } from '../lib/claude.js'
import { fakeClaudePath, withRecord, withEnv, isAlive, waitFor } from './helpers/harness.mjs'

/** Short enough that a SIGTERM-ignoring stub still dies inside a test. */
const GRACE_MS = 150

/** Baseline options; every test overrides what it cares about. */
function consultOptions(overrides = {}) {
  return {
    userMessage: 'PING',
    systemPrompt: 'You are a test persona.',
    timeoutMs: 10000,
    killGraceMs: GRACE_MS,
    config: { cliPath: fakeClaudePath },
    ...overrides,
  }
}

/** Each test gets a fresh capability probe so a stubbed --help is honoured. */
function freshProbe() {
  resetCliCapabilities()
}

test('a successful run returns the answer and the CLI metadata', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_ANSWER: 'the reference answer' }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  assert.equal(value.answer, 'the reference answer')
  assert.equal(value.meta.sessionId, 'fake-session-0001')
  assert.equal(value.meta.numTurns, 2)
  assert.equal(value.meta.costUsd, 0.0042)
  assert.equal(record.stdin, 'PING')
  assert.deepEqual(record.argv.slice(0, 5), [
    '-p', '--output-format', 'json', '--append-system-prompt', 'You are a test persona.',
  ])
})

/**
 * The read-only tool restriction on the real CLI is `--tools <tools...>`. The
 * stub's built-in help fixture predates that flag and only advertises
 * `--allowedTools` / `--disallowedTools`, so the "modern CLI" path is driven
 * from a fixture that mirrors what `claude --help` actually prints today.
 */
const MODERN_HELP = `Usage: claude [options] [command] [prompt]

Options:
  -p, --print                     Print response and exit
  --output-format <format>        Output format (text, json, stream-json)
  --append-system-prompt <prompt> Append a system prompt
  --model <model>                 Model for the current session
  --effort <level>                Effort level for the current session
  --max-turns <n>                 Limit agentic turns
  --max-budget-usd <amount>       Maximum dollar amount to spend
  --no-session-persistence        Disable session persistence
  --allowedTools, --allowed-tools <tools...>   Tools allowed without prompting
  --disallowedTools, --disallowed-tools <tools...>  Tools denied
  --tools <tools...>              Specify the list of available tools
  --setting-sources <sources>     Comma-separated list of setting sources to load (user, project, local)
  --strict-mcp-config             Only use MCP servers from --mcp-config,
                                  ignoring all other MCP configurations
  --permission-mode <mode>        Permission mode to use for the session
                                  (choices: "acceptEdits", "auto",
                                  "bypassPermissions", "manual", "dontAsk",
                                  "plan")
  --json-schema <schema>          Validate output against a JSON schema
  -h, --help                      Display help for command
`

test('safe defaults are applied when the installed CLI advertises them', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: MODERN_HELP }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  const tools = record.argv.indexOf('--tools')
  assert.notEqual(tools, -1, 'read-only tool restriction should be passed')
  assert.equal(record.argv[tools + 1], 'Read,Grep,Glob')
  assert.ok(record.argv.includes('--no-session-persistence'))
  assert.equal(value.meta.tools, 'Read,Grep,Glob')
})

test('a flag is skipped per-flag, not all-or-nothing', async () => {
  freshProbe()
  // A CLI old enough to have --no-session-persistence but not --tools: the
  // supported flag must still be applied rather than the whole set dropped.
  const partialHelp = `Options:
  -p, --print                 Print response and exit
  --output-format <format>    Output format
  --no-session-persistence    Disable session persistence
  -h, --help                  Display help
`
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: partialHelp }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  assert.ok(!record.argv.includes('--tools'), 'an unadvertised flag must not be passed')
  assert.ok(record.argv.includes('--no-session-persistence'), 'an advertised flag must still be passed')
  assert.equal(value.meta.tools, undefined)
})

test("the stub's default help matches the installed CLI's flag surface", async () => {
  freshProbe()
  // Guards the fixture itself: if the stub stops advertising a flag the real
  // CLI has, every "safe defaults are applied" assertion silently goes vacuous.
  const capabilities = await probeCliCapabilities(fakeClaudePath)
  assert.deepEqual(capabilities, {
    tools: true,
    noSessionPersistence: true,
    maxBudgetUsd: true,
    settingSources: true,
    jsonSchema: true,
    strictMcpConfig: true,
    permissionModes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
    probed: true,
  })
})

/**
 * `--tools` restricts the *built-in* set only. Empirically (CLI 2.1.233) a
 * consultation launched with `--tools Read,Grep,Glob` still receives every
 * MCP tool the user's own config contributes — browser automation, desktop
 * control, arbitrary network fetches — because MCP tools are not built-ins.
 * `--strict-mcp-config` with no `--mcp-config` is what actually empties that
 * surface; see docs/plan/s1-consultant-permission-surface.md.
 */
test('an advertised --strict-mcp-config is passed: --tools alone does not bound MCP tools', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: MODERN_HELP }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  assert.ok(record.argv.includes('--strict-mcp-config'),
    'a CLI that advertises --strict-mcp-config must receive it, or the consultant keeps the user MCP tool surface')
  assert.ok(!record.argv.includes('--mcp-config'), 'no MCP server may be re-added by us')
  assert.equal(value.meta.strictMcp, true)
})

/**
 * A settings file can set `permissions.defaultMode`. Unlike `permissions.allow`
 * that is NOT gated by workspace trust, so an untrusted project can still put
 * the consultant into `bypassPermissions` and get real shell execution. The
 * flag beats every settings source, including `--settings`, so it is the only
 * lever that does not depend on which sources are loaded.
 */
test('an advertised --permission-mode is pinned so a settings file cannot escalate the consultant', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: MODERN_HELP }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  const flag = record.argv.indexOf('--permission-mode')
  assert.notEqual(flag, -1, 'a CLI that advertises --permission-mode must receive it')
  assert.equal(record.argv[flag + 1], 'manual')
  assert.equal(value.meta.permissionMode, 'manual')
})

test('the pinned permission mode is only ever a mode the installed CLI advertises', async () => {
  freshProbe()
  // An older CLI whose vocabulary is `default`, not `manual`. Passing a value
  // outside the advertised choices would fail the whole invocation.
  const legacyHelp = `Options:
  -p, --print                 Print response and exit
  --output-format <format>    Output format
  --permission-mode <mode>    Permission mode to use for the session (choices:
                              "acceptEdits", "bypassPermissions", "default", "plan")
  -h, --help                  Display help
`
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: legacyHelp }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  const flag = record.argv.indexOf('--permission-mode')
  assert.notEqual(flag, -1)
  assert.equal(record.argv[flag + 1], 'default')
})

test('a --permission-mode with no advertised choices is skipped rather than guessed', async () => {
  freshProbe()
  // The flag exists but its vocabulary is unknown. Guessing a value risks
  // failing the whole run, which turns a hardening step into an outage.
  const opaqueHelp = `Options:
  -p, --print               Print response and exit
  --output-format <format>  Output format
  --permission-mode <mode>  Permission mode
  -h, --help                Display help
`
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: opaqueHelp }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  assert.ok(!record.argv.includes('--permission-mode'))
  assert.equal(value.meta.permissionMode, undefined)
})

test('a CLI advertising neither hardening flag still runs, and says so in meta', async () => {
  freshProbe()
  const oldHelp = `Options:
  -p, --print               Print response and exit
  --output-format <format>  Output format
  -h, --help                Display help
`
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: oldHelp }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true, 'an old CLI must still produce an answer')
  assert.ok(!record.argv.includes('--strict-mcp-config'))
  assert.ok(!record.argv.includes('--permission-mode'))
  assert.equal(value.meta.strictMcp, undefined)
  assert.equal(value.meta.permissionMode, undefined)
})

test('the tool probe is not fooled by --allowedTools / --disallowed-tools', async () => {
  freshProbe()
  const help = 'Options:\n  --allowedTools, --allowed-tools <tools...>  x\n  --disallowed-tools <tools...>  y\n'
  const capabilities = await withEnv({ FAKE_CLAUDE_HELP: help }, () => probeCliCapabilities(fakeClaudePath))
  assert.equal(capabilities.tools, false)
})

test('safe defaults are skipped when the installed CLI does not advertise them', async () => {
  freshProbe()
  const oldHelp = `Usage: claude [options] [prompt]

Options:
  -p, --print               Print response and exit
  --output-format <format>  Output format
  --append-system-prompt <prompt>  Append a system prompt
  --model <model>           Model for the session
  -h, --help                Display help
`
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: oldHelp }, () =>
      runClaudeConsult(consultOptions({ maxBudgetUsd: 5 }))))

  assert.equal(value.ok, true, 'an old CLI must still produce an answer')
  assert.ok(!record.argv.includes('--tools'))
  assert.ok(!record.argv.includes('--no-session-persistence'))
  assert.ok(!record.argv.includes('--max-budget-usd'))
  assert.ok(!record.argv.includes('--setting-sources'))
  assert.equal(value.meta.tools, undefined)
})

test('an advertised --setting-sources flag loads user settings only, never project', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: MODERN_HELP }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  const flag = record.argv.indexOf('--setting-sources')
  assert.notEqual(flag, -1, 'a CLI that advertises --setting-sources must receive it')
  const sources = record.argv[flag + 1]
  assert.equal(typeof sources, 'string')
  assert.ok(!sources.split(',').map((part) => part.trim()).includes('project'),
    `source list must not load project permissions, got ${sources}`)
  assert.ok(!record.argv.includes('--settings'), 'must not pass a project settings file')
})

test('an unadvertised --setting-sources flag is skipped and the run still succeeds', async () => {
  freshProbe()
  const oldHelp = `Usage: claude [options] [prompt]

Options:
  -p, --print               Print response and exit
  --output-format <format>  Output format
  --append-system-prompt <prompt>  Append a system prompt
  --model <model>           Model for the session
  -h, --help                Display help
`
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: oldHelp }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true, 'an old CLI must still produce an answer')
  assert.ok(!record.argv.includes('--setting-sources'))
})

test('an advertised --json-schema flag is passed on the shipped runner', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: MODERN_HELP }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  const flag = record.argv.indexOf('--json-schema')
  assert.notEqual(flag, -1, 'a CLI that advertises --json-schema must receive it')
  const schema = JSON.parse(record.argv[flag + 1])
  assert.equal(schema.properties.verdict.enum.includes('revise'), true)
  assert.equal(schema.properties.verdict.enum.includes('pass'), true)
})

test('an unadvertised --json-schema flag is skipped and the run still succeeds', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_HELP: 'Options:\n  -p, --print\n  -h, --help\n' }, () =>
      runClaudeConsult(consultOptions())))

  assert.equal(value.ok, true)
  assert.ok(!record.argv.includes('--json-schema'))
})

test('the capability probe is cached per CLI path', async () => {
  freshProbe()
  const first = await withEnv({ FAKE_CLAUDE_HELP: MODERN_HELP }, () => probeCliCapabilities(fakeClaudePath))
  assert.equal(first.tools, true)
  assert.equal(first.noSessionPersistence, true)
  assert.equal(first.maxBudgetUsd, true)

  // A second call must reuse the cached answer even though the stub would now
  // report a CLI with none of those flags.
  const second = await withEnv({ FAKE_CLAUDE_HELP: 'Options:\n  -h, --help  Display help\n' }, () =>
    probeCliCapabilities(fakeClaudePath))
  assert.equal(second, first, 'the second call must reuse the cached probe')
})

test('typed settings reach argv and refused extraArgs never do', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok' }, () => runClaudeConsult(consultOptions({
      model: 'sonnet',
      effort: 'high',
      maxTurns: 3,
      maxBudgetUsd: 2.5,
      extraArgs: ['--dangerously-skip-permissions', '--output-format', 'text', '--add-dir', '/srv/extra'],
    }))))

  assert.equal(value.ok, true)
  assert.ok(!record.argv.includes('--dangerously-skip-permissions'))
  assert.equal(record.argv.filter((arg) => arg === '--output-format').length, 1)
  assert.equal(record.argv[record.argv.indexOf('--output-format') + 1], 'json')
  assert.ok(!record.argv.includes('text'))

  assert.equal(record.argv[record.argv.indexOf('--model') + 1], 'sonnet')
  assert.equal(record.argv[record.argv.indexOf('--effort') + 1], 'high')
  assert.equal(record.argv[record.argv.indexOf('--max-turns') + 1], '3')
  assert.equal(record.argv[record.argv.indexOf('--max-budget-usd') + 1], '2.5')
  assert.equal(record.argv[record.argv.indexOf('--add-dir') + 1], '/srv/extra')

  assert.deepEqual(value.meta.rejectedArgs.map((entry) => entry.arg), [
    '--dangerously-skip-permissions', '--output-format',
  ])
})

test('an already-aborted signal resolves without spawning anything', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'ok' }, () =>
      runClaudeConsult(consultOptions({ signal: AbortSignal.abort() }))))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'aborted')
  assert.equal(value.meta.aborted, true)
  assert.equal(record, null, 'no process should have been started')
})

test('aborting mid-run resolves as aborted and leaves no live child', async () => {
  freshProbe()
  const controller = new AbortController()
  const { value, record } = await withRecord(async () =>
    withEnv({ FAKE_CLAUDE_MODE: 'hang' }, async () => {
      const pending = runClaudeConsult(consultOptions({ signal: controller.signal, timeoutMs: 60000 }))
      setTimeout(() => controller.abort(), 250)
      return pending
    }))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'aborted')
  assert.equal(value.meta.aborted, true)
  assert.equal(value.meta.timedOut, undefined, 'abort must not be reported as a timeout')

  assert.ok(Number.isInteger(record.pid), 'the stub should have recorded its pid')
  assert.ok(await waitFor(() => !isAlive(record.pid)), `pid ${record.pid} survived the abort`)
})

test('a timeout is distinct from an abort and also kills the child', async () => {
  freshProbe()
  const { value, record } = await withRecord(() =>
    withEnv({ FAKE_CLAUDE_MODE: 'hang' }, () =>
      runClaudeConsult(consultOptions({ timeoutMs: 300 }))))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'timeout')
  assert.equal(value.meta.timedOut, true)
  assert.equal(value.meta.aborted, undefined)
  assert.match(value.error, /exceeded 300ms/)
  assert.ok(await waitFor(() => !isAlive(record.pid)), `pid ${record.pid} survived the timeout`)
})

test('an abort after the run has finished changes nothing', async () => {
  freshProbe()
  const controller = new AbortController()
  const value = await withEnv({ FAKE_CLAUDE_MODE: 'ok' }, () =>
    runClaudeConsult(consultOptions({ signal: controller.signal })))
  assert.equal(value.ok, true)
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(value.ok, true, 'the settled result must be immutable')
})

test('a long-lived signal does not accumulate abort listeners', async () => {
  freshProbe()
  const controller = new AbortController()
  await withEnv({ FAKE_CLAUDE_MODE: 'ok' }, async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await runClaudeConsult(consultOptions({ signal: controller.signal }))
      assert.equal(result.ok, true)
    }
  })
  assert.equal(listenerCount(controller.signal, 'abort'), 0, 'every consultation must remove its abort listener')
})

test('a non-zero exit is classified as cli-run', async () => {
  freshProbe()
  const value = await withEnv({
    FAKE_CLAUDE_MODE: 'nonzero', FAKE_CLAUDE_EXIT: '7', FAKE_CLAUDE_STDERR: 'boom: it failed',
  }, () => runClaudeConsult(consultOptions()))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'cli-run')
  assert.match(value.error, /code 7/)
  assert.match(value.error, /boom: it failed/)
})

test('an is_error document is classified as cli-error', async () => {
  freshProbe()
  const value = await withEnv({
    FAKE_CLAUDE_MODE: 'error', FAKE_CLAUDE_ANSWER: 'model not supported',
  }, () => runClaudeConsult(consultOptions()))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'cli-error')
  assert.match(value.error, /model not supported/)
  assert.equal(value.meta.subtype, 'error_during_execution')
})

test('unparseable stdout degrades to a raw answer rather than losing the run', async () => {
  freshProbe()
  const value = await withEnv({ FAKE_CLAUDE_MODE: 'garbage' }, () =>
    runClaudeConsult(consultOptions()))

  assert.equal(value.ok, true)
  assert.equal(value.answer, 'not json at all')
  assert.equal(value.meta.rawOutput, true)
})

test('empty stdout with a clean exit is no-output', async () => {
  freshProbe()
  const value = await withEnv({ FAKE_CLAUDE_MODE: 'empty' }, () =>
    runClaudeConsult(consultOptions()))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'no-output')
})

test('output past the capture cap is reported, not silently truncated', async () => {
  freshProbe()
  // Against the shipped 8 MiB cap, not a shrunken one: the stub's `flood` mode
  // respects backpressure and really delivers 12 MiB.
  const value = await withEnv({ FAKE_CLAUDE_MODE: 'flood' }, () =>
    runClaudeConsult(consultOptions()))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'output-overflow')
  assert.match(value.error, /more than 8388608 bytes/)
})

test('a missing CLI binary is classified as not-found', async () => {
  freshProbe()
  const value = await runClaudeConsult(consultOptions({
    config: { cliPath: '/nonexistent/dsh-capability-optimizer/claude' },
  }))

  assert.equal(value.ok, false)
  assert.equal(value.failure, 'not-found')
  assert.match(value.error, /was not found/)
})

test('the promise settles exactly once with one consistent shape', async () => {
  freshProbe()
  const controller = new AbortController()
  const settlements = []
  const pending = withEnv({ FAKE_CLAUDE_MODE: 'hang' }, () =>
    runClaudeConsult(consultOptions({ signal: controller.signal, timeoutMs: 400 })))
  pending.then((value) => settlements.push(value), (error) => settlements.push(error))

  // Fire both termination paths at once: abort races the wall-clock timeout.
  setTimeout(() => controller.abort(), 400)
  const value = await pending
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 4))

  assert.equal(settlements.length, 1)
  assert.equal(settlements[0], value)
  assert.equal(value.ok, false)
  assert.ok(['aborted', 'timeout'].includes(value.failure), `unexpected failure ${value.failure}`)
  assert.equal(typeof value.error, 'string')
  assert.equal(typeof value.meta, 'object')
})
