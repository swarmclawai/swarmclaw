import type { LoopMode } from '@/types'
import {
  DEFAULT_AGENT_LOOP_RECURSION_LIMIT,
  DEFAULT_CLAUDE_CODE_TIMEOUT_SEC,
  DEFAULT_CLI_PROCESS_TIMEOUT_SEC,
  DEFAULT_DELEGATION_MAX_DEPTH,
  DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS,
  DEFAULT_LOOP_MODE,
  DEFAULT_ONGOING_LOOP_MAX_ITERATIONS,
  DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES,
  DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT,
  DEFAULT_SHELL_COMMAND_TIMEOUT_SEC,
} from '@/lib/runtime-loop'
import { loadSettings } from './storage'

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
}

function parseIntSetting(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  const int = Math.trunc(parsed)
  return Math.max(min, Math.min(max, int))
}

function parseLoopMode(value: unknown): LoopMode {
  return value === 'ongoing' ? 'ongoing' : DEFAULT_LOOP_MODE
}

export function loadRuntimeSettings(): RuntimeSettings {
  const settings = loadSettings()
  const loopMode = parseLoopMode(settings.loopMode)

  const agentLoopRecursionLimit = parseIntSetting(
    settings.agentLoopRecursionLimit,
    DEFAULT_AGENT_LOOP_RECURSION_LIMIT,
    1,
    200,
  )
  const orchestratorLoopRecursionLimit = parseIntSetting(
    settings.orchestratorLoopRecursionLimit,
    DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT,
    1,
    300,
  )
  const legacyOrchestratorMaxTurns = parseIntSetting(
    settings.legacyOrchestratorMaxTurns,
    DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS,
    1,
    300,
  )
  const delegationMaxDepth = parseIntSetting(
    settings.delegationMaxDepth,
    DEFAULT_DELEGATION_MAX_DEPTH,
    1,
    12,
  )
  const ongoingLoopMaxIterations = parseIntSetting(
    settings.ongoingLoopMaxIterations,
    DEFAULT_ONGOING_LOOP_MAX_ITERATIONS,
    10,
    5000,
  )
  const ongoingLoopMaxRuntimeMinutes = parseIntSetting(
    settings.ongoingLoopMaxRuntimeMinutes,
    DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES,
    0,
    1440,
  )

  const shellCommandTimeoutSec = parseIntSetting(
    settings.shellCommandTimeoutSec,
    DEFAULT_SHELL_COMMAND_TIMEOUT_SEC,
    1,
    600,
  )
  const claudeCodeTimeoutSec = parseIntSetting(
    settings.claudeCodeTimeoutSec,
    DEFAULT_CLAUDE_CODE_TIMEOUT_SEC,
    5,
    7200,
  )
  const cliProcessTimeoutSec = parseIntSetting(
    settings.cliProcessTimeoutSec,
    DEFAULT_CLI_PROCESS_TIMEOUT_SEC,
    10,
    7200,
  )

  return {
    loopMode,
    agentLoopRecursionLimit,
    orchestratorLoopRecursionLimit,
    legacyOrchestratorMaxTurns,
    delegationMaxDepth,
    ongoingLoopMaxIterations,
    ongoingLoopMaxRuntimeMs: ongoingLoopMaxRuntimeMinutes > 0 ? ongoingLoopMaxRuntimeMinutes * 60_000 : null,
    shellCommandTimeoutMs: shellCommandTimeoutSec * 1000,
    claudeCodeTimeoutMs: claudeCodeTimeoutSec * 1000,
    cliProcessTimeoutMs: cliProcessTimeoutSec * 1000,
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
