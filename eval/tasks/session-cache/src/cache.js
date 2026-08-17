/**
 * Per-user session cache in front of the session store.
 * Added to cut p99 on the session lookup path.
 */
import { fetchSession } from './store.js'

const entries = new Map()
const inflight = new Map()

const TTL_MS = 5 * 60 * 1000

export async function getSession(userId) {
  const hit = entries.get(userId)
  if (hit !== undefined && Date.now() - hit.storedAt < TTL_MS) {
    return hit.session
  }

  const pending = inflight.get(userId)
  if (pending !== undefined) return pending

  const load = fetchSession(userId).then((session) => {
    entries.set(userId, { session, storedAt: Date.now() })
    inflight.delete(userId)
    return session
  })
  inflight.set(userId, load)
  return load
}

export function invalidate(userId) {
  entries.delete(userId)
}

export function warm(userIds) {
  for (const id of userIds) {
    getSession(id)
  }
}

export function stats() {
  return { size: entries.size, inflight: inflight.size }
}
