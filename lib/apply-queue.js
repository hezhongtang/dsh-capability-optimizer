/**
 * Serialize overlapping apply() calls.
 *
 * Settings save hot-applies by disposing and re-registering tools. A second
 * save that arrives while the first apply is in flight must wait for a
 * follow-up run of the latest file, not return `skipped` and leave the agent
 * on the previous snapshot.
 *
 * @param {() => (T | Promise<T>)} run
 * @returns {() => Promise<T>}
 * @template T
 */
export function createSerialApply(run) {
  let chain = Promise.resolve()
  return function apply() {
    const next = chain.then(() => run(), () => run())
    chain = next.then(() => undefined, () => undefined)
    return next
  }
}
