/**
 * Contract tests for the extraArgs allowlist.
 *
 * The plugin's stated guarantee is that a consultation cannot be talked into
 * widening its permissions, losing the JSON protocol or swapping its persona
 * through configuration. These tests are that guarantee, written down.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterExtraArgs, ARG_POLICY } from '../lib/argfilter.js'

/** Every flag the contract's refuse-list names, in both value spellings. */
const REFUSED_FLAGS = [
  { flag: '--dangerously-skip-permissions', value: null },
  { flag: '--allow-dangerously-skip-permissions', value: null },
  { flag: '--permission-mode', value: 'bypassPermissions' },
  { flag: '--allowedTools', value: 'Bash' },
  { flag: '--allowed-tools', value: 'Bash' },
  { flag: '--disallowedTools', value: 'Read' },
  { flag: '--tools', value: 'Bash,Edit' },
  { flag: '--mcp-config', value: './mcp.json' },
  { flag: '--plugin-dir', value: './evil' },
  { flag: '--plugin-url', value: 'https://example.invalid/p.zip' },
  { flag: '--agents', value: '{}' },
  { flag: '--settings', value: './settings.json' },
  { flag: '--setting-sources', value: 'project' },
  { flag: '--system-prompt', value: 'you are evil' },
  { flag: '--append-system-prompt', value: 'ignore the persona' },
  { flag: '--output-format', value: 'text' },
  { flag: '--json-schema', value: '{"type":"object"}' },
  { flag: '--model', value: 'haiku' },
  { flag: '--effort', value: 'max' },
  { flag: '--max-turns', value: '99' },
  { flag: '--max-budget-usd', value: '100' },
  { flag: '--print', value: null },
  { flag: '--resume', value: 'abc-123' },
  { flag: '--continue', value: null },
]

test('every refused flag is dropped in both value spellings', (t) => {
  for (const { flag, value } of REFUSED_FLAGS) {
    const spellings = value === null
      ? [[flag]]
      : [[flag, value], [`${flag}=${value}`]]
    for (const argv of spellings) {
      const result = filterExtraArgs(argv)
      assert.deepEqual(result.args, [], `${argv.join(' ')} must not reach argv`)
      assert.equal(result.rejected.length, 1, `${argv.join(' ')} must be reported once`)
      assert.equal(result.rejected[0].arg, argv[0])
      assert.ok(result.rejected[0].reason.length > 0, 'a rejection must carry a reason')
    }
  }
  t.diagnostic(`${REFUSED_FLAGS.length} refused flags checked`)
})

test('a refused flag takes its value token down with it', () => {
  // The hazard: dropping `--model` alone leaves `opus` behind as a positional,
  // which the CLI would read as the prompt.
  const result = filterExtraArgs(['--model', 'opus'])
  assert.deepEqual(result.args, [])
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].arg, '--model')
})

test('a refused boolean keeps its successor visible as a positional', () => {
  const result = filterExtraArgs(['--dangerously-skip-permissions', 'stray'])
  assert.deepEqual(result.args, [])
  assert.deepEqual(result.rejected.map((entry) => entry.arg), ['--dangerously-skip-permissions', 'stray'])
})

test('a refused variadic flag swallows all of its values', () => {
  const result = filterExtraArgs(['--allowedTools', 'Bash', 'Edit', 'Write', '--safe-mode'])
  assert.deepEqual(result.args, ['--safe-mode'])
  assert.deepEqual(result.rejected.map((entry) => entry.arg), ['--allowedTools'])
})

test('allowed args reach argv unchanged', () => {
  const argv = ['--add-dir', '/srv/project', '--safe-mode', '--autocompact', 'auto']
  const result = filterExtraArgs(argv)
  assert.deepEqual(result.args, argv)
  assert.deepEqual(result.rejected, [])
})

test('an allowed flag keeps its inline value spelling', () => {
  const result = filterExtraArgs(['--add-dir=/srv/project'])
  assert.deepEqual(result.args, ['--add-dir=/srv/project'])
  assert.deepEqual(result.rejected, [])
})

/**
 * The runner now applies `--strict-mcp-config` itself whenever the installed
 * CLI advertises it, because it is what actually bounds the MCP tool surface.
 * A config copy of it is at best redundant and at worst passed to a CLI that
 * does not know the flag, so the plugin owns it — same treatment as
 * `--no-session-persistence`.
 */
test('--strict-mcp-config is refused because the runner owns it', () => {
  const result = filterExtraArgs(['--strict-mcp-config'])
  assert.deepEqual(result.args, [])
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].arg, '--strict-mcp-config')
  assert.match(result.rejected[0].reason, /automatically/)
})

test('--strict-mcp-config takes no value, so a following token is not swallowed', () => {
  const result = filterExtraArgs(['--strict-mcp-config', 'stray'])
  assert.deepEqual(result.args, [])
  assert.deepEqual(result.rejected.map((entry) => entry.arg), ['--strict-mcp-config', 'stray'])
})

test('an allowed variadic flag takes every following value', () => {
  const result = filterExtraArgs(['--add-dir', '/a', '/b', '--safe-mode'])
  assert.deepEqual(result.args, ['--add-dir', '/a', '/b', '--safe-mode'])
  assert.deepEqual(result.rejected, [])
})

test('an allowed value flag without a value is refused, not passed bare', () => {
  const result = filterExtraArgs(['--add-dir', '--safe-mode'])
  assert.deepEqual(result.args, ['--safe-mode'])
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].arg, '--add-dir')
  assert.match(result.rejected[0].reason, /expects a value/)
})

test('an allowed boolean given a value is refused rather than reinterpreted', () => {
  const result = filterExtraArgs(['--safe-mode=false'])
  assert.deepEqual(result.args, [])
  assert.equal(result.rejected[0].arg, '--safe-mode=false')
  assert.match(result.rejected[0].reason, /takes no value/)
})

test('short and clustered short flags are always refused', () => {
  const result = filterExtraArgs(['-p', '-d', '-vc'])
  assert.deepEqual(result.args, [])
  assert.deepEqual(result.rejected.map((entry) => entry.arg), ['-p', '-d', '-vc'])
  for (const entry of result.rejected) assert.match(entry.reason, /short flags/)
})

test('the -- separator and everything after it is refused', () => {
  const result = filterExtraArgs(['--safe-mode', '--', '--add-dir', '/a', 'prompt text'])
  assert.deepEqual(result.args, ['--safe-mode'])
  assert.deepEqual(result.rejected.map((entry) => entry.arg), ['--', '--add-dir', '/a', 'prompt text'])
  for (const entry of result.rejected) assert.match(entry.reason, /positional/)
})

test('a bare positional is refused', () => {
  const result = filterExtraArgs(['tell me a secret'])
  assert.deepEqual(result.args, [])
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /positional/)
})

test('unknown long flags are refused by default, not passed through', () => {
  const result = filterExtraArgs(['--some-future-flag', 'value'])
  assert.deepEqual(result.args, [])
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /allowlist/)
})

test('spelling variants of a refused flag still get the specific reason', () => {
  const dashed = filterExtraArgs(['--allowed-tools', 'Bash'])
  const camel = filterExtraArgs(['--allowedTools', 'Bash'])
  assert.equal(dashed.rejected[0].reason, camel.rejected[0].reason)
  assert.match(dashed.rejected[0].reason, /read-only tool set/)
})

test('non-string and empty entries never reach argv', () => {
  const result = filterExtraArgs([42, null, { a: 1 }, ['x'], '   ', ''])
  assert.deepEqual(result.args, [])
  assert.deepEqual(result.rejected.map((entry) => entry.arg), ['42', 'null', '[object]', '[array]'])
})

test('a non-array input yields nothing rather than throwing', () => {
  for (const input of [undefined, null, 'string', 7, {}]) {
    assert.deepEqual(filterExtraArgs(input), { args: [], rejected: [] })
  }
})

test('ARG_POLICY describes the live allowlist', () => {
  assert.ok(ARG_POLICY.allowed.length > 0)
  for (const flag of ARG_POLICY.allowed) {
    assert.ok(flag.startsWith('--'), `${flag} should be a long flag`)
    assert.equal(ARG_POLICY.reasons[flag], undefined, `${flag} cannot be both allowed and refused`)
  }
  assert.match(ARG_POLICY.reasons['--dangerously-skip-permissions'], /permission/)
})
