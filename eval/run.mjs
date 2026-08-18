#!/usr/bin/env node
/**
 * Controlled reviewer-prompt evaluation for the consultant layer.
 *
 * Runs frozen review tasks with known seeded defects through the *shipped*
 * consultation path (`createConsultationService().consult`), scores the
 * findings against the seeds, and reports every quality number next to the
 * spend that bought it.
 *
 * The primary comparison isolates the reviewer contract: a role-free minimal
 * task prompt, the 0.5.x prompt, and the current evidence-threshold prompt.
 * All three use one reviewer, the same task/model/effort/turn settings, and
 * role-appropriate structured output. Cost and prompt hashes stay beside the
 * outcome so token differences are visible rather than hand-waved away.
 *
 * What this harness deliberately does NOT do: the report's arms 1 and 3
 * ("DSH alone", "lifecycle auto reviewer/designer") need DSH itself as the
 * manager under test, and DSH is not in this repo. Those stay unrun rather
 * than being faked with a stand-in manager. See eval/README.md.
 *
 * Usage:
 *   node eval/run.mjs --dry-run                 # exercise the plumbing, no quota
 *   node eval/run.mjs --model haiku --trials 2
 *   node eval/run.mjs --formal --model claude-opus-5 --trials 5 --timeout-ms 1200000
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createConsultationService } from '../lib/consultation.js'
import { runClaudeConsult } from '../lib/claude.js'
import { defaultSettings, effectiveSettings } from '../lib/settings.js'
import { normalizeConfig } from '../lib/config.js'
import { ACTIVE_BACKEND } from '../lib/backends.js'
import { scoreFindings } from './lib/score.mjs'
import { aggregate } from './lib/aggregate.mjs'
import { assertFormalConsultantModel } from './lib/consultant-model.mjs'
import { compileReviewPromptVariant } from './lib/prompt-variants.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TASK_DIR = join(HERE, 'tasks')
const RESULT_DIR = join(HERE, 'results')

/** Prompt arms isolate the prompt; effort arms remain optional model-behavior smoke. */
const ARMS = {
  'prompt-minimal': { roles: ['reviewer'], effort: 'high', promptVariant: 'minimal' },
  'prompt-legacy': { roles: ['reviewer'], effort: 'high', promptVariant: 'legacy' },
  'prompt-current': { roles: ['reviewer'], effort: 'high', promptVariant: 'current' },
  'current-low': { roles: ['reviewer'], effort: 'low', promptVariant: 'current' },
  'current-xhigh': { roles: ['reviewer'], effort: 'xhigh', promptVariant: 'current' },
  'current-max': { roles: ['reviewer'], effort: 'max', promptVariant: 'current' },
}

/** Default directly answers the role-free / old / new prompt question. */
const DEFAULT_ARMS = ['prompt-minimal', 'prompt-legacy', 'prompt-current']
const FORMAL_PROTOCOL = Object.freeze({ trials: 5, maxTurns: 8, timeoutMs: 1200000 })
const FORMAL_TASK_HASHES = Object.freeze({
  'event-page': '38b964b026b8b17dd990318ff5484c49b258163823885cfc6bead979dd3e8363',
  'injection-boundary': '588ace933a21bf9dee4b1f03a3cdb49fcecc67c29e20cd3900071fd3541e18f0',
  'session-cache': '4beefaddc40d6e1d532ad5aae303a639589be15bc393d77e835b0863c871e7f7',
  'token-verify': 'a530e89329fa6590d318e676da20d949de0a2f7a6368035631bb71093b01ce77',
})

function parseArgs(argv) {
  const args = {
    model: 'haiku', trials: 2, arms: [...DEFAULT_ARMS], tasks: null,
    dryRun: false, formal: false, maxTurns: 6, timeoutMs: 300000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    const requiredValue = () => {
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`)
      }
      return value
    }
    if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--formal') args.formal = true
    else if (flag === '--model') { args.model = requiredValue(); index += 1 }
    else if (flag === '--trials') { args.trials = Number(requiredValue()); index += 1 }
    else if (flag === '--max-turns') { args.maxTurns = Number(requiredValue()); index += 1 }
    else if (flag === '--timeout-ms') { args.timeoutMs = Number(requiredValue()); index += 1 }
    else if (flag === '--arms') { args.arms = requiredValue().split(',').map((name) => name.trim()); index += 1 }
    else if (flag === '--tasks') { args.tasks = requiredValue().split(',').map((name) => name.trim()); index += 1 }
    else throw new Error(`unknown flag ${flag}`)
  }
  args.model = args.model.trim()
  if (args.model.length === 0) throw new Error('--model must be non-empty')
  const unknown = args.arms.filter((name) => ARMS[name] === undefined)
  if (unknown.length > 0) throw new Error(`unknown arm(s): ${unknown.join(', ')}`)
  if (new Set(args.arms).size !== args.arms.length) throw new Error('--arms must not contain duplicates')
  if (args.tasks !== null && new Set(args.tasks).size !== args.tasks.length) {
    throw new Error('--tasks must not contain duplicates')
  }
  if (!Number.isInteger(args.trials) || args.trials < 1) throw new Error('--trials must be an integer >= 1')
  if (!Number.isInteger(args.maxTurns) || args.maxTurns < 1) throw new Error('--max-turns must be an integer >= 1')
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 3600000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 3600000')
  }
  if (args.formal) {
    assertFormalConsultantModel(args.model, { dryRun: args.dryRun })
    if (!args.dryRun) {
      const deviations = []
      if (args.arms.join(',') !== DEFAULT_ARMS.join(',')) deviations.push(`--arms ${DEFAULT_ARMS.join(',')}`)
      if (args.tasks !== null) deviations.push('the complete task set (omit --tasks)')
      if (args.trials !== FORMAL_PROTOCOL.trials) deviations.push(`--trials ${FORMAL_PROTOCOL.trials}`)
      if (args.maxTurns !== FORMAL_PROTOCOL.maxTurns) deviations.push(`--max-turns ${FORMAL_PROTOCOL.maxTurns}`)
      if (args.timeoutMs !== FORMAL_PROTOCOL.timeoutMs) deviations.push(`--timeout-ms ${FORMAL_PROTOCOL.timeoutMs}`)
      if (deviations.length > 0) {
        throw new Error(`formal evaluation must use the preregistered protocol: ${deviations.join('; ')}`)
      }
    }
  }
  return args
}

function reportedModels(result) {
  const listed = Array.isArray(result?.meta?.actualModels)
    ? result.meta.actualModels.filter((model) => typeof model === 'string' && model.length > 0)
    : []
  if (listed.length > 0) return [...new Set(listed)]
  return typeof result?.meta?.actualModel === 'string' && result.meta.actualModel.length > 0
    ? [result.meta.actualModel]
    : []
}

function safeFileComponent(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'model'
}

function loadTasks(only) {
  const available = readdirSync(TASK_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  if (only !== null) {
    const missing = only.filter((id) => !available.includes(id))
    if (missing.length > 0) throw new Error(`unknown task(s): ${missing.join(', ')}`)
  }
  const ids = available
    .filter((id) => only === null || only.includes(id))
  return ids.map((id) => {
    const dir = join(TASK_DIR, id)
    const manifestSource = readFileSync(join(dir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestSource)
    const artifacts = manifest.files
      .map((file) => `--- ${file} ---\n${readFileSync(join(dir, file), 'utf8')}`)
      .join('\n\n')
    const taskHash = createHash('sha256').update(manifestSource).update('\u0000').update(artifacts).digest('hex')
    return { ...manifest, dir, artifacts, taskHash }
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

/** A stub runner returning one schema-compatible reviewer answer, for --dry-run. */
function dryRunner(task) {
  return async (options) => {
    const findingSchema = options.outputSchema?.properties?.findings?.items
    const needsConfidence = Array.isArray(findingSchema?.required) && findingSchema.required.includes('confidence')
    return {
      ok: true,
      answer: 'dry run',
      meta: {
        costUsd: 0.01,
        durationMs: 500,
        numTurns: 2,
        actualModel: options.model,
        structuredOutput: {
          verdict: 'revise',
          summary: 'dry run',
          findings: task.bugs.slice(0, 1).map((bug) => ({
            ...(needsConfidence ? { confidence: 0.9 } : {}),
            severity: 'high',
            location: `${bug.file}:${bug.line}`,
            evidence: `seeded: ${bug.keywords[0]}`,
            impact: 'dry run',
            minimal_action: 'dry run',
          })),
          checked_scope: task.files,
          unknowns: [],
        },
      },
    }
  }
}

function buildSettings({ model, maxTurns, timeoutMs }) {
  const file = defaultSettings()
  Object.assign(file.backends[ACTIVE_BACKEND], {
    model,
    maxTurns,
    // No budget cap and no fallback: a silent model switch would break the pin.
    maxBudgetUsd: 0,
    fallbackModel: '',
    timeoutMs,
  })
  return effectiveSettings(normalizeConfig({}), file)
}

async function runTrial({ task, armName, arm, trial, schedulePosition, args }) {
  const settings = buildSettings(args)
  const prompt = compileReviewPromptVariant(arm.promptVariant, task.dir)
  const baseRunner = args.dryRun ? dryRunner(task) : runClaudeConsult
  const runner = (options) => baseRunner({
    ...options,
    systemPrompt: prompt.systemPrompt,
    outputSchema: prompt.outputSchema,
  })
  const service = createConsultationService({
    settings,
    // No ledger: the per-session attempt cap is a product guardrail, not an
    // experimental variable. Capping trials here would silently truncate arms.
    ledger: null,
    env: { cwd: task.dir },
    runner,
  })

  const started = Date.now()
  const results = await Promise.all(arm.roles.map((role) => service.consult({
    role,
    question: task.question,
    objective: task.objective,
    successCriteria: task.successCriteria,
    constraints: task.constraints,
    artifacts: task.artifacts,
    model: args.model,
    effort: arm.effort,
    // Unique per role AND per trial: a shared id would let the in-flight
    // fingerprint join two arms that are supposed to be independent samples.
    sessionId: `eval-${task.id}-${armName}-${trial}-${role}`,
    source: 'tool',
  })))

  const actualModels = [...new Set(results.flatMap((result) => reportedModels(result)))]
  const formalModelOk = args.formal && !args.dryRun
    ? results.every((result) => {
      const actual = reportedModels(result)
      return actual.length === 1 && actual[0] === args.model
    })
    : null
  const modelFailure = formalModelOk === false
    ? `formal trial requested ${args.model}, but the CLI reported ${actualModels.length > 0 ? actualModels.join(', ') : '(no actual model)'}`
    : null
  const answered = results.some((result) => result.ok === true)
  const ok = answered && formalModelOk !== false
  const findings = results.flatMap((result) => result.envelope?.findings ?? [])
  const score = scoreFindings(findings, task.bugs, { files: task.files })
  const costs = results.map((result) => result.meta?.costUsd).filter((value) => Number.isFinite(value))
  const injection = task.injection !== null && typeof task.injection === 'object' ? task.injection : null
  const attackSucceeded = injection === null ? null : results.some((result) => (
    result.envelope?.verdict === injection.successVerdict
    && typeof result.envelope?.summary === 'string'
    && result.envelope.summary.includes(injection.successSummary)
  ))

  return {
    taskId: task.id,
    taskHash: task.taskHash,
    arm: armName,
    trial,
    schedulePosition,
    ok,
    failure: ok ? null : (modelFailure === null
      ? (results.find((result) => result.ok !== true)?.failure ?? 'unknown')
      : 'model-mismatch'),
    roles: arm.roles,
    effort: arm.effort,
    promptVariant: prompt.variant,
    promptHash: prompt.hash,
    promptChars: prompt.chars,
    recall: score.recall,
    seededPrecision: score.seededPrecision,
    foundIds: score.found.map((entry) => entry.bugId),
    missedIds: score.missed,
    findingCount: findings.length,
    attackSucceeded,
    // Kept verbatim: an unmatched finding may be a real defect we did not seed,
    // and only a human reading these can tell.
    unmatched: score.unmatched,
    envelopeStatus: results.map((result) => result.meta?.envelopeStatus ?? 'none'),
    effectiveModels: results.map((result) => result.meta?.effectiveModel ?? null),
    actualModels,
    formalModelOk,
    costUsd: costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null,
    durationMs: Date.now() - started,
    containment: results[0]?.meta === undefined ? null : {
      tools: results[0].meta.tools ?? null,
      safeMode: results[0].meta.safeMode ?? false,
      strictMcp: results[0].meta.strictMcp ?? false,
      permissionMode: results[0].meta.permissionMode ?? null,
    },
    errors: [
      ...results.filter((result) => result.ok !== true).map((result) => result.error),
      ...(modelFailure === null ? [] : [modelFailure]),
    ],
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tasks = loadTasks(args.tasks)
  if (tasks.length === 0) throw new Error('no tasks matched')
  if (args.formal && !args.dryRun) {
    const drift = tasks.filter((task) => FORMAL_TASK_HASHES[task.id] !== task.taskHash)
    if (drift.length > 0 || tasks.length !== Object.keys(FORMAL_TASK_HASHES).length) {
      const details = drift.map((task) => `${task.id}=${task.taskHash}`).join(', ')
      throw new Error(`formal task corpus differs from the preregistered hashes${details ? `: ${details}` : ''}`)
    }
  }
  const meta = { ...provenance(args.model), formal: args.formal }

  process.stderr.write(`${tasks.length} task(s) × ${args.arms.length} arm(s) × ${args.trials} trial(s)` +
    ` = ${tasks.length * args.arms.length * args.trials} trials, model ${args.model}` +
    `${args.formal ? ' [FORMAL]' : ''}${args.dryRun ? ' [DRY RUN]' : ''}\n`)

  const rows = []
  let formalAbort = null
  trials: for (const [taskIndex, task] of tasks.entries()) {
    for (let trial = 0; trial < args.trials; trial += 1) {
      // Deterministic Latin rotation distributes first-run schema compilation,
      // time-of-run, and quota-state effects across arms without introducing
      // an unrecorded random seed.
      const offset = (taskIndex + trial) % args.arms.length
      const scheduledArms = [...args.arms.slice(offset), ...args.arms.slice(0, offset)]
      for (const [schedulePosition, armName] of scheduledArms.entries()) {
        const row = await runTrial({
          task, armName, arm: ARMS[armName], trial, schedulePosition, args,
        })
        rows.push(row)
        process.stderr.write(
          `  ${task.id} ${armName} #${trial}: recall=${row.recall === null ? 'n/a' : row.recall.toFixed(2)}` +
          ` findings=${row.findingCount} envelope=${row.envelopeStatus.join(',')}` +
          ` cost=${row.costUsd === null ? 'n/a' : row.costUsd.toFixed(4)} ${Math.round(row.durationMs / 1000)}s\n`,
        )
        if (row.formalModelOk === false) {
          formalAbort = row.errors.at(-1) ?? 'formal model identity check failed'
          break trials
        }
      }
    }
  }

  const summary = aggregate(rows)
  if (formalAbort !== null) meta.formalAbort = formalAbort
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true })
  const stamp = meta.startedAt.replace(/[:.]/g, '-')
  const name = `${stamp}-${safeFileComponent(args.model)}${args.formal ? '-formal' : ''}${args.dryRun ? '-dryrun' : ''}`
  const rowsPath = join(RESULT_DIR, `${name}.jsonl`)
  const summaryPath = join(RESULT_DIR, `${name}.summary.json`)
  writeFileSync(rowsPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(summaryPath, JSON.stringify({ meta, args, summary }, null, 2))

  process.stderr.write('\n')
  const envelopeOk = rows.flatMap((row) => row.envelopeStatus).filter((status) => status === 'ok').length
  const envelopeAll = rows.flatMap((row) => row.envelopeStatus).length
  process.stderr.write(`structured envelopes: ${envelopeOk}/${envelopeAll}\n`)
  if (envelopeOk < envelopeAll) {
    process.stderr.write('  WARNING: a degraded envelope yields zero findings, so recall below\n' +
      '  measures envelope reliability as much as review quality. Do not read these\n' +
      '  numbers as a quality result until this is 100%.\n')
  }
  const injectionRows = rows.filter((row) => typeof row.attackSucceeded === 'boolean')
  if (injectionRows.length > 0) {
    const attacks = injectionRows.filter((row) => row.attackSucceeded).length
    process.stderr.write(`prompt-injection successes: ${attacks}/${injectionRows.length}\n`)
  }
  console.log(JSON.stringify({ meta, summary }, null, 2))
  if (formalAbort !== null) {
    throw new Error(`${formalAbort}; partial results were preserved in ${rowsPath} and ${summaryPath}`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
