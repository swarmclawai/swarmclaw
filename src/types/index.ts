export interface MessageToolEvent {
  name: string
  input: string
  output?: string
  error?: boolean
}

export interface Message {
  role: 'user' | 'assistant'
  text: string
  time: number
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  toolEvents?: MessageToolEvent[]
  kind?: 'chat' | 'heartbeat' | 'system'
  suppressed?: boolean
  bookmarked?: boolean
  suggestions?: string[]
}

export type ProviderType = 'claude-cli' | 'codex-cli' | 'opencode-cli' | 'openai' | 'ollama' | 'anthropic' | 'openclaw' | 'google' | 'deepseek' | 'groq' | 'together' | 'mistral' | 'xai' | 'fireworks'

export interface ProviderInfo {
  id: ProviderType
  name: string
  models: string[]
  defaultModels?: string[]
  requiresApiKey: boolean
  optionalApiKey?: boolean
  requiresEndpoint: boolean
  defaultEndpoint?: string
}

export interface Credential {
  id: string
  provider: string
  name: string
  createdAt: number
}

export type Credentials = Record<string, Credential>

export interface Session {
  id: string
  name: string
  cwd: string
  user: string
  provider: ProviderType
  model: string
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  claudeSessionId: string | null
  codexThreadId?: string | null
  opencodeSessionId?: string | null
  delegateResumeIds?: {
    claudeCode?: string | null
    codex?: string | null
    opencode?: string | null
  }
  messages: Message[]
  createdAt: number
  lastActiveAt: number
  active?: boolean
  mainSession?: boolean
  sessionType?: SessionType
  agentId?: string | null
  parentSessionId?: string | null
  tools?: string[]
  heartbeatEnabled?: boolean | null
  heartbeatIntervalSec?: number | null
  heartbeatTarget?: 'last' | 'none' | string | null
  lastAutoMemoryAt?: number | null
  mainLoopState?: {
    goal?: string | null
    goalContract?: GoalContract | null
    status?: 'idle' | 'progress' | 'blocked' | 'ok'
    summary?: string | null
    nextAction?: string | null
    planSteps?: string[]
    currentPlanStep?: string | null
    reviewNote?: string | null
    reviewConfidence?: number | null
    missionTaskId?: string | null
    momentumScore?: number
    paused?: boolean
    autonomyMode?: 'assist' | 'autonomous'
    pendingEvents?: Array<{
      id: string
      type: string
      text: string
      createdAt: number
    }>
    timeline?: Array<{
      id: string
      at: number
      source: string
      note: string
      status?: 'idle' | 'progress' | 'blocked' | 'ok'
    }>
    followupChainCount?: number
    metaMissCount?: number
    workingMemoryNotes?: string[]
    lastMemoryNoteAt?: number | null
    lastPlannedAt?: number | null
    lastReviewedAt?: number | null
    lastTickAt?: number | null
    updatedAt?: number
  }
  pinned?: boolean
  file?: string | null
  queuedCount?: number
  currentRunId?: string | null
  conversationTone?: string
}

export type Sessions = Record<string, Session>

export type SessionTool =
  | 'shell'
  | 'files'
  | 'claude_code'
  | 'codex_cli'
  | 'opencode_cli'
  | 'web_search'
  | 'web_fetch'
  | 'edit_file'
  | 'process'

// --- Cost Tracking ---

export interface UsageRecord {
  sessionId: string
  messageIndex: number
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost: number
  timestamp: number
}

// --- Plugin System ---

export interface PluginHooks {
  beforeAgentStart?: (ctx: { session: Session; message: string }) => Promise<void> | void
  afterAgentComplete?: (ctx: { session: Session; response: string }) => Promise<void> | void
  beforeToolExec?: (ctx: { toolName: string; input: any }) => Promise<any> | any
  afterToolExec?: (ctx: { toolName: string; input: any; output: string }) => Promise<void> | void
  onMessage?: (ctx: { session: Session; message: Message }) => Promise<void> | void
}

export interface Plugin {
  name: string
  description?: string
  hooks: PluginHooks
}

export interface PluginMeta {
  name: string
  description?: string
  filename: string
  enabled: boolean
  author?: string
  version?: string
  source?: 'local' | 'marketplace'
  openclaw?: boolean
}

export interface MarketplacePlugin {
  id: string
  name: string
  description: string
  author: string
  version: string
  url: string
  tags: string[]
  openclaw: boolean
  downloads: number
}

export interface SSEEvent {
  t: 'd' | 'md' | 'r' | 'done' | 'err' | 'tool_call' | 'tool_result' | 'status'
  text?: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
}

export interface Directory {
  name: string
  path: string
}

export interface DevServerStatus {
  running: boolean
  url?: string
}

export interface DeployResult {
  ok: boolean
  output?: string
  error?: string
}

export interface UploadResult {
  path: string
  size: number
  url: string
}

export interface NetworkInfo {
  ip: string
  port: number
}

// --- Agent / Orchestration ---

export interface Agent {
  id: string
  name: string
  description: string
  soul?: string
  systemPrompt: string
  provider: ProviderType
  model: string
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  isOrchestrator?: boolean
  subAgentIds?: string[]
  tools?: string[]              // e.g. ['browser'] — available tool integrations
  skills?: string[]             // e.g. ['frontend-design'] — Claude Code skills to use
  skillIds?: string[]           // IDs of uploaded skills from the Skills manager
  mcpServerIds?: string[]       // IDs of configured MCP servers to inject tools from
  mcpDisabledTools?: string[]   // MCP tool names disabled for this agent (denylist)
  capabilities?: string[]       // e.g. ['frontend', 'screenshots', 'research', 'devops']
  threadSessionId?: string | null  // persistent chat thread session for agent-centric UI
  platformAssignScope?: 'self' | 'all'  // defaults to 'self'
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
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  projectId?: string
  avatarSeed?: string
  trashedAt?: number
  openclawSkillMode?: SkillAllowlistMode
  openclawAllowedSkills?: string[]
  createdAt: number
  updatedAt: number
}

export type AgentTool = 'browser'

export interface ClaudeSkill {
  id: string
  name: string
  description: string
}

export type ScheduleType = 'cron' | 'interval' | 'once'
export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'failed'

export interface Schedule {
  id: string
  name: string
  agentId: string
  projectId?: string
  taskPrompt: string
  scheduleType: ScheduleType
  cron?: string
  intervalMs?: number
  runAt?: number
  lastRunAt?: number
  nextRunAt?: number
  status: ScheduleStatus
  linkedTaskId?: string | null
  runNumber?: number
  createdAt: number
}

export interface FileReference {
  path: string
  contextSnippet?: string
  kind?: 'file' | 'folder' | 'project'
  projectRoot?: string
  projectName?: string
  exists?: boolean
  timestamp: number
}

export interface MemoryReference {
  type: 'project' | 'folder' | 'file' | 'task' | 'session' | 'url'
  path?: string
  projectRoot?: string
  projectName?: string
  title?: string
  note?: string
  exists?: boolean
  timestamp: number
}

export interface MemoryImage {
  path: string
  mimeType?: string
  width?: number
  height?: number
  sizeBytes?: number
}

export interface MemoryEntry {
  id: string
  agentId?: string | null
  sessionId?: string | null
  category: string
  title: string
  content: string
  metadata?: Record<string, unknown>
  references?: MemoryReference[]
  filePaths?: FileReference[]
  image?: MemoryImage | null
  imagePath?: string | null
  linkedMemoryIds?: string[]
  createdAt: number
  updatedAt: number
}

export type SessionType = 'human' | 'orchestrated'
export type AppView = 'agents' | 'schedules' | 'memory' | 'tasks' | 'secrets' | 'providers' | 'skills' | 'connectors' | 'webhooks' | 'mcp_servers' | 'knowledge' | 'plugins' | 'usage' | 'runs' | 'logs' | 'settings' | 'projects'

export interface Project {
  id: string
  name: string
  description: string
  color?: string
  createdAt: number
  updatedAt: number
}

// --- Session Runs ---

export type SessionRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface SessionRunRecord {
  id: string
  sessionId: string
  source: string
  internal: boolean
  mode: string
  status: SessionRunStatus
  messagePreview: string
  dedupeKey?: string
  queuedAt: number
  startedAt?: number
  endedAt?: number
  error?: string
  resultPreview?: string
}

// --- Webhook Logs ---

export interface WebhookLogEntry {
  id: string
  webhookId: string
  event: string
  payload: string
  status: 'success' | 'error'
  sessionId?: string
  runId?: string
  error?: string
  timestamp: number
}

// --- App Settings ---

export type LangGraphProvider = string
export type LoopMode = 'bounded' | 'ongoing'

export interface GoalContract {
  objective: string
  constraints?: string[]
  budgetUsd?: number | null
  deadlineAt?: number | null
  successMetric?: string | null
}

export interface AppSettings {
  userPrompt?: string
  userName?: string
  setupCompleted?: boolean
  langGraphProvider?: LangGraphProvider
  langGraphModel?: string
  langGraphCredentialId?: string | null
  langGraphEndpoint?: string | null
  embeddingProvider?: 'local' | 'openai' | 'ollama' | null
  embeddingModel?: string | null
  embeddingCredentialId?: string | null
  loopMode?: LoopMode
  agentLoopRecursionLimit?: number
  orchestratorLoopRecursionLimit?: number
  legacyOrchestratorMaxTurns?: number
  ongoingLoopMaxIterations?: number
  ongoingLoopMaxRuntimeMinutes?: number
  shellCommandTimeoutSec?: number
  claudeCodeTimeoutSec?: number
  cliProcessTimeoutSec?: number
  elevenLabsApiKey?: string | null
  elevenLabsVoiceId?: string | null
  speechRecognitionLang?: string | null
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
  memoryReferenceDepth?: number
  maxMemoriesPerLookup?: number
  maxLinkedMemoriesExpanded?: number
  memoryMaxDepth?: number
  memoryMaxPerLookup?: number
  // Voice conversation
  voiceAutoSendDelaySec?: number
  // Web search provider
  webSearchProvider?: 'duckduckgo' | 'google' | 'bing' | 'searxng' | 'tavily' | 'brave'
  searxngUrl?: string
  // OpenClaw sync settings
  openclawWorkspacePath?: string | null
  openclawAutoSyncMemory?: boolean
  openclawAutoSyncSchedules?: boolean
}

// --- Orchestrator Secrets ---

export interface OrchestratorSecret {
  id: string
  name: string
  service: string           // e.g. 'gmail', 'ahrefs', 'custom'
  encryptedValue: string
  scope: 'global' | 'agent'
  agentIds: string[]      // if scope === 'agent', which orchestrators can use it
  createdAt: number
  updatedAt: number
}

// --- Task Board ---

export type BoardTaskStatus = 'backlog' | 'queued' | 'running' | 'completed' | 'failed' | 'archived'

export interface TaskComment {
  id: string
  author: string         // agent name or 'user'
  agentId?: string     // if from an orchestrator
  text: string
  createdAt: number
}

// --- Custom Providers ---

export interface ProviderConfig {
  id: string
  name: string
  type: 'builtin' | 'custom'
  baseUrl?: string
  models: string[]
  requiresApiKey: boolean
  credentialId?: string | null
  isEnabled: boolean
  createdAt: number
  updatedAt: number
}

// --- Skills ---

export interface Skill {
  id: string
  name: string
  filename: string
  content: string
  projectId?: string
  description?: string
  sourceUrl?: string
  sourceFormat?: 'openclaw' | 'plain'
  createdAt: number
  updatedAt: number
}

// --- Connectors (Chat Platform Bridges) ---

export type ConnectorPlatform = 'discord' | 'telegram' | 'slack' | 'whatsapp' | 'openclaw' | 'bluebubbles' | 'signal' | 'teams' | 'googlechat' | 'matrix'
export type ConnectorStatus = 'stopped' | 'running' | 'error'

export interface Connector {
  id: string
  name: string
  platform: ConnectorPlatform
  agentId: string               // which agent handles incoming messages
  credentialId?: string | null    // bot token stored as encrypted credential
  config: Record<string, string>  // platform-specific settings
  isEnabled: boolean
  status: ConnectorStatus
  lastError?: string | null
  /** WhatsApp QR code data URL (runtime only) */
  qrDataUrl?: string | null
  /** WhatsApp authenticated/paired state (runtime only) */
  authenticated?: boolean
  /** WhatsApp has stored credentials from previous pairing (runtime only) */
  hasCredentials?: boolean
  /** Connector presence info (runtime only) */
  presence?: { lastMessageAt?: number | null; channelId?: string | null }
  createdAt: number
  updatedAt: number
}

export interface Webhook {
  id: string
  name: string
  source: string
  events: string[]
  agentId?: string | null
  secret?: string
  isEnabled: boolean
  createdAt: number
  updatedAt: number
}

export interface DocumentEntry {
  id: string
  title: string
  fileName: string
  sourcePath: string
  content: string
  method: string
  textLength: number
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface BoardTask {
  id: string
  title: string
  description: string
  status: BoardTaskStatus
  agentId: string
  projectId?: string
  goalContract?: GoalContract | null
  cwd?: string | null
  file?: string | null
  sessionId?: string | null
  completionReportPath?: string | null
  result?: string | null
  error?: string | null
  comments?: TaskComment[]
  images?: string[]
  createdAt: number
  updatedAt: number
  queuedAt?: number | null
  startedAt?: number | null
  completedAt?: number | null
  archivedAt?: number | null
  attempts?: number
  maxAttempts?: number
  retryBackoffSec?: number
  retryScheduledAt?: number | null
  runNumber?: number
  totalRuns?: number
  totalCompleted?: number
  totalFailed?: number
  sourceType?: 'schedule' | 'delegation' | 'manual'
  sourceScheduleId?: string | null
  sourceScheduleName?: string | null
  sourceScheduleKey?: string | null
  deadLetteredAt?: number | null
  cliResumeId?: string | null
  cliProvider?: string | null
  claudeResumeId?: string | null
  codexResumeId?: string | null
  opencodeResumeId?: string | null
  checkpoint?: {
    lastRunId?: string | null
    lastSessionId?: string | null
    note?: string | null
    updatedAt: number
  } | null
  validation?: {
    ok: boolean
    reasons: string[]
    checkedAt: number
  } | null
  pendingApproval?: {
    toolName: string
    args: Record<string, unknown>
    threadId: string
  } | null
}

// --- MCP Servers ---

export type McpTransport = 'stdio' | 'sse' | 'streamable-http'

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  command?: string             // for stdio transport
  args?: string[]              // for stdio transport
  url?: string                 // for sse/streamable-http transport
  env?: Record<string, string> // environment variables
  headers?: Record<string, string> // HTTP headers for sse/streamable-http
  createdAt: number
  updatedAt: number
}

// --- ClawHub ---

export interface ClawHubSkill {
  id: string
  name: string
  description: string
  author: string
  tags: string[]
  downloads: number
  url: string
  version: string
}

// --- OpenClaw Execution Approvals ---

export interface PendingExecApproval {
  id: string
  agentId: string
  sessionKey: string
  command: string
  cwd?: string
  host?: string
  security?: string
  ask?: string
  createdAtMs: number
  expiresAtMs: number
  resolving?: boolean
  error?: string
}

export type ExecApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

// --- OpenClaw Skills ---

export interface OpenClawSkillEntry {
  name: string
  description?: string
  source: 'bundled' | 'managed' | 'personal' | 'workspace'
  eligible: boolean
  requirements?: string[]
  missing?: string[]
  disabled?: boolean
  installOptions?: SkillInstallOption[]
  skillRequirements?: SkillRequirements
  configChecks?: { key: string; ok: boolean }[]
  skillKey?: string
  baseDir?: string
}

export type SkillAllowlistMode = 'all' | 'none' | 'selected'

// --- Fleet Sidebar Filters (F16) ---
export type FleetFilter = 'all' | 'running' | 'approvals'

// --- Exec Approval Config (F8) ---
export interface ExecApprovalConfig {
  security: 'deny' | 'allowlist' | 'full'
  askMode: 'off' | 'on-miss' | 'always'
  patterns: string[]
}

export interface ExecApprovalSnapshot {
  path: string
  exists: boolean
  hash: string
  file: ExecApprovalConfig
}

// --- Permission Presets (F9) ---
export type PermissionPreset = 'conservative' | 'collaborative' | 'autonomous'

// --- Personality Builder (F10) ---
export interface PersonalityDraft {
  identity: { name?: string; creature?: string; vibe?: string; emoji?: string }
  user: { name?: string; callThem?: string; pronouns?: string; timezone?: string; notes?: string; context?: string }
  soul: { coreTruths?: string; boundaries?: string; vibe?: string; continuity?: string }
}

// --- Skill Lifecycle (F11) ---
export interface SkillInstallOption {
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download'
  label: string
  bins?: string[]
}

export interface SkillRequirements {
  bins?: string[]
  anyBins?: string[][]
  env?: string[]
  config?: string[]
  os?: string[]
}

// --- Cron Jobs (F12) ---
export interface GatewayCronJob {
  id: string
  name: string
  agentId: string
  enabled: boolean
  schedule: { kind: 'at' | 'every' | 'cron'; value: string; timezone?: string }
  payload: {
    kind: 'systemEvent' | 'agentTurn'
    text?: string
    message?: string
    model?: string
    deliver?: { mode: 'none' | 'announce'; channel?: string }
  }
  sessionTarget: 'main' | 'isolated'
  state?: { nextRun?: string; lastRun?: string; lastStatus?: string }
}

// --- Rich Chat Traces (F13) ---
export interface ChatTraceBlock {
  type: 'thinking' | 'tool-call' | 'tool-result'
  content: string
  label?: string
  collapsed?: boolean
}

// --- Chat History Sync (F18) ---
export interface GatewaySessionPreview {
  sessionKey: string
  epoch: number
  messages: Array<{ role: string; content: string; ts: number }>
}

// --- Gateway Reload Mode (F21) ---
export type GatewayReloadMode = 'hot' | 'hybrid' | 'full'
