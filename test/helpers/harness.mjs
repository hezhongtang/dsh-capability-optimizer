/**
 * Shared test helpers: locate the stub CLI and read back what it was invoked
 * with, so tests can assert on generated arguments and stdin.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Absolute path to the executable stub CLI. */
export const fakeClaudePath = join(here, 'fake-claude.mjs')

/** Repo root, for importing lib modules by absolute path when convenient. */
export const repoRoot = join(here, '..', '..')

/**
 * Run `fn` with a fresh record file the stub writes its argv/stdin into.
 * @template T
 * @param {(recordPath: string) => Promise<T>} fn
 * @returns {Promise<{ value: T, record: { argv: string[], stdin: string } | null }>}
 */
export async function withRecord(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dco-test-'))
  const recordPath = join(dir, 'record.json')
  const previous = process.env.FAKE_CLAUDE_RECORD
  process.env.FAKE_CLAUDE_RECORD = recordPath
  try {
    const value = await fn(recordPath)
    return { value, record: readRecord(recordPath) }
  } finally {
    if (previous === undefined) delete process.env.FAKE_CLAUDE_RECORD
    else process.env.FAKE_CLAUDE_RECORD = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Read a record file written by the stub; null when it never ran. */
export function readRecord(recordPath) {
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Set stub env knobs for the duration of `fn`, restoring them afterwards.
 * @param {Record<string, string | undefined>} vars
 */
export async function withEnv(vars, fn) {
  const previous = new Map()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Is a pid still alive? Used to assert no orphaned CLI process survives. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until `predicate()` is true or `timeoutMs` elapses. */
export async function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}
