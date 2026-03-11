import type { LoopMode } from '@/types'
import {
  normalizeRuntimeSettingFields,
} from '@/lib/runtime/runtime-loop'
import { loadSettings } from '@/lib/server/storage'

export interface RuntimeSettings {
  loopMode: LoopMode
  agentLoopRecursionLimit: number
  orchestratorLoopRecursionLimit: number
  legacyOrchestratorMaxTurns: number
  delegationMaxDepth: number
  ongoingLoopMaxIterations: number
  ongoingLoopMaxRuntimeMs: number | null
  shellCommandTimeoutMs: number
  claudeCodeTimeoutMs: number
  cliProcessTimeoutMs: number
  streamIdleStallMs: number
  requiredToolKickoffMs: number
}

export function loadRuntimeSettings(): RuntimeSettings {
  const settings = loadSettings()
  const normalized = normalizeRuntimeSettingFields(settings)

  return {
    loopMode: normalized.loopMode as LoopMode,
    agentLoopRecursionLimit: normalized.agentLoopRecursionLimit,
    orchestratorLoopRecursionLimit: normalized.orchestratorLoopRecursionLimit,
    legacyOrchestratorMaxTurns: normalized.legacyOrchestratorMaxTurns,
    delegationMaxDepth: normalized.delegationMaxDepth,
    ongoingLoopMaxIterations: normalized.ongoingLoopMaxIterations,
    ongoingLoopMaxRuntimeMs: normalized.ongoingLoopMaxRuntimeMinutes > 0 ? normalized.ongoingLoopMaxRuntimeMinutes * 60_000 : null,
    shellCommandTimeoutMs: normalized.shellCommandTimeoutSec * 1000,
    claudeCodeTimeoutMs: normalized.claudeCodeTimeoutSec * 1000,
    cliProcessTimeoutMs: normalized.cliProcessTimeoutSec * 1000,
    streamIdleStallMs: normalized.streamIdleStallSec * 1000,
    requiredToolKickoffMs: normalized.requiredToolKickoffSec * 1000,
  }
}

export function getAgentLoopRecursionLimit(runtime: RuntimeSettings): number {
  return runtime.loopMode === 'ongoing' ? runtime.ongoingLoopMaxIterations : runtime.agentLoopRecursionLimit
}

export function getOrchestratorLoopRecursionLimit(runtime: RuntimeSettings): number {
  return runtime.loopMode === 'ongoing' ? runtime.ongoingLoopMaxIterations : runtime.orchestratorLoopRecursionLimit
}

export function getLegacyOrchestratorMaxTurns(runtime: RuntimeSettings): number {
  return runtime.loopMode === 'ongoing' ? runtime.ongoingLoopMaxIterations : runtime.legacyOrchestratorMaxTurns
}
