import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('formal eval rejects protocol drift before any consultation can start', () => {
  const run = spawnSync(process.execPath, [
    'eval/run.mjs', '--formal', '--model', 'claude-opus-5', '--trials', '1',
  ], { cwd: ROOT, encoding: 'utf8' })

  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /preregistered protocol/)
  assert.match(run.stderr, /--trials 5/)
})

test('formal eval rejects a missing option value without falling through to the CLI', () => {
  const run = spawnSync(process.execPath, ['eval/run.mjs', '--formal', '--model'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /--model requires a value/)
})
