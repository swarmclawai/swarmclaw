import type { LoopMode } from '@/types'

export const DEFAULT_LOOP_MODE: LoopMode = 'bounded'

// Loop limits
export const AGENT_LOOP_RECURSION_LIMIT_MIN = 1
export const AGENT_LOOP_RECURSION_LIMIT_MAX = 500
export const ORCHESTRATOR_LOOP_RECURSION_LIMIT_MIN = 1
export const ORCHESTRATOR_LOOP_RECURSION_LIMIT_MAX = 300
export const LEGACY_ORCHESTRATOR_MAX_TURNS_MIN = 1
export const LEGACY_ORCHESTRATOR_MAX_TURNS_MAX = 300
export const ONGOING_LOOP_MAX_ITERATIONS_MIN = 10
export const ONGOING_LOOP_MAX_ITERATIONS_MAX = 5000
export const ONGOING_LOOP_MAX_RUNTIME_MINUTES_MIN = 0
export const ONGOING_LOOP_MAX_RUNTIME_MINUTES_MAX = 1440
export const DELEGATION_MAX_DEPTH_MIN = 1
export const DELEGATION_MAX_DEPTH_MAX = 12
export const SHELL_COMMAND_TIMEOUT_SEC_MIN = 1
export const SHELL_COMMAND_TIMEOUT_SEC_MAX = 600
export const CLAUDE_CODE_TIMEOUT_SEC_MIN = 5
export const CLAUDE_CODE_TIMEOUT_SEC_MAX = 7200
export const CLI_PROCESS_TIMEOUT_SEC_MIN = 10
export const CLI_PROCESS_TIMEOUT_SEC_MAX = 7200
export const STREAM_IDLE_STALL_SEC_MIN = 30
export const STREAM_IDLE_STALL_SEC_MAX = 600
export const REQUIRED_TOOL_KICKOFF_SEC_MIN = 10
export const REQUIRED_TOOL_KICKOFF_SEC_MAX = 120

export const DEFAULT_AGENT_LOOP_RECURSION_LIMIT = 300
export const DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT = 80
export const DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS = 16
export const DEFAULT_ONGOING_LOOP_MAX_ITERATIONS = 250
export const DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES = 60
export const DEFAULT_DELEGATION_MAX_DEPTH = 3

// Tool/process timeouts
export const DEFAULT_SHELL_COMMAND_TIMEOUT_SEC = 120
export const DEFAULT_CLAUDE_CODE_TIMEOUT_SEC = 1800
export const DEFAULT_CLI_PROCESS_TIMEOUT_SEC = 1800
export const DEFAULT_STREAM_IDLE_STALL_SEC = 180
export const DEFAULT_REQUIRED_TOOL_KICKOFF_SEC = 45

function parseIntSetting(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export interface NormalizedRuntimeSettingFields {
  loopMode: LoopMode
  agentLoopRecursionLimit: number
  orchestratorLoopRecursionLimit: number
  legacyOrchestratorMaxTurns: number
  delegationMaxDepth: number
  ongoingLoopMaxIterations: number
  ongoingLoopMaxRuntimeMinutes: number
  shellCommandTimeoutSec: number
  claudeCodeTimeoutSec: number
  cliProcessTimeoutSec: number
  streamIdleStallSec: number
  requiredToolKickoffSec: number
}

export function normalizeRuntimeSettingFields(settings: Record<string, unknown>): NormalizedRuntimeSettingFields {
  return {
    loopMode: settings.loopMode === 'ongoing' ? 'ongoing' : DEFAULT_LOOP_MODE,
    agentLoopRecursionLimit: parseIntSetting(
      settings.agentLoopRecursionLimit,
      DEFAULT_AGENT_LOOP_RECURSION_LIMIT,
      AGENT_LOOP_RECURSION_LIMIT_MIN,
      AGENT_LOOP_RECURSION_LIMIT_MAX,
    ),
    orchestratorLoopRecursionLimit: parseIntSetting(
      settings.orchestratorLoopRecursionLimit,
      DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT,
      ORCHESTRATOR_LOOP_RECURSION_LIMIT_MIN,
      ORCHESTRATOR_LOOP_RECURSION_LIMIT_MAX,
    ),
    legacyOrchestratorMaxTurns: parseIntSetting(
      settings.legacyOrchestratorMaxTurns,
      DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS,
      LEGACY_ORCHESTRATOR_MAX_TURNS_MIN,
      LEGACY_ORCHESTRATOR_MAX_TURNS_MAX,
    ),
    delegationMaxDepth: parseIntSetting(
      settings.delegationMaxDepth,
      DEFAULT_DELEGATION_MAX_DEPTH,
      DELEGATION_MAX_DEPTH_MIN,
      DELEGATION_MAX_DEPTH_MAX,
    ),
    ongoingLoopMaxIterations: parseIntSetting(
      settings.ongoingLoopMaxIterations,
      DEFAULT_ONGOING_LOOP_MAX_ITERATIONS,
      ONGOING_LOOP_MAX_ITERATIONS_MIN,
      ONGOING_LOOP_MAX_ITERATIONS_MAX,
    ),
    ongoingLoopMaxRuntimeMinutes: parseIntSetting(
      settings.ongoingLoopMaxRuntimeMinutes,
      DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES,
      ONGOING_LOOP_MAX_RUNTIME_MINUTES_MIN,
      ONGOING_LOOP_MAX_RUNTIME_MINUTES_MAX,
    ),
    shellCommandTimeoutSec: parseIntSetting(
      settings.shellCommandTimeoutSec,
      DEFAULT_SHELL_COMMAND_TIMEOUT_SEC,
      SHELL_COMMAND_TIMEOUT_SEC_MIN,
      SHELL_COMMAND_TIMEOUT_SEC_MAX,
    ),
    claudeCodeTimeoutSec: parseIntSetting(
      settings.claudeCodeTimeoutSec,
      DEFAULT_CLAUDE_CODE_TIMEOUT_SEC,
      CLAUDE_CODE_TIMEOUT_SEC_MIN,
      CLAUDE_CODE_TIMEOUT_SEC_MAX,
    ),
    cliProcessTimeoutSec: parseIntSetting(
      settings.cliProcessTimeoutSec,
      DEFAULT_CLI_PROCESS_TIMEOUT_SEC,
      CLI_PROCESS_TIMEOUT_SEC_MIN,
      CLI_PROCESS_TIMEOUT_SEC_MAX,
    ),
    streamIdleStallSec: parseIntSetting(
      settings.streamIdleStallSec,
      DEFAULT_STREAM_IDLE_STALL_SEC,
      STREAM_IDLE_STALL_SEC_MIN,
      STREAM_IDLE_STALL_SEC_MAX,
    ),
    requiredToolKickoffSec: parseIntSetting(
      settings.requiredToolKickoffSec,
      DEFAULT_REQUIRED_TOOL_KICKOFF_SEC,
      REQUIRED_TOOL_KICKOFF_SEC_MIN,
      REQUIRED_TOOL_KICKOFF_SEC_MAX,
    ),
  }
}
