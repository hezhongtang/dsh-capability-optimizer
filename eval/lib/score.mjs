/**
 * Deterministic scoring for the §5.5 evaluation harness.
 *
 * Given a consultant's findings and the defects a task deliberately seeds,
 * decide which seeded defects were identified. This is the one judgement the
 * whole evaluation rests on, so it is a fixed rule rather than a second model:
 * a model-judged score would make every number depend on an unmeasured
 * component, which is exactly the confound §5.5 exists to avoid.
 *
 * Two deliberate biases:
 *
 *  - **Conservative matching.** A finding must land in the right file, near the
 *    right line, *and* use the defect's vocabulary. Being too strict understates
 *    the plugin's value, which is the safe direction for an evaluation whose
 *    purpose is to stop us over-claiming.
 *  - **No false-positive verdicts.** A finding that matches no seeded defect is
 *    returned verbatim as `unmatched`, never counted as wrong. Seeded-bug
 *    evaluation cannot tell a hallucination from a real defect we did not think
 *    to seed; only a human reading `unmatched` can.
 */

/** How far a finding's line may sit from the seeded line and still match. */
export const DEFAULT_LINE_WINDOW = 8

/**
 * Pull a file and optional line out of a free-text `location`.
 * Models write `path:12`, `path:12-20`, a bare `path`, or prose around one.
 * @returns {{ file: string, line: number | null }}
 */
export function parseLocation(location) {
  const text = typeof location === 'string' ? location.trim() : ''
  if (text.length === 0) return { file: '', line: null }

  const colon = text.match(/^(\S+?):(\d+)/)
  if (colon !== null) return { file: colon[1], line: Number(colon[2]) }

  const prose = text.match(/^(\S+)\D+?(\d+)/)
  if (prose !== null) return { file: prose[1], line: Number(prose[2]) }

  const bare = text.match(/^(\S+)/)
  return { file: bare === null ? '' : bare[1], line: null }
}

/** Compare paths by basename: a consultant may report `cache.js` or `src/cache.js`. */
function samePath(a, b) {
  if (a.length === 0 || b.length === 0) return false
  if (a === b) return true
  const base = (path) => path.split('/').pop().toLowerCase()
  return base(a) === base(b)
}

/** `Line 21` is not a path; `cache.js`, `src/cache.js`, and Windows paths are. */
function recognizablePath(value) {
  return typeof value === 'string'
    && (/[\\/]/.test(value) || /\.[a-z0-9_-]+(?:$|[:#])/i.test(value))
}

/** All the prose a finding carries, lowercased, for vocabulary matching. */
function findingText(finding) {
  return [finding?.location, finding?.evidence, finding?.impact, finding?.minimal_action]
    .filter((part) => typeof part === 'string')
    .join(' ')
    .toLowerCase()
}

/** Does this finding identify this seeded defect? */
function matches(finding, bug, lineWindow, onlyFile) {
  const place = parseLocation(finding?.location)
  const file = !recognizablePath(place.file) && onlyFile !== null ? onlyFile : place.file
  if (!samePath(file, bug.file)) return false
  if (place.line !== null && Number.isFinite(bug.line) && Math.abs(place.line - bug.line) > lineWindow) return false

  const keywords = Array.isArray(bug.keywords) ? bug.keywords : []
  if (keywords.length === 0) return true
  const text = findingText(finding)
  return keywords.some((keyword) => typeof keyword === 'string' && keyword.length > 0
    && text.includes(keyword.toLowerCase()))
}

/**
 * Score one consultation against one task's seeded defects.
 *
 * @param {Array<object>} findings - envelope findings, as returned by the plugin.
 * @param {Array<{id: string, file: string, line?: number, keywords?: string[]}>} bugs
 * @param {{ lineWindow?: number, files?: string[] }} [options]
 * @returns {{
 *   found: Array<{ bugId: string, finding: object }>,
 *   missed: string[],
 *   unmatched: object[],
 *   recall: number | null,
 *   seededPrecision: number | null,
 * }}
 *   `recall` is null when the task seeds no defects; `seededPrecision` is null
 *   when the consultant returned no findings. Neither is reported as 0, because
 *   "undefined" and "scored zero" must not average together.
 */
export function scoreFindings(findings, bugs, options = {}) {
  const lineWindow = Number.isFinite(options.lineWindow) ? options.lineWindow : DEFAULT_LINE_WINDOW
  const list = Array.isArray(findings) ? findings.filter((entry) => entry !== null && typeof entry === 'object') : []
  const seeded = Array.isArray(bugs) ? bugs : []
  const taskFiles = Array.isArray(options.files)
    ? [...new Set(options.files.filter((file) => typeof file === 'string' && file.length > 0))]
    : [...new Set(seeded.map((bug) => bug?.file).filter((file) => typeof file === 'string' && file.length > 0))]
  const onlyFile = taskFiles.length === 1 ? taskFiles[0] : null

  const found = []
  const claimed = new Set()
  const takenBugs = new Set()

  // One finding satisfies at most one defect, and one defect is satisfied by at
  // most one finding: without both, a single vague finding that name-drops
  // every keyword would score full recall.
  for (const bug of seeded) {
    const hit = list.findIndex((entry, index) => !claimed.has(index) && matches(entry, bug, lineWindow, onlyFile))
    if (hit === -1) continue
    claimed.add(hit)
    takenBugs.add(bug.id)
    found.push({ bugId: bug.id, finding: list[hit] })
  }

  const unmatched = list.filter((_, index) => !claimed.has(index))

  return {
    found,
    missed: seeded.filter((bug) => !takenBugs.has(bug.id)).map((bug) => bug.id),
    unmatched,
    recall: seeded.length === 0 ? null : found.length / seeded.length,
    seededPrecision: list.length === 0 ? null : found.length / list.length,
  }
}
