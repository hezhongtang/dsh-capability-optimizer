/**
 * Roll trial rows up per arm, without laundering an unmeasurable into a score.
 *
 * §5.5 exists because a multi-agent arm that simply spends more tokens will
 * look better than a single-agent arm, and that difference is compute, not
 * architecture. So every quality number here ships next to the spend that
 * bought it, and `recallPerUsd` exists to make the matched comparison the easy
 * one to read.
 *
 * Three distinctions the arithmetic keeps:
 *  - `recall: null` (the task seeded nothing) is not `recall: 0`.
 *  - a failed consultation is not a measurement, so it does not move
 *    `recallMean` — but it does move `failureRate`, and
 *    `recallMeanCountingFailures` shows the product-level view where a
 *    consultation that never answered is simply a miss.
 *  - a missing `costUsd` is not free. Subscription runs may not report cost;
 *    counting that as 0 would make an arm look infinitely efficient.
 */

/** Mean of the finite numbers in `values`, or null when there are none. */
function mean(values) {
  const numbers = values.filter((value) => Number.isFinite(value))
  if (numbers.length === 0) return null
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
}

/** Sum, or null when nothing reported a number at all. */
function total(values) {
  const numbers = values.filter((value) => Number.isFinite(value))
  if (numbers.length === 0) return null
  return numbers.reduce((sum, value) => sum + value, 0)
}

/**
 * @param {Array<object>} trials - one row per (task, arm, trial) run.
 * @returns {{ arms: string[], byArm: Record<string, object>, trials: number }}
 */
export function aggregate(trials) {
  const rows = Array.isArray(trials) ? trials.filter((row) => row !== null && typeof row === 'object') : []
  /** @type {Record<string, object[]>} */
  const grouped = {}
  for (const row of rows) {
    const arm = typeof row.arm === 'string' ? row.arm : '(unnamed)'
    ;(grouped[arm] ??= []).push(row)
  }

  const byArm = {}
  for (const [arm, armRows] of Object.entries(grouped)) {
    const succeeded = armRows.filter((row) => row.ok !== false)
    const measurable = succeeded.filter((row) => Number.isFinite(row.recall))

    const failures = {}
    for (const row of armRows) {
      if (row.ok !== false) continue
      const kind = typeof row.failure === 'string' && row.failure.length > 0 ? row.failure : 'unknown'
      failures[kind] = (failures[kind] ?? 0) + 1
    }

    const recallMean = mean(measurable.map((row) => row.recall))
    const costUsdTotal = total(armRows.map((row) => row.costUsd))
    // Failures count as a miss here, but only where recall was measurable at
    // all — a task with nothing seeded still cannot score.
    const countingFailures = armRows
      .filter((row) => row.ok === false || Number.isFinite(row.recall))
      .map((row) => (row.ok === false ? 0 : row.recall))

    byArm[arm] = {
      trials: armRows.length,
      tasks: new Set(armRows.map((row) => row.taskId)).size,
      recallMean,
      recallN: measurable.length,
      recallMeanCountingFailures: mean(countingFailures),
      seededPrecisionMean: mean(succeeded.map((row) => row.seededPrecision)),
      findingCountMean: mean(succeeded.map((row) => row.findingCount)),
      failureRate: armRows.length === 0 ? null : (armRows.length - succeeded.length) / armRows.length,
      failures,
      costUsdTotal,
      costUsdMean: mean(armRows.map((row) => row.costUsd)),
      durationMsMean: mean(armRows.map((row) => row.durationMs)),
      // The number §5.5 is actually about: quality per unit of compute.
      recallPerUsd: recallMean === null || costUsdTotal === null || costUsdTotal === 0
        ? null
        : recallMean / (costUsdTotal / armRows.length),
    }
  }

  return { arms: Object.keys(byArm), byArm, trials: rows.length }
}
