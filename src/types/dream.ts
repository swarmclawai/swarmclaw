// --- Dreaming (idle-time memory consolidation) ---

export type DreamStatus = 'pending' | 'running' | 'completed' | 'failed'
export type DreamTrigger = 'idle' | 'manual'

export interface DreamCycleResult {
  decayed: number
  pruned: number
  promoted: number
  deduped: number
  consolidated: number
  reflections: string[]
  memoriesReviewed: number
  durationMs: number
  errors: string[]
}

export interface DreamCycle {
  id: string
  agentId: string
  status: DreamStatus
  trigger: DreamTrigger
  startedAt: number
  completedAt?: number | null
  result?: DreamCycleResult | null
  error?: string | null
}

export interface DreamConfig {
  enabled: boolean
  cooldownMinutes: number
  decayAgeDays: number
  pruneThresholdDays: number
  tier2Enabled: boolean
  tier2MaxMemories: number
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  enabled: true,
  cooldownMinutes: 360,
  decayAgeDays: 30,
  pruneThresholdDays: 90,
  tier2Enabled: true,
  tier2MaxMemories: 50,
}
