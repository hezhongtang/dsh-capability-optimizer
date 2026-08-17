#!/usr/bin/env node
/**
 * §5.5 evaluation harness — compute-matched baseline for the consultant layer.
 *
 * Runs frozen review tasks with known seeded defects through the *shipped*
 * consultation path (`createConsultationService().consult`), scores the
 * findings against the seeds, and reports every quality number next to the
 * spend that bought it.
 *
 * The question this answers is the one the report cares about: does adding
 * *agents* beat giving *one* agent the same extra compute? So the arms are
 * built in matched pairs — a three-role panel against a single role with more
 * thinking effort — and the summary leads with recall per dollar.
 *
 * What this harness deliberately does NOT do: the report's arms 1 and 3
 * ("DSH alone", "lifecycle auto reviewer/designer") need DSH itself as the
 * manager under test, and DSH is not in this repo. Those stay unrun rather
 * than being faked with a stand-in manager. See eval/README.md.
 *
 * Usage:
 *   node eval/run.mjs --dry-run                 # exercise the plumbing, no quota
 *   node eval/run.mjs --model haiku --trials 2
 *   node eval/run.mjs --arms single-high,panel-3 --tasks session-cache
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createConsultationService } from '../lib/consultation.js'
import { defaultSettings, effectiveSettings } from '../lib/settings.js'
import { normalizeConfig } from '../lib/config.js'
import { ACTIVE_BACKEND } from '../lib/backends.js'
import { scoreFindings } from './lib/score.mjs'
import { aggregate } from './lib/aggregate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TASK_DIR = join(HERE, 'tasks')
const RESULT_DIR = join(HERE, 'results')

/**
 * Matched arms. `panel-3` spends roughly three consultations' worth of compute;
 * `single-high` / `single-xhigh` spend it on one consultation instead. Reading
 * `panel-3` against `single-low` would reproduce exactly the error §5.5 exists
 * to prevent.
 */
const ARMS = {
  'single-low': { roles: ['reviewer'], effort: 'low' },
  'single-high': { roles: ['reviewer'], effort: 'high' },
  'single-xhigh': { roles: ['reviewer'], effort: 'xhigh' },
  'panel-3': { roles: ['reviewer', 'advisor', 'designer'], effort: 'low' },
}

function parseArgs(argv) {
  const args = { model: 'haiku', trials: 2, arms: Object.keys(ARMS), tasks: null, dryRun: false, maxTurns: 6 }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--model') { args.model = value; index += 1 }
    else if (flag === '--trials') { args.trials = Number(value); index += 1 }
    else if (flag === '--max-turns') { args.maxTurns = Number(value); index += 1 }
    else if (flag === '--arms') { args.arms = value.split(',').map((name) => name.trim()); index += 1 }
    else if (flag === '--tasks') { args.tasks = value.split(',').map((name) => name.trim()); index += 1 }
    else throw new Error(`unknown flag ${flag}`)
  }
  const unknown = args.arms.filter((name) => ARMS[name] === undefined)
  if (unknown.length > 0) throw new Error(`unknown arm(s): ${unknown.join(', ')}`)
  if (!Number.isFinite(args.trials) || args.trials < 1) throw new Error('--trials must be >= 1')
  return args
}

function loadTasks(only) {
  const ids = readdirSync(TASK_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => only === null || only.includes(id))
    .sort()
  return ids.map((id) => {
    const dir = join(TASK_DIR, id)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    const artifacts = manifest.files
      .map((file) => `--- ${file} ---\n${readFileSync(join(dir, file), 'utf8')}`)
      .join('\n\n')
    return { ...manifest, dir, artifacts }
  })
}

/** Everything needed to tell later whether two runs are comparable at all. */
function provenance(model) {
  let cliVersion = 'unknown'
  try {
    cliVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()
  } catch { /* recorded as unknown */ }
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
  return {
    cliVersion,
    pluginVersion: pkg.version,
    model,
    node: process.version,
    platform: process.platform,
    startedAt: new Date().toISOString(),
  }
}

/** A stub runner returning one plausible structured answer, for --dry-run. */
function dryRunner(task) {
  return async () => ({
    ok: true,
    answer: 'dry run',
    meta: {
      costUsd: 0.01,
      durationMs: 500,
      numTurns: 2,
      structuredOutput: {
        verdict: 'revise',
        summary: 'dry run',
        findings: task.bugs.slice(0, 1).map((bug) => ({
          severity: 'high',
          confidence: 0.9,
          location: `${bug.file}:${bug.line}`,
          evidence: `seeded: ${bug.keywords[0]}`,
          impact: 'dry run',
          minimal_action: 'dry run',
        })),
        checked_scope: task.files,
        unknowns: [],
      },
    },
  })
}

function buildSettings({ model, maxTurns }) {
  const file = defaultSettings()
  Object.assign(file.backends[ACTIVE_BACKEND], {
    model,
    maxTurns,
    // No budget cap and no fallback: a silent model switch would break the pin.
    maxBudgetUsd: 0,
    fallbackModel: '',
    timeoutMs: 300000,
  })
  return effectiveSettings(normalizeConfig({}), file)
}

async function runTrial({ task, armName, arm, trial, args }) {
  const settings = buildSettings(args)
  const service = createConsultationService({
    settings,
    // No ledger: the per-session attempt cap is a product guardrail, not an
    // experimental variable. Capping trials here would silently truncate arms.
    ledger: null,
    env: { cwd: task.dir },
    ...(args.dryRun ? { runner: dryRunner(task) } : {}),
  })

  const started = Date.now()
  const results = await Promise.all(arm.roles.map((role) => service.consult({
    role,
    question: task.question,
    artifacts: task.artifacts,
    model: args.model,
    effort: arm.effort,
    // Unique per role AND per trial: a shared id would let the in-flight
    // fingerprint join two arms that are supposed to be independent samples.
    sessionId: `eval-${task.id}-${armName}-${trial}-${role}`,
    source: 'tool',
  })))

  const ok = results.some((result) => result.ok === true)
  const findings = results.flatMap((result) => result.envelope?.findings ?? [])
  const score = scoreFindings(findings, task.bugs)
  const costs = results.map((result) => result.meta?.costUsd).filter((value) => Number.isFinite(value))

  return {
    taskId: task.id,
    arm: armName,
    trial,
    ok,
    failure: ok ? null : (results.find((result) => result.ok !== true)?.failure ?? 'unknown'),
    roles: arm.roles,
    effort: arm.effort,
    recall: score.recall,
    seededPrecision: score.seededPrecision,
    foundIds: score.found.map((entry) => entry.bugId),
    missedIds: score.missed,
    findingCount: findings.length,
    // Kept verbatim: an unmatched finding may be a real defect we did not seed,
    // and only a human reading these can tell.
    unmatched: score.unmatched,
    envelopeStatus: results.map((result) => result.meta?.envelopeStatus ?? 'none'),
    costUsd: costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null,
    durationMs: Date.now() - started,
    containment: results[0]?.meta === undefined ? null : {
      tools: results[0].meta.tools ?? null,
      strictMcp: results[0].meta.strictMcp ?? false,
      permissionMode: results[0].meta.permissionMode ?? null,
    },
    errors: results.filter((result) => result.ok !== true).map((result) => result.error),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tasks = loadTasks(args.tasks)
  if (tasks.length === 0) throw new Error('no tasks matched')
  const meta = provenance(args.model)

  process.stderr.write(`${tasks.length} task(s) × ${args.arms.length} arm(s) × ${args.trials} trial(s)` +
    ` = ${tasks.length * args.arms.length * args.trials} trials, model ${args.model}` +
    `${args.dryRun ? ' [DRY RUN]' : ''}\n`)

  const rows = []
  for (const task of tasks) {
    for (const armName of args.arms) {
      for (let trial = 0; trial < args.trials; trial += 1) {
        const row = await runTrial({ task, armName, arm: ARMS[armName], trial, args })
        rows.push(row)
        process.stderr.write(
          `  ${task.id} ${armName} #${trial}: recall=${row.recall === null ? 'n/a' : row.recall.toFixed(2)}` +
          ` findings=${row.findingCount} envelope=${row.envelopeStatus.join(',')}` +
          ` cost=${row.costUsd === null ? 'n/a' : row.costUsd.toFixed(4)} ${Math.round(row.durationMs / 1000)}s\n`,
        )
      }
    }
  }

  const summary = aggregate(rows)
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true })
  const stamp = meta.startedAt.replace(/[:.]/g, '-')
  const name = `${stamp}-${args.model}${args.dryRun ? '-dryrun' : ''}`
  writeFileSync(join(RESULT_DIR, `${name}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(RESULT_DIR, `${name}.summary.json`), JSON.stringify({ meta, args, summary }, null, 2))

  process.stderr.write('\n')
  const envelopeOk = rows.flatMap((row) => row.envelopeStatus).filter((status) => status === 'ok').length
  const envelopeAll = rows.flatMap((row) => row.envelopeStatus).length
  process.stderr.write(`structured envelopes: ${envelopeOk}/${envelopeAll}\n`)
  if (envelopeOk < envelopeAll) {
    process.stderr.write('  WARNING: a degraded envelope yields zero findings, so recall below\n' +
      '  measures envelope reliability as much as review quality. Do not read these\n' +
      '  numbers as a quality result until this is 100%.\n')
  }
  console.log(JSON.stringify({ meta, summary }, null, 2))
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
