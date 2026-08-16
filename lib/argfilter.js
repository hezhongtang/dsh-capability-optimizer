/**
 * Allowlist for user-configured extra CLI arguments.
 *
 * The plugin promises that a consultation never runs with widened permissions,
 * never loses the JSON result protocol and never has its role persona replaced.
 * `extraArgs` is the one place where user configuration reaches argv, so the
 * promise has to be enforced here rather than documented in a README: anything
 * not explicitly known to be harmless is dropped and reported.
 *
 * Refusal is not a run failure. A rejected flag is removed from argv and
 * recorded in `meta.rejectedArgs`, so a stale config keeps working while the
 * user is told exactly what was ignored and why.
 *
 * Token grammar handled here (it is argv, not a shell, so quoting is a
 * non-issue but token pairing is not):
 *   --flag              boolean long flag
 *   --flag value        value in the following token — dropped with the flag
 *   --flag=value        inline value
 *   -x / -abc           short and clustered short flags — never allowed
 *   --                  separator; everything after it would become a
 *                       positional prompt, which fights our stdin message
 */

/**
 * Flags a consultation may legitimately carry. Each one is either strictly
 * narrowing (it can only remove capability) or purely operational (it cannot
 * change the persona, the tool set, the permission surface or the output
 * protocol).
 *
 * arity: 'none' | 'one' | 'many' — how many value tokens the flag consumes.
 */
const ALLOWED = new Map([
  ['--add-dir', { arity: 'many' }],
  ['--autocompact', { arity: 'one' }],
  ['--disable-slash-commands', { arity: 'none' }],
  ['--exclude-dynamic-system-prompt-sections', { arity: 'none' }],
  ['--no-chrome', { arity: 'none' }],
  ['--safe-mode', { arity: 'none' }],
  ['--strict-mcp-config', { arity: 'none' }],
])

/** Why each explicitly-known flag is refused. Keyed by canonical spelling. */
const REFUSED = {
  '--dangerously-skip-permissions': 'bypasses every permission check',
  '--allow-dangerously-skip-permissions': 'bypasses every permission check',
  '--permission-mode': 'the plugin pins the consultation to print-mode permissions',
  '--allowedTools': 'the plugin owns the read-only tool set',
  '--disallowedTools': 'the plugin owns the read-only tool set',
  '--tools': 'the plugin owns the read-only tool set',
  '--chrome': 'starts a browser integration the runner cannot supervise',
  '--mcp-config': 'loads external capabilities into the consultation',
  '--plugin-dir': 'loads external code into the consultation',
  '--plugin-url': 'loads external code into the consultation',
  '--agents': 'redefines the agent the persona is written for',
  '--agent': 'redefines the agent the persona is written for',
  '--settings': 'a settings file can grant permissions the plugin refuses',
  '--setting-sources': 'a settings source can grant permissions the plugin refuses',
  '--system-prompt': 'would replace the role persona',
  '--append-system-prompt': 'the role persona owns this flag',
  '--system-prompt-file': 'would replace the role persona',
  '--append-system-prompt-file': 'the role persona owns this flag',
  '--output-format': 'breaks the JSON result protocol the runner parses',
  '--json-schema': 'breaks the JSON result protocol the runner parses',
  '--input-format': 'the runner always feeds the question as plain stdin',
  '--include-partial-messages': 'breaks the JSON result protocol the runner parses',
  '--include-hook-events': 'breaks the JSON result protocol the runner parses',
  '--replay-user-messages': 'breaks the JSON result protocol the runner parses',
  '--forward-subagent-text': 'breaks the JSON result protocol the runner parses',
  '--verbose': 'extra output can break the JSON result protocol',
  '--model': 'owned by the typed `model` setting',
  '--fallback-model': 'owned by the typed `fallbackModel` setting',
  '--effort': 'owned by the typed `effort` setting',
  '--max-turns': 'owned by the typed `maxTurns` setting',
  '--max-budget-usd': 'owned by the typed budget setting',
  '--print': 'the runner always runs in print mode',
  '--no-session-persistence': 'applied automatically when the installed CLI supports it',
  '--resume': 'a consultation is stateless; resuming leaks another session',
  '--continue': 'a consultation is stateless; resuming leaks another session',
  '--fork-session': 'a consultation is stateless; resuming leaks another session',
  '--session-id': 'the runner does not reuse session ids',
  '--from-pr': 'a consultation is stateless; resuming leaks another session',
  '--teleport': 'a consultation is stateless; resuming leaks another session',
  '--cloud': 'starts a session the runner cannot supervise or kill',
  '--background': 'starts a session the runner cannot supervise or kill',
  '--remote-control': 'starts a session the runner cannot supervise or kill',
  '--worktree': 'mutates the working tree of the project being consulted about',
  '--tmux': 'starts a session the runner cannot supervise or kill',
  '--ide': 'starts a session the runner cannot supervise or kill',
  '--bare': 'disables subscription auth, which this plugin depends on',
  '--betas': 'changes API behaviour in ways the result parser is not written for',
  '--file': 'downloads remote resources into the consultation',
  '--debug': 'debug output can break the JSON result protocol',
}

/** Refused flags that take no value, so a following bare token is not theirs. */
const REFUSED_BOOLEAN = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--include-partial-messages', '--include-hook-events', '--replay-user-messages',
  '--forward-subagent-text', '--verbose', '--print', '--no-session-persistence',
  '--continue', '--fork-session', '--ide', '--bare', '--chrome', '--brief',
  '--exclude-dynamic-system-prompt-sections',
].map(normalizeFlag))

/** Refused flags that swallow every following bare token. */
const REFUSED_VARIADIC = new Set([
  '--allowedTools', '--disallowedTools', '--tools', '--mcp-config', '--betas', '--file',
].map(normalizeFlag))

const REASON = {
  notAllowed: 'not on the consultation-safe allowlist',
  notString: 'extra args must be strings',
  positional: 'positional arguments are not accepted — the question is passed on stdin',
  shortFlag: 'short flags are ambiguous; use the long form',
  missingValue: 'expects a value',
  unexpectedValue: 'takes no value',
  emptyValue: 'has an empty value',
}

/** Index of the refusal table by normalized name, so spelling variants match. */
const REFUSED_BY_NAME = new Map(
  Object.entries(REFUSED).map(([flag, reason]) => [normalizeFlag(flag), reason]),
)

/**
 * Human-readable policy for UI / README / error surfaces.
 * @type {{ allowed: string[], reasons: Record<string, string> }}
 */
export const ARG_POLICY = {
  allowed: [...ALLOWED.keys()],
  reasons: { ...REFUSED },
}

/**
 * Gate every configured extra argument through the allowlist.
 *
 * @param {unknown} extraArgs - raw configured args (anything; non-arrays yield nothing).
 * @returns {{ args: string[], rejected: Array<{ arg: string, reason: string }> }}
 *   `args` is safe to append to argv verbatim. `rejected` carries one entry per
 *   refused flag, spelled as the user wrote it; a value token dropped alongside
 *   its flag does not get its own entry.
 */
export function filterExtraArgs(extraArgs) {
  /** @type {string[]} */
  const args = []
  /** @type {Array<{ arg: string, reason: string }>} */
  const rejected = []
  if (!Array.isArray(extraArgs)) return { args, rejected }

  let index = 0
  let afterSeparator = false
  while (index < extraArgs.length) {
    const raw = extraArgs[index]
    index += 1

    if (typeof raw !== 'string') {
      rejected.push({ arg: describe(raw), reason: REASON.notString })
      continue
    }
    const token = raw.trim()
    if (token.length === 0) continue

    if (afterSeparator || token === '--' || !token.startsWith('-')) {
      if (token === '--') afterSeparator = true
      rejected.push({ arg: token, reason: REASON.positional })
      continue
    }
    if (!token.startsWith('--')) {
      rejected.push({ arg: token, reason: REASON.shortFlag })
      continue
    }

    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    const inline = eq === -1 ? null : token.slice(eq + 1)
    const spec = ALLOWED.get(flag)

    if (spec === undefined) {
      // Drop the flag's presumed value with it, so a refused `--model opus`
      // cannot leave a bare `opus` behind to be read as the prompt.
      if (inline === null) index = skipRefusedValues(extraArgs, index, flag)
      rejected.push({ arg: token, reason: refusalReason(flag) })
      continue
    }

    if (spec.arity === 'none') {
      if (inline !== null) rejected.push({ arg: token, reason: `${flag} ${REASON.unexpectedValue}` })
      else args.push(flag)
      continue
    }

    if (inline !== null) {
      if (inline.length === 0) rejected.push({ arg: token, reason: `${flag} ${REASON.emptyValue}` })
      else args.push(token)
      continue
    }

    const values = []
    while (index < extraArgs.length && isValueToken(extraArgs[index])) {
      values.push(extraArgs[index].trim())
      index += 1
      if (spec.arity === 'one') break
    }
    if (values.length === 0) {
      rejected.push({ arg: token, reason: `${flag} ${REASON.missingValue}` })
      continue
    }
    args.push(flag, ...values)
  }

  return { args, rejected }
}

/** Why a flag is refused: a specific reason when we know it, else the default. */
function refusalReason(flag) {
  return REFUSED_BY_NAME.get(normalizeFlag(flag)) ?? REASON.notAllowed
}

/**
 * Advance past the value tokens belonging to a refused flag. Known booleans
 * keep their successor; everything else is assumed to take one value (variadic
 * refusals take all of them), which errs toward dropping too much.
 */
function skipRefusedValues(tokens, start, flag) {
  const name = normalizeFlag(flag)
  if (REFUSED_BOOLEAN.has(name)) return start
  const variadic = REFUSED_VARIADIC.has(name)
  let index = start
  while (index < tokens.length && isValueToken(tokens[index])) {
    index += 1
    if (!variadic) break
  }
  return index
}

/** A token that reads as a value rather than as the next flag. */
function isValueToken(token) {
  if (typeof token !== 'string') return false
  const trimmed = token.trim()
  return trimmed.length > 0 && !trimmed.startsWith('-')
}

/** Canonical comparison form: `--allowedTools`, `--allowed-tools` → `allowedtools`. */
function normalizeFlag(flag) {
  return flag.replace(/^-+/, '').replace(/-/g, '').toLowerCase()
}

/** A short printable form of a non-string entry, for the rejection report. */
function describe(value) {
  if (value === null) return 'null'
  if (typeof value === 'object') return Array.isArray(value) ? '[array]' : '[object]'
  return String(value)
}
