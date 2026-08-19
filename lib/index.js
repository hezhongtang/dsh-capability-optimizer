/**
 * dsh-capability-optimizer host entry.
 *
 * Contributes, all optional so the bundle never blocks a profile boot:
 *  - three agent tools (consult_expert / consult_panel / consult_roles)
 *    when a `tools` service exists;
 *  - four HTTP routes for the web settings section when a `webServer`
 *    service exists, plus two for the composer toggle's session overrides;
 *  - the proactive-consultation runtime (autoconsult.js): a systemPrompt
 *    policy section and two lifecycle nudge anchors, driven by the composer
 *    toggle per session and by the config layer elsewhere.
 *
 * Settings resolve as row config ← settings file; a UI save hot-applies by
 * disposing and re-registering the tools under one lock, so role edits take
 * effect on the very next model step without a dsh restart. The auto-consult
 * policy is read live (never snapshotted), so config and toggle changes
 * apply to the next step of every session immediately.
 *
 * Nothing here publishes a service, so the row is safe loose in any profile.
 * Phase 1 speaks only to the Claude Code CLI; the role roster and runner are
 * abstracted so later phases can add zcode / codex backends behind the same
 * tools.
 */
import { normalizeConfig } from './config.js'
import { loadSettings, effectiveSettings, effectiveAutoConsult } from './settings.js'
import { createAutoConsultRuntime, wireAutoConsult } from './autoconsult.js'
import { createConsultationStatusStore } from './consultation-status.js'
import { createSerialApply } from './apply-queue.js'

export const name = 'dsh-capability-optimizer'

/**
 * @param {object} ctx - the plugin's Cordis context.
 * @param {unknown} rawConfig - the row config (untrusted).
 * @param {{ consultationStatus?: object }} [deps] - test seam only; the host
 *   always calls `apply(ctx, config)` and gets the real status store.
 */
export function apply(ctx, rawConfig, deps = {}) {
  const rowConfig = normalizeConfig(rawConfig)

  const disposers = []
  let disposed = false
  let toolsCtx = null
  let disposeTools = null
  // Cached settings-file view so route reads and re-registration agree even
  // when the file changes mid-flight; refreshed on every apply().
  let fileSettingsCache = null

  // Live roster view for the auto-consult policy. Recomputed whenever the
  // settings-file cache changes, so a role disabled in the UI stops being
  // promised on the next step without re-deriving settings on every assemble.
  let rosterCache = effectiveSettings(rowConfig, null).roles

  // Proactive-consultation runtime. getDefaults/getRoster read the live layers
  // (row config ← cached settings file), so saves and resets re-shape policy
  // and anchors on the very next step without any re-wiring here.
  const autoRuntime = createAutoConsultRuntime({
    getDefaults: () => effectiveAutoConsult(rowConfig, fileSettingsCache),
    getRoster: () => rosterCache,
  })

  // Live consultation dock status store: survives settings-save tool
  // re-registration so an in-flight card keeps updating across hot-apply.
  const consultationStatus = deps.consultationStatus ?? createConsultationStatusStore()

  /** Fresh settings-file read (missing file → null), updating the cache. */
  async function loadFileSettings() {
    const { settings, error } = await loadSettings()
    if (error !== null) ctx.logger?.warn(`[dsh-capability-optimizer] settings file unreadable: ${error}`)
    fileSettingsCache = settings
    rosterCache = effectiveSettings(rowConfig, settings).roles
    return settings
  }

  /**
   * (Re-)register the agent tools under the currently effective settings.
   * Overlapping saves wait for a follow-up run of the latest file instead of
   * returning `skipped` and leaving the agent on the previous snapshot.
   * @returns {Promise<'applied' | 'skipped'>} outcome for route reporting.
   */
  async function applyToolsOnce() {
    if (toolsCtx === null) return 'skipped'
    const previous = disposeTools
    try {
      const mod = await import('./tools.js')
      const settings = effectiveSettings(rowConfig, await loadFileSettings())
      // Same ledger the auto-consult policy reads, so a tool call and a
      // lifecycle nudge share one per-session attempt budget.
      const dispose = await mod.registerConsultTools(toolsCtx.tools, settings, ctx, {
        ledger: autoRuntime.ledger,
        status: consultationStatus,
      })
      if (dispose === null) {
        ctx.logger?.warn('[dsh-capability-optimizer] tools could not register for current settings')
        return 'skipped'
      }
      if (disposed) {
        dispose()
        return 'skipped'
      }
      disposeTools = dispose
      if (previous !== null && previous !== dispose) {
        try { previous() } catch { /* best effort */ }
      }
      ctx.logger?.info?.('[dsh-capability-optimizer] consultation tools registered')
      return 'applied'
    } catch (error) {
      ctx.logger?.warn(`[dsh-capability-optimizer] tool registration failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'skipped'
    }
  }

  const applyTools = createSerialApply(applyToolsOnce)

  // Policy must see the settings file before the first assemble, not only
  // after tools inject. The getters stay sync, so this is a race against
  // the first step, not against a later save.
  loadFileSettings()

  // Agent tools. Callback-form inject: fires when the tools service registers
  // (the Loader mounts entries concurrently, so a synchronous ctx.get at apply
  // time races and usually loses); never blocks this fiber when absent.
  const uninjectTools = ctx.inject(['tools'], (injected) => {
    toolsCtx = injected
    applyTools()
  })

  // Web settings routes — mount only when the profile composes a webServer.
  const uninjectRoutes = ctx.inject(['webServer'], (webCtx) => {
    import('./routes.js')
      .then((mod) => {
        if (disposed) return undefined
        const dispose = mod.mountOptimizerRoutes(webCtx, {
          rowConfig,
          loadFileSettings,
          apply: applyTools,
          autoRuntime,
          consultationStatus,
        })
        disposers.push(dispose)
        ctx.logger?.info?.('[dsh-capability-optimizer] settings routes mounted')
        return dispose
      })
      .then((dispose) => {
        // Race: disposed while the dynamic import was in flight.
        if (disposed && dispose !== undefined) dispose()
      })
      .catch((error) => {
        ctx.logger?.warn(`[dsh-capability-optimizer] routes unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  // Proactive consultation: policy section + event observers + nudge anchors.
  const disposeAutoConsult = wireAutoConsult(ctx, autoRuntime)

  // Dock status cleanup. Registered after wireAutoConsult so cancellation
  // starts before cards are dropped; the status store tolerates a late finish.
  disposers.push(ctx.on('session/disposed', (session) => {
    const sessionId = session?.id
    if (typeof sessionId === 'string') consultationStatus.drop(sessionId)
  }))

  return () => {
    disposed = true
    disposeAutoConsult()
    consultationStatus.dropAll()
    if (disposeTools !== null) {
      try { disposeTools() } catch { /* best effort */ }
    }
    for (const dispose of disposers) {
      try { dispose() } catch { /* best effort */ }
    }
    uninjectTools?.()
    uninjectRoutes?.()
  }
}
