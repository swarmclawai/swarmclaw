import type { SessionResetMode } from './session'

// --- App Settings ---
export type LoopMode = 'bounded' | 'ongoing'
export type AutonomyEstopLevel = 'none' | 'autonomy' | 'all'

export interface GoalContract {
  objective: string
  constraints?: string[]
  budgetUsd?: number | null
  deadlineAt?: number | null
  successMetric?: string | null
}

export interface WhatsAppApprovedContact {
  id: string
  label: string
  phone: string
}

export interface AppSettings {
  userPrompt?: string
  userName?: string
  setupCompleted?: boolean
  embeddingProvider?: 'local' | 'openai' | 'ollama' | null
  embeddingModel?: string | null
  embeddingCredentialId?: string | null
  embeddingEndpoint?: string | null
  loopMode?: LoopMode
  agentLoopRecursionLimit?: number
  delegationMaxDepth?: number
  ongoingLoopMaxIterations?: number
  ongoingLoopMaxRuntimeMinutes?: number
  maxFollowupChain?: number
  shellCommandTimeoutSec?: number
  claudeCodeTimeoutSec?: number
  cliProcessTimeoutSec?: number
  streamIdleStallSec?: number
  requiredToolKickoffSec?: number
  userAvatarSeed?: string
  elevenLabsEnabled?: boolean
  elevenLabsApiKey?: string | null
  elevenLabsApiKeyConfigured?: boolean
  elevenLabsVoiceId?: string | null
  speechRecognitionLang?: string | null
  tavilyApiKey?: string | null
  tavilyApiKeyConfigured?: boolean
  braveApiKey?: string | null
  braveApiKeyConfigured?: boolean
  heartbeatPrompt?: string | null
  heartbeatIntervalSec?: number | null
  heartbeatInterval?: string | number | null
  heartbeatModel?: string | null
  heartbeatAckMaxChars?: number | null
  heartbeatShowOk?: boolean | null
  heartbeatShowAlerts?: boolean | null
  heartbeatTarget?: 'last' | 'none' | string | null
  heartbeatActiveStart?: string | null
  heartbeatActiveEnd?: string | null
  heartbeatTimezone?: string | null
  heartbeatLightContext?: boolean | null
  sessionResetMode?: SessionResetMode | null
  sessionIdleTimeoutSec?: number | null
  sessionMaxAgeSec?: number | null
  sessionDailyResetAt?: string | null
  sessionResetTimezone?: string | null
  untrustedContentGuardMode?: 'off' | 'warn' | 'block'
  // Task resiliency and supervision
  defaultTaskMaxAttempts?: number
  taskRetryBackoffSec?: number
  taskStallTimeoutMin?: number
  // Safety rails
  safetyRequireApprovalForOutbound?: boolean
  safetyMaxDailySpendUsd?: number | null
  safetyBlockedTools?: string[]
  capabilityPolicyMode?: 'permissive' | 'balanced' | 'strict'
  capabilityBlockedTools?: string[]
  capabilityBlockedCategories?: string[]
  capabilityAllowedTools?: string[]
  taskManagementEnabled?: boolean
  projectManagementEnabled?: boolean
  // Memory governance
  memoryWorkingTtlHours?: number
  memoryDefaultConfidence?: number
  memoryPruneEnabled?: boolean
  memorySummaryEnabled?: boolean
  // Capability router preferences
  autonomyPreferredDelegates?: Array<'claude' | 'codex' | 'opencode'>
  autonomyPreferToolRouting?: boolean
  // Continuous eval
  autonomyEvalEnabled?: boolean
  autonomyEvalCron?: string | null
  supervisorEnabled?: boolean
  supervisorRuntimeScope?: 'chat' | 'task' | 'both'
  supervisorNoProgressLimit?: number
  supervisorRepeatedToolLimit?: number
  autonomyResumeApprovalsEnabled?: boolean
  reflectionEnabled?: boolean
  reflectionAutoWriteMemory?: boolean
  memoryReferenceDepth?: number
  maxMemoriesPerLookup?: number
  maxLinkedMemoriesExpanded?: number
  memoryMaxDepth?: number
  memoryMaxPerLookup?: number
  // Chat UX
  suggestionsEnabled?: boolean
  runtimeSkillRetrievalMode?: 'keyword' | 'embedding'
  runtimeSkillTopK?: number
  // Globally approved WhatsApp contacts for connector DMs
  whatsappApprovedContacts?: WhatsAppApprovedContact[]
  // Voice conversation
  voiceAutoSendDelaySec?: number
  // Default agent for main chat on startup
  defaultAgentId?: string | null
  // Theme
  themeHue?: string
  // Web search provider
  webSearchProvider?: 'duckduckgo' | 'google' | 'bing' | 'searxng' | 'tavily' | 'brave'
  searxngUrl?: string
  // Task custom field definitions
  taskCustomFieldDefs?: Array<{ key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }>
  // OpenClaw sync settings
  openclawWorkspacePath?: string | null
  openclawAutoSyncMemory?: boolean
  openclawAutoSyncSchedules?: boolean
  // Outbound ops alert webhook
  alertWebhookUrl?: string | null
  alertWebhookType?: 'discord' | 'slack' | 'custom' | null
  alertWebhookEvents?: ('error' | 'warning')[]
  // Deterministic LLM response cache
  responseCacheEnabled?: boolean
  responseCacheTtlSec?: number
  responseCacheMaxEntries?: number
  // Task quality gate defaults
  taskQualityGateEnabled?: boolean
  taskQualityGateMinResultChars?: number
  taskQualityGateMinEvidenceItems?: number
  taskQualityGateRequireVerification?: boolean
  taskQualityGateRequireArtifact?: boolean
  taskQualityGateRequireReport?: boolean
  // Integrity monitor
  integrityMonitorEnabled?: boolean
  // Background daemon
  daemonAutostartEnabled?: boolean
  // Tool loop detection thresholds
  toolLoopFrequencyWarn?: number
  toolLoopFrequencyCritical?: number
  toolLoopCircuitBreaker?: number
  // Per-extension settings (keyed by extensionId)
  extensionSettings?: Record<string, Record<string, unknown>>
}

export interface EstopState {
  level: AutonomyEstopLevel
  reason?: string | null
  engagedAt?: number | null
  engagedBy?: string | null
  resumeApprovalId?: string | null
  updatedAt: number
}

export interface GuardianCheckpoint {
  id: string
  cwd: string
  head: string
  branch?: string | null
  status: string
  createdAt: number
  createdBy: string
  approvalId?: string | null
  restorePreparedAt?: number | null
  restoredAt?: number | null
}
