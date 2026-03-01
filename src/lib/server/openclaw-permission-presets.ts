import type { ExecApprovalConfig, PermissionPreset } from '@/types'
import { ensureGatewayConnected } from './openclaw-gateway'
import { setExecConfig, getExecConfig } from './openclaw-exec-config'

export interface PresetConfig {
  security: ExecApprovalConfig['security']
  askMode: ExecApprovalConfig['askMode']
  toolGroups: string[]
}

export const PRESET_CONFIGS: Record<PermissionPreset, PresetConfig> = {
  conservative: {
    security: 'deny',
    askMode: 'off',
    toolGroups: [],
  },
  collaborative: {
    security: 'allowlist',
    askMode: 'on-miss',
    toolGroups: ['group:web', 'group:fs'],
  },
  autonomous: {
    security: 'full',
    askMode: 'off',
    toolGroups: ['group:runtime', 'group:web', 'group:fs'],
  },
}

/** Derive which preset matches the current config, or 'custom' if none match */
export function resolvePresetFromConfig(config: ExecApprovalConfig): PermissionPreset | 'custom' {
  for (const [preset, pc] of Object.entries(PRESET_CONFIGS) as [PermissionPreset, PresetConfig][]) {
    if (config.security === pc.security && config.askMode === pc.askMode) {
      return preset
    }
  }
  return 'custom'
}

/** Apply a permission preset to an agent via gateway RPC */
export async function applyPreset(agentId: string, preset: PermissionPreset): Promise<void> {
  const pc = PRESET_CONFIGS[preset]
  if (!pc) throw new Error(`Unknown preset: ${preset}`)

  const gw = await ensureGatewayConnected()
  if (!gw) throw new Error('Gateway not connected')

  // Update exec approval config
  const snap = await getExecConfig(agentId)
  await setExecConfig(agentId, {
    security: pc.security,
    askMode: pc.askMode,
    patterns: pc.security === 'allowlist' ? snap.file.patterns : [],
  }, snap.hash)

  // Sync tool groups if gateway supports it
  try {
    await gw.rpc('config.set', {
      key: `agents.${agentId}.toolGroups`,
      value: pc.toolGroups,
    })
  } catch {
    // Not all gateways support tool group config — ignore
  }
}
