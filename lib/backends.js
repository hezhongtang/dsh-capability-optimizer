/**
 * Harness backend catalog for dsh-capability-optimizer.
 *
 * Single source of truth for which external CLI harnesses the settings UI
 * shows, in what order, and which of them actually have a runner today.
 * Phase 1 ships the Claude Code runner only; the rest are reserved
 * workspaces — the UI renders their tab with a planned-status page, and no
 * settings are read or written for them until a runner lands.
 *
 * Reserved entries intentionally carry no defaults: a future runner owns its
 * own settings shape when it arrives, and the settings file only ever
 * contains backends that exist here.
 */
export const ACTIVE_BACKEND = 'claude-code'

/**
 * @typedef {object} BackendSpec
 * @property {string} id        - settings key under `backends` and tab key.
 * @property {string} label     - display name (zh UI keeps Latin brand names).
 * @property {string} cli       - the CLI command the future runner will use.
 * @property {boolean} available - whether a runner exists in this release.
 * @property {string} note      - one-line status text shown in the workspace.
 */

/** @type {BackendSpec[]} */
export const BACKENDS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    cli: 'claude',
    available: true,
    note: 'Headless consultation live: roles, models, thinking effort, fallback.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    cli: 'codex',
    available: false,
    note: 'Reserved: exec / proto modes behind the same role roster.',
  },
  {
    id: 'zcode',
    label: 'ZCode',
    cli: 'zcode',
    available: false,
    note: 'Reserved: workspace pending the ZCode headless entry point.',
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code',
    cli: 'kimicode',
    available: false,
    note: 'Reserved: workspace pending the Kimi Code CLI.',
  },
  {
    id: 'pi',
    label: 'Pi',
    cli: 'pi',
    available: false,
    note: 'Reserved: Pi agent-core sessions as a consultation backend.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    cli: 'opencode',
    available: false,
    note: 'Reserved: OpenCode run/agent modes behind the same tools.',
  },
  {
    id: 'omp',
    label: 'OMP',
    cli: 'omp',
    available: false,
    note: 'Reserved: Oh My Pi advisor roster interop.',
  },
]

/** Catalog safe to send to the client (no behavior, pure metadata). */
export function backendCatalog() {
  return BACKENDS.map(({ id, label, cli, available, note }) => ({ id, label, cli, available, note }))
}

/** Whether an id is a known backend. */
export function isKnownBackend(id) {
  return typeof id === 'string' && BACKENDS.some((b) => b.id === id)
}
