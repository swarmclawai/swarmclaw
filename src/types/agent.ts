import type { ProviderId, ProviderType, OllamaMode } from './provider'
import type { SessionResetMode, IdentityContinuityState } from './session'
import type { SkillAllowlistMode } from './skill'
import type { DreamConfig } from './dream'

// --- SwarmFeed Heartbeat ---

export interface SwarmFeedHeartbeatConfig {
  enabled: boolean
  browseFeed: boolean
  postFrequency: 'every_cycle' | 'daily' | 'on_task_completion' | 'manual_only'
  autoReply: boolean
  autoFollow: boolean
  channelsToMonitor: string[]
}

// --- SwarmDock Marketplace ---

export interface SwarmDockMarketplaceConfig {
  enabled: boolean
  autoDiscover: boolean
  maxBudgetUsdc: string
  autoBid: boolean
  autoBidMaxPrice: string
  taskNotifications: boolean
  preferredCategories: string[]
}

// --- Agent / Delegation ---

export type AgentRole = 'worker' | 'coordinator'
export type DelegationTargetMode = 'all' | 'selected'

export interface AgentOrgChart {
  parentId?: string | null
  teamLabel?: string | null
  teamColor?: string | null
  x?: number | null
  y?: number | null
}

export interface Agent {
  id: string
  name: string
  openclawAgentId?: string | null
  description: string
  soul?: string
  identityState?: IdentityContinuityState | null
  emoji?: string
  creature?: string
  vibe?: string
  theme?: string
  avatar?: string
  systemPrompt: string
  provider: ProviderId
  model: string
  ollamaMode?: OllamaMode | null
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  preferredGatewayTags?: string[]
  preferredGatewayUseCase?: string | null
  routingStrategy?: AgentRoutingStrategy | null
  routingTargets?: AgentRoutingTarget[]
  role?: AgentRole                // default 'worker' — coordinators get enhanced delegation prompts
  delegationEnabled?: boolean
  delegationTargetMode?: DelegationTargetMode
  delegationTargetAgentIds?: string[]
  tools?: string[]
  // When 'scoped', the chat turn restricts enabled extensions to the
  // intersection of the universal core list and agent.tools (plus a small
  // non-negotiable baseline for memory + context management). Default
  // 'universal' preserves existing behavior. Opt in to cut per-turn tool
  // guidance dramatically — a focused agent with 5 tools drops ~15 k chars
  // of tool-related prompt text vs. the full 33-tool universe.
  toolAccessMode?: 'universal' | 'scoped'
  extensions?: string[]
  skills?: string[]             // e.g. ['frontend-design'] — pinned Claude Code skills to mention explicitly
  skillIds?: string[]           // IDs of pinned managed skills to keep always-on for this agent
  mcpServerIds?: string[]       // IDs of configured MCP servers to inject tools from
  mcpDisabledTools?: string[]   // MCP tool names disabled for this agent (denylist)
  orgChart?: AgentOrgChart | null
  capabilities?: string[]       // e.g. ['frontend', 'screenshots', 'research', 'devops']
  threadSessionId?: string | null  // persistent shortcut chat session for agent-centric UI
  heartbeatEnabled?: boolean
  heartbeatIntervalSec?: number | null
  heartbeatInterval?: string | number | null
  heartbeatPrompt?: string | null
  heartbeatModel?: string | null
  heartbeatAckMaxChars?: number | null
  heartbeatShowOk?: boolean | null
  heartbeatShowAlerts?: boolean | null
  heartbeatTarget?: 'last' | 'none' | string | null
  heartbeatGoal?: string | null
  heartbeatNextAction?: string | null
  heartbeatLightContext?: boolean | null
  sessionResetMode?: SessionResetMode | null
  sessionIdleTimeoutSec?: number | null
  sessionMaxAgeSec?: number | null
  sessionDailyResetAt?: string | null
  sessionResetTimezone?: string | null
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  memoryScopeMode?: 'auto' | 'all' | 'global' | 'agent' | 'session' | 'project' | null
  memoryTierPreference?: 'working' | 'durable' | 'archive' | 'blended' | null
  elevenLabsVoiceId?: string | null
  projectId?: string
  avatarSeed?: string
  avatarUrl?: string | null
  pinned?: boolean
  lastUsedAt?: number
  totalCost?: number
  disabled?: boolean
  trashedAt?: number
  openclawSkillMode?: SkillAllowlistMode
  openclawAllowedSkills?: string[]
  responseStyle?: 'concise' | 'normal' | 'detailed' | null
  responseMaxChars?: number | null
  monthlyBudget?: number | null
  dailyBudget?: number | null
  hourlyBudget?: number | null
  /** Reference to a Goal in the goal hierarchy. */
  goalId?: string | null
  autoRecovery?: boolean
  proactiveMemory?: boolean
  /** Auto-refresh a reviewed skill draft from meaningful chat turns for this agent. */
  autoDraftSkillSuggestions?: boolean
  /** Controls whether file operations are confined to the workspace or allowed anywhere on the host. Default: 'workspace'. */
  filesystemScope?: 'workspace' | 'machine' | null
  /** Per-agent filesystem restrictions. Globs matched against resolved paths. */
  fileAccessPolicy?: {
    /** If set, only these paths (globs) are writable. Others are blocked. */
    allowedPaths?: string[]
    /** These paths (globs) are always blocked even if allowedPaths matches. */
    blockedPaths?: string[]
  } | null

  /** Docker-backed browser sandbox settings and legacy execution sandbox compatibility fields. */
  sandboxConfig?: {
    enabled: boolean
    mode?: 'off' | 'non-main' | 'all' // default: 'all' when enabled, modeled after OpenClaw
    scope?: 'session' | 'agent'       // default: 'session'
    workspaceAccess?: 'ro' | 'rw'     // default: 'rw'
    image?: string               // default: 'node:22-slim'
    network?: 'none' | 'bridge'  // default: 'none'
    memoryMb?: number            // default: 512
    cpus?: number                // default: 1.0
    readonlyRoot?: boolean       // default: false
    workdir?: string             // default: '/workspace'
    containerPrefix?: string     // default: 'swarmclaw-sb-'
    pidsLimit?: number           // default: 256
    setupCommand?: string
    browser?: {
      enabled?: boolean
      image?: string
      containerPrefix?: string
      network?: 'none' | 'bridge'
      cdpPort?: number
      vncPort?: number
      noVncPort?: number
      headless?: boolean
      enableNoVnc?: boolean
      mountUploads?: boolean
      autoStartTimeoutMs?: number
    } | null
    prune?: {
      idleHours?: number
      maxAgeDays?: number
    } | null
  } | null

  /** Configuration for the `execute` tool (just-bash sandbox or explicit host bash). */
  executeConfig?: {
    backend?: 'sandbox' | 'host'
    network?: { enabled: boolean; allowedUrls?: string[] }
    runtimes?: { python?: boolean; javascript?: boolean; sqlite?: boolean }
    timeout?: number
    credentials?: string[]
  } | null

  budgetAction?: 'warn' | 'block'
  /** Runtime-enriched: current month's spend. Populated by GET /api/agents when monthlyBudget is set. */
  monthlySpend?: number
  /** Runtime-enriched: current day's spend. Populated by GET /api/agents when dailyBudget is set. */
  dailySpend?: number
  /** Runtime-enriched: trailing 1-hour spend. Populated by GET /api/agents when hourlyBudget is set. */
  hourlySpend?: number
  /** Persisted: accumulated spend in current monthly window (USD). Updated on each usage event. */
  spentMonthlyCents?: number
  /** Persisted: accumulated spend in current daily window (USD). Updated on each usage event. */
  spentDailyCents?: number
  /** Persisted: accumulated spend in current hourly window (USD). Updated on each usage event. */
  spentHourlyCents?: number
  /** Timestamp of last spend rollup; used to detect window resets. */
  lastSpendRollupAt?: number
  maxFollowupChain?: number

  // Dreaming (idle-time memory consolidation)
  dreamEnabled?: boolean
  dreamConfig?: Partial<DreamConfig> | null
  lastDreamAt?: number | null
  dreamCycleCount?: number

  // Orchestrator Mode
  orchestratorEnabled?: boolean
  orchestratorMission?: string
  orchestratorWakeInterval?: string | number | null
  orchestratorGovernance?: 'autonomous' | 'approval-required' | 'notify-only'
  orchestratorMaxCyclesPerDay?: number | null
  orchestratorLastWakeAt?: number | null
  orchestratorCycleCount?: number

  // SwarmFeed (social network integration)
  swarmfeedEnabled?: boolean
  swarmfeedJoinedAt?: number | null
  swarmfeedBio?: string | null
  swarmfeedPinnedPostId?: string | null
  swarmfeedAutoPost?: boolean
  swarmfeedAutoPostChannels?: string[]
  swarmfeedApiKey?: string | null
  swarmfeedAgentId?: string | null
  swarmfeedLastAutoPostAt?: number | null
  origin?: 'swarmdock' | 'swarmfeed' | 'swarmclaw' | 'external'
  swarmfeedHeartbeat?: SwarmFeedHeartbeatConfig | null

  // SwarmDock (marketplace integration)
  swarmdockEnabled?: boolean
  swarmdockListedAt?: number | null
  swarmdockDescription?: string | null
  swarmdockSkills?: string[]
  swarmdockWalletId?: string | null
  swarmdockAgentId?: string | null
  swarmdockDid?: string | null
  swarmdockApiKey?: string | null
  swarmdockMarketplace?: SwarmDockMarketplaceConfig | null

  createdAt: number
  updatedAt: number
}

export type AgentTool = 'browser'

export interface ClaudeSkill {
  id: string
  name: string
  description: string
}

// --- Agent Routing / Packs ---

export type AgentRoutingStrategy = 'single' | 'balanced' | 'economy' | 'premium' | 'reasoning'
export type AgentRoutingTargetRole = 'primary' | 'economy' | 'premium' | 'reasoning' | 'backup'

export interface AgentRoutingTarget {
  id: string
  label?: string
  role?: AgentRoutingTargetRole
  provider: ProviderId
  model: string
  ollamaMode?: OllamaMode | null
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  preferredGatewayTags?: string[]
  preferredGatewayUseCase?: string | null
  priority?: number
}

export interface AgentPackEntry {
  id: string
  name: string
  description?: string
  provider: ProviderId
  model: string
  ollamaMode?: OllamaMode | null
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  routingStrategy?: AgentRoutingStrategy | null
  routingTargets?: AgentRoutingTarget[]
  tools?: string[]
  extensions?: string[]
  capabilities?: string[]
  elevenLabsVoiceId?: string | null
  soul?: string
  systemPrompt?: string
}

export interface AgentPackManifest {
  schemaVersion: 1
  kind: 'swarmclaw-agent-pack'
  name: string
  description?: string
  exportedAt: number
  recommendedProviders?: ProviderType[]
  agents: AgentPackEntry[]
}

// --- External Agents ---

export type ExternalAgentSourceType = 'codex' | 'claude' | 'opencode' | 'openclaw' | 'custom' | 'a2a'
export type ExternalAgentStatus = 'online' | 'idle' | 'offline' | 'stale'

export interface ExternalAgentRuntime {
  id: string
  name: string
  sourceType: ExternalAgentSourceType
  status: ExternalAgentStatus
  provider?: ProviderId | null
  model?: string | null
  workspace?: string | null
  transport?: 'http' | 'ws' | 'cli' | 'gateway' | 'custom' | null
  endpoint?: string | null
  agentId?: string | null
  gatewayProfileId?: string | null
  capabilities?: string[]
  labels?: string[]
  lifecycleState?: 'active' | 'draining' | 'cordoned'
  gatewayTags?: string[]
  gatewayUseCase?: string | null
  version?: string | null
  lastHealthNote?: string | null
  metadata?: Record<string, unknown> | null
  tokenStats?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  } | null
  a2aCard?: {
    protocolVersion?: string | null
    apiEndpoint?: string | null
    capabilities?: Array<{ name: string; methods?: string[]; description?: string | null }>
    supportsStreaming?: boolean
    supportsAsync?: boolean
  } | null
  lastHeartbeatAt?: number | null
  lastSeenAt?: number | null
  createdAt: number
  updatedAt: number
}
