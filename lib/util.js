/**
 * Small host-side helpers shared across the plugin.
 */
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * The profiles root dsh manages (`$DSH_HOME/profiles`, default `~/.dsh/profiles`).
 * Used only to locate the harness's flat node_modules for the defineTool
 * fallback when this plugin is link:-installed outside a profile tree.
 */
export function profilesRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'profiles')
}

/** Directory name of a path (re-exported shape kept local for zero deps). */
export { dirname }
