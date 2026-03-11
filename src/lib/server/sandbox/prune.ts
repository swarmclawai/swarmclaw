import { stopBrowserBridgeForScope } from './browser-bridge'
import type { AgentSandboxConfig } from './session-runtime'
import { execDocker } from './docker'
import {
  readSandboxBrowserRegistry,
  readSandboxRegistry,
  removeSandboxBrowserRegistryEntry,
  removeSandboxRegistryEntry,
} from './registry'
import {
  DEFAULT_SANDBOX_PRUNE_IDLE_HOURS,
  DEFAULT_SANDBOX_PRUNE_MAX_AGE_DAYS,
} from './constants'

let lastPruneAtMs = 0

function getPruneConfig(config: AgentSandboxConfig | null | undefined): { idleHours: number; maxAgeDays: number } {
  return {
    idleHours: typeof config?.prune?.idleHours === 'number' ? Math.max(0, config.prune.idleHours) : DEFAULT_SANDBOX_PRUNE_IDLE_HOURS,
    maxAgeDays: typeof config?.prune?.maxAgeDays === 'number' ? Math.max(0, config.prune.maxAgeDays) : DEFAULT_SANDBOX_PRUNE_MAX_AGE_DAYS,
  }
}

function shouldPruneEntry(
  now: number,
  prune: { idleHours: number; maxAgeDays: number },
  entry: { createdAtMs: number; lastUsedAtMs: number },
): boolean {
  if (prune.idleHours === 0 && prune.maxAgeDays === 0) return false
  const idleMs = now - entry.lastUsedAtMs
  const ageMs = now - entry.createdAtMs
  return (
    (prune.idleHours > 0 && idleMs > prune.idleHours * 60 * 60 * 1000)
    || (prune.maxAgeDays > 0 && ageMs > prune.maxAgeDays * 24 * 60 * 60 * 1000)
  )
}

export async function maybePruneSandboxes(config: AgentSandboxConfig | null | undefined): Promise<void> {
  const now = Date.now()
  if (now - lastPruneAtMs < 5 * 60_000) return
  lastPruneAtMs = now

  const prune = getPruneConfig(config)
  const shellRegistry = await readSandboxRegistry()
  for (const entry of shellRegistry.entries) {
    if (!shouldPruneEntry(now, prune, entry)) continue
    await execDocker(['rm', '-f', entry.containerName], true)
    await removeSandboxRegistryEntry(entry.containerName)
  }

  const browserRegistry = await readSandboxBrowserRegistry()
  for (const entry of browserRegistry.entries) {
    if (!shouldPruneEntry(now, prune, entry)) continue
    await execDocker(['rm', '-f', entry.containerName], true)
    await removeSandboxBrowserRegistryEntry(entry.containerName)
    await stopBrowserBridgeForScope(entry.scopeKey).catch(() => undefined)
  }
}
