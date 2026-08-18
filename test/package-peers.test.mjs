/**
 * awesome-dsh-plugin review reads peer ranges. A range without an explicit
 * prerelease comparator on the current harness tuple silently excludes
 * 0.1.0-rc.* (node-semver), which is what the list's contributing.md flags.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './helpers/harness.mjs'

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

test('dsh-tools peer range includes an explicit 0.1.0-rc branch', () => {
  assert.match(pkg.peerDependencies['@deepseek-ai/dsh-tools'], />=0\.1\.0-rc\./)
})

test('cordis peer range includes an explicit 4.1.0-rc branch', () => {
  assert.match(pkg.peerDependencies['@deepseek-ai/cordis'], />=4\.1\.0-rc\./)
})

test('the published package still declares a dsh.bundle patch', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})
