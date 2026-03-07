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
  thinking?: string
  kind?: 'chat' | 'heartbeat' | 'system' | 'context-clear' | 'plugin-ui'
  suppressed?: boolean
  bookmarked?: boolean
  suggestions?: string[]
  replyToId?: string
  source?: MessageSource
  /** True while the message is still being streamed — cleared on final persist. */
  streaming?: boolean
}

export type SessionResetMode = 'idle' | 'daily'
export type SessionResetType = 'direct' | 'group' | 'thread' | 'main'

export interface IdentityContinuityState {
  selfSummary?: string | null
  relationshipSummary?: string | null
  personaLabel?: string | null
  toneStyle?: string | null
  boundaries?: string[]
  continuityNotes?: string[]
  updatedAt?: number | null
}

export interface SessionArchiveState {
  memoryId?: string | null
  lastSyncedAt?: number | null
  lastHash?: string | null
  messageCount?: number
  exportPath?: string | null
}

export type ProviderType = 'claude-cli' | 'codex-cli' | 'opencode-cli' | 'openai' | 'ollama' | 'anthropic' | 'openclaw' | 'google' | 'deepseek' | 'groq' | 'together' | 'mistral' | 'xai' | 'fireworks'

export interface ProviderInfo {
  id: ProviderType
  name: string
  models: string[]
  defaultModels?: string[]
  supportsModelDiscovery?: boolean
  requiresApiKey: boolean
  optionalApiKey?: boolean
  requiresEndpoint: boolean
  defaultEndpoint?: string
}

export interface ProviderModelDiscoveryResult {
  ok: boolean
  providerId: string
  providerName?: string
  models: string[]
  cached: boolean
  fetchedAt: number
  cacheTtlMs: number
  supportsDiscovery: boolean
  missingCredential?: boolean
  message?: string
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
  shortcutForAgentId?: string | null
  cwd: string
  user: string
  provider: ProviderType
  model: string
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  routePreferredGatewayTags?: string[]
  routePreferredGatewayUseCase?: string | null
  claudeSessionId: string | null
  codexThreadId?: string | null
  opencodeSessionId?: string | null
  delegateResumeIds?: {
    claudeCode?: string | null
    codex?: string | null
    opencode?: string | null
    gemini?: string | null
  }
  messages: Message[]
  createdAt: number
  lastActiveAt: number
  active?: boolean
  sessionType?: SessionType
  agentId?: string | null
  parentSessionId?: string | null
  plugins?: string[]
  /** @deprecated Use `plugins` instead. Kept for backward compat with stored data. */
  tools?: string[]
  heartbeatEnabled?: boolean | null
  heartbeatIntervalSec?: number | null
  heartbeatTarget?: 'last' | 'none' | string | null
  sessionResetMode?: SessionResetMode | null
  sessionIdleTimeoutSec?: number | null
  sessionMaxAgeSec?: number | null
  sessionDailyResetAt?: string | null
  sessionResetTimezone?: string | null
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | null
  browserProfileId?: string | null
  connectorThinkLevel?: 'minimal' | 'low' | 'medium' | 'high' | null
  connectorSessionScope?: 'main' | 'channel' | 'peer' | 'channel-peer' | 'thread' | null
  connectorReplyMode?: 'off' | 'first' | 'all' | null
  connectorThreadBinding?: 'off' | 'prefer' | 'strict' | null
  connectorGroupPolicy?: 'open' | 'mention' | 'reply-or-mention' | 'disabled' | null
  connectorIdleTimeoutSec?: number | null
  connectorMaxAgeSec?: number | null
  mailbox?: MailboxEnvelope[] | null
  connectorContext?: {
    connectorId?: string | null
    platform?: ConnectorPlatform | null
    channelId?: string | null
    senderId?: string | null
    senderName?: string | null
    sessionKey?: string | null
    peerKey?: string | null
    scope?: 'main' | 'channel' | 'peer' | 'channel-peer' | 'thread' | null
    replyMode?: 'off' | 'first' | 'all' | null
    threadBinding?: 'off' | 'prefer' | 'strict' | null
    groupPolicy?: 'open' | 'mention' | 'reply-or-mention' | 'disabled' | null
    threadId?: string | null
    threadTitle?: string | null
    threadPersonaLabel?: string | null
    threadParentChannelId?: string | null
    threadParentChannelName?: string | null
    isGroup?: boolean
    lastInboundAt?: number | null
    lastInboundMessageId?: string | null
    lastInboundReplyToMessageId?: string | null
    lastInboundThreadId?: string | null
    lastOutboundAt?: number | null
    lastOutboundMessageId?: string | null
    lastResetAt?: number | null
    lastResetReason?: string | null
  }
  lastAutoMemoryAt?: number | null
  lastHeartbeatText?: string | null
  lastHeartbeatSentAt?: number | null
  lastSessionResetAt?: number | null
  lastSessionResetReason?: string | null
  identityState?: IdentityContinuityState | null
  sessionArchiveState?: SessionArchiveState | null
  pinned?: boolean
  file?: string | null
  queuedCount?: number
  currentRunId?: string | null
  conversationTone?: string
  emoji?: string
  creature?: string
  vibe?: string
  theme?: string
  avatar?: string
  canvasContent?: string | null
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
  | 'spawn_subagent'
  | 'canvas'
  | 'http_request'
  | 'git'
  | 'mailbox'
  | 'ask_human'
  | 'document'
  | 'extract'
  | 'table'
  | 'crawl'

// --- Approvals ---

export type ApprovalCategory = 'tool_access' | 'wallet_transfer' | 'plugin_scaffold' | 'plugin_install' | 'task_tool' | 'human_loop'

export interface ApprovalRequest {
  id: string
  category: ApprovalCategory
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
  title: string
  description?: string
  data: Record<string, unknown>
  createdAt: number
  updatedAt: number
  status: 'pending' | 'approved' | 'rejected'
  connectorNotification?: {
    attemptedAt?: number | null
    sentAt?: number | null
    connectorId?: string | null
    channelId?: string | null
    threadId?: string | null
    messageId?: string | null
    lastError?: string | null
  } | null
}

export type Approvals = Record<string, ApprovalRequest>

export type MailboxStatus = 'new' | 'ack'

export interface MailboxEnvelope {
  id: string
  type: string
  payload: string
  fromSessionId?: string | null
  fromAgentId?: string | null
  toSessionId: string
  toAgentId?: string | null
  correlationId?: string | null
  status: MailboxStatus
  createdAt: number
  expiresAt?: number | null
  ackAt?: number | null
}

export interface PluginInvocationRecord {
  pluginId: string
  toolName: string
  inputTokens: number
  outputTokens: number
}

export interface PluginDefinitionCost {
  pluginId: string
  estimatedTokens: number
}

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
  durationMs?: number
  pluginDefinitionCosts?: PluginDefinitionCost[]
  pluginInvocations?: PluginInvocationRecord[]
}

// --- Plugin System ---

export interface PluginHooks {
  beforeAgentStart?: (ctx: { session: Session; message: string }) => Promise<void> | void
  afterAgentComplete?: (ctx: { session: Session; response: string }) => Promise<void> | void
  beforeToolExec?: (ctx: { toolName: string; input: Record<string, unknown> | null }) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  afterToolExec?: (ctx: { session: Session; toolName: string; input: Record<string, unknown> | null; output: string }) => Promise<void> | void
  onMessage?: (ctx: { session: Session; message: Message }) => Promise<void> | void

  // Post-turn hook — fires after a full chat exchange (user message → agent response)
  afterChatTurn?: (ctx: { session: Session; message: string; response: string; source: string; internal: boolean }) => Promise<void> | void

  // Orchestration & Swarm Hooks
  onTaskComplete?: (ctx: { taskId: string; result: unknown }) => Promise<void> | void
  onAgentDelegation?: (ctx: { sourceAgentId: string; targetAgentId: string; task: string }) => Promise<void> | void

  // Chat Middleware (Transform messages)
  transformInboundMessage?: (ctx: { session: Session; text: string }) => Promise<string> | string
  transformOutboundMessage?: (ctx: { session: Session; text: string }) => Promise<string> | string

  // Context injection — return a markdown string to inject into the agent's state modifier, or null/undefined to skip
  getAgentContext?: (ctx: { session: Session; enabledPlugins: string[]; message: string; history: Message[] }) => Promise<string | null | undefined> | string | null | undefined

  // Self-description — returns a capability line for the system prompt (e.g., "I can remember things across conversations")
  getCapabilityDescription?: () => string | null | undefined

  // Operating guidance — returns operational hints for the agent when this plugin is active
  getOperatingGuidance?: () => string | string[] | null | undefined
}

export interface PluginToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx: { session: Session; message: string }) => Promise<string | object> | string | object
}

export interface PluginSettingsField {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'secret'
  placeholder?: string
  help?: string
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean
  required?: boolean
}

export interface PluginUIExtension {
  sidebarItems?: Array<{
    id: string
    label: string
    icon?: string
    href: string
    position?: 'top' | 'bottom'
  }>
  headerWidgets?: Array<{
    id: string
    label: string
    icon?: string
  }>
  chatInputActions?: Array<{
    id: string
    label: string
    icon?: string
    tooltip?: string
    action: 'message' | 'link' | 'tool'
    value: string
  }>
  /** Settings fields declared by the plugin, rendered in the plugin settings panel */
  settingsFields?: PluginSettingsField[]
  /** Chat panels the plugin provides (e.g., browser view, terminal) */
  chatPanels?: Array<{
    id: string
    label: string
    icon?: string
    /** WS topic to subscribe to for updates (e.g., 'browser:{sessionId}') */
    wsTopic?: string
  }>
  /** Badges to show on agent cards when this plugin is enabled */
  agentBadges?: Array<{
    id: string
    label: string
    icon?: string
  }>
}

export interface PluginProviderExtension {
  id: string
  name: string
  models: string[]
  requiresApiKey: boolean
  requiresEndpoint: boolean
  defaultEndpoint?: string
  streamChat: (opts: any) => Promise<string>
}

export interface PluginConnectorExtension {
  id: string
  name: string
  description: string
  // For sending outbound
  sendMessage?: (params: any) => Promise<any>
  // For polling/listening
  startListener?: (onMessage: (msg: any) => void) => Promise<() => void>
}

export interface Plugin {
  name: string
  version?: string
  description?: string
  author?: string
  openclaw?: boolean
  enabledByDefault?: boolean
  hooks?: PluginHooks
  tools?: PluginToolDef[]
  ui?: PluginUIExtension
  providers?: PluginProviderExtension[]
  connectors?: PluginConnectorExtension[]
}

export interface PluginMeta {
  name: string
  description?: string
  filename: string
  enabled: boolean
  isBuiltin?: boolean
  author?: string
  version?: string
  source?: 'local' | 'marketplace'
  openclaw?: boolean
  failureCount?: number
  lastFailureAt?: number
  lastFailureStage?: string
  lastFailureError?: string
  autoDisabled?: boolean
  toolCount?: number
  hookCount?: number
  hasUI?: boolean
  providerCount?: number
  connectorCount?: number
  createdByAgentId?: string | null
  settingsFields?: PluginSettingsField[]
  hasDependencyManifest?: boolean
  dependencyCount?: number
  devDependencyCount?: number
  packageManager?: PluginPackageManager
  dependencyInstallStatus?: PluginDependencyInstallStatus
  dependencyInstallError?: string
  dependencyInstalledAt?: number
}

export type PluginPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export type PluginDependencyInstallStatus = 'none' | 'ready' | 'installing' | 'installed' | 'error'

export interface MarketplacePlugin {
  id: string
  name: string
  description: string
  author: string
  version: string
  url: string
  source?: 'swarmclaw' | 'clawhub'
  tags?: string[]
  openclaw?: boolean
  downloads?: number
}

export interface SSEEvent {
  t: 'd' | 'md' | 'r' | 'done' | 'err' | 'tool_call' | 'tool_result' | 'status' | 'thinking' | 'cr_agent_start' | 'cr_agent_done'
  text?: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  agentId?: string
  agentName?: string
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
  identityState?: IdentityContinuityState | null
  emoji?: string
  creature?: string
  vibe?: string
  theme?: string
  avatar?: string
  systemPrompt: string
  provider: ProviderType
  model: string
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  preferredGatewayTags?: string[]
  preferredGatewayUseCase?: string | null
  routingStrategy?: AgentRoutingStrategy | null
  routingTargets?: AgentRoutingTarget[]
  isOrchestrator?: boolean
  subAgentIds?: string[]
  plugins?: string[]             // e.g. ['browser', 'memory'] — enabled plugin IDs
  /** @deprecated Use `plugins` instead. Kept for backward compat with stored data. */
  tools?: string[]
  skills?: string[]             // e.g. ['frontend-design'] — Claude Code skills to use
  skillIds?: string[]           // IDs of uploaded skills from the Skills manager
  mcpServerIds?: string[]       // IDs of configured MCP servers to inject tools from
  mcpDisabledTools?: string[]   // MCP tool names disabled for this agent (denylist)
  capabilities?: string[]       // e.g. ['frontend', 'screenshots', 'research', 'devops']
  threadSessionId?: string | null  // persistent shortcut chat session for agent-centric UI
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
  trashedAt?: number
  openclawSkillMode?: SkillAllowlistMode
  openclawAllowedSkills?: string[]
  walletId?: string | null
  monthlyBudget?: number | null
  dailyBudget?: number | null
  hourlyBudget?: number | null
  autoRecovery?: boolean

  budgetAction?: 'warn' | 'block'
  /** Runtime-enriched: current month's spend. Populated by GET /api/agents when monthlyBudget is set. */
  monthlySpend?: number
  /** Runtime-enriched: current day's spend. Populated by GET /api/agents when dailyBudget is set. */
  dailySpend?: number
  /** Runtime-enriched: trailing 1-hour spend. Populated by GET /api/agents when hourlyBudget is set. */
  hourlySpend?: number
  maxFollowupChain?: number
  createdAt: number
  updatedAt: number
}

// --- Agent Wallets ---

export type WalletChain = 'solana'

export interface AgentWallet {
  id: string
  agentId: string
  chain: WalletChain
  publicKey: string
  encryptedPrivateKey: string       // AES-256-GCM via encryptKey()
  label?: string
  spendingLimitLamports?: number    // per-tx cap (default 0.1 SOL = 100_000_000)
  dailyLimitLamports?: number       // 24h rolling cap (default 1 SOL = 1_000_000_000)
  requireApproval: boolean          // default true
  createdAt: number
  updatedAt: number
}

export type WalletTransactionType = 'send' | 'receive' | 'swap'
export type WalletTransactionStatus = 'pending_approval' | 'pending' | 'confirmed' | 'failed' | 'denied'

export interface WalletTransaction {
  id: string
  walletId: string
  agentId: string
  chain: WalletChain
  type: WalletTransactionType
  signature: string
  fromAddress: string
  toAddress: string
  amountLamports: number
  feeLamports?: number
  status: WalletTransactionStatus
  memo?: string                     // agent's reason for tx
  approvedBy?: 'user' | 'auto'
  tokenMint?: string                // null = native SOL
  timestamp: number
}

export interface WalletBalanceSnapshot {
  id: string
  walletId: string
  balanceLamports: number
  timestamp: number
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
  action?: string
  path?: string
  command?: string
  description?: string
  frequency?: string
  cron?: string
  intervalMs?: number
  runAt?: number
  lastRunAt?: number
  nextRunAt?: number
  status: ScheduleStatus
  linkedTaskId?: string | null
  runNumber?: number
  createdByAgentId?: string | null
  createdInSessionId?: string | null
  createdAt: number
  updatedAt?: number
}

export type BrowserSessionStatus = 'active' | 'idle' | 'closed' | 'error'

export interface BrowserSessionTab {
  index: number
  title?: string | null
  url?: string | null
}

export interface BrowserSessionArtifact {
  kind: 'snapshot' | 'screenshot' | 'download' | 'pdf'
  path: string
  url?: string | null
  filename?: string | null
  createdAt: number
}

export interface BrowserObservationLink {
  text: string
  href: string
}

export interface BrowserObservationFormField {
  name?: string | null
  label?: string | null
  type: string
  required?: boolean
}

export interface BrowserObservationForm {
  index: number
  action?: string | null
  method?: string | null
  fields: BrowserObservationFormField[]
}

export interface BrowserObservationTable {
  index: number
  headers: string[]
  rowCount: number
  rows?: string[][]
}

export interface BrowserObservation {
  capturedAt: number
  url?: string | null
  title?: string | null
  textPreview?: string | null
  activeTabIndex?: number | null
  tabs?: BrowserSessionTab[]
  links?: BrowserObservationLink[]
  forms?: BrowserObservationForm[]
  tables?: BrowserObservationTable[]
  errors?: string[]
}

export interface BrowserSessionRecord {
  id: string
  sessionId: string
  profileId: string
  profileDir: string
  status: BrowserSessionStatus
  inheritedFromSessionId?: string | null
  currentUrl?: string | null
  pageTitle?: string | null
  activeTabIndex?: number | null
  tabs?: BrowserSessionTab[]
  lastAction?: string | null
  lastError?: string | null
  lastObservation?: BrowserObservation | null
  artifacts?: BrowserSessionArtifact[]
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export type WatchJobType = 'time' | 'http' | 'file' | 'task' | 'webhook' | 'page' | 'email' | 'mailbox' | 'approval'
export type WatchJobStatus = 'active' | 'triggered' | 'failed' | 'cancelled'

export interface WatchJob {
  id: string
  type: WatchJobType
  status: WatchJobStatus
  description?: string | null
  sessionId?: string | null
  agentId?: string | null
  createdByAgentId?: string | null
  browserProfileId?: string | null
  resumeMessage: string
  target: Record<string, unknown>
  condition: Record<string, unknown>
  runAt?: number | null
  nextCheckAt?: number | null
  intervalMs?: number | null
  timeoutAt?: number | null
  lastCheckedAt?: number | null
  lastTriggeredAt?: number | null
  lastError?: string | null
  result?: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export type DelegationJobKind = 'subagent' | 'delegate'
export type DelegationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface DelegationJobCheckpoint {
  at: number
  note: string
  status?: DelegationJobStatus
}

export interface DelegationJobArtifact {
  type: 'text' | 'file' | 'image' | 'link'
  value: string
  label?: string | null
}

export interface DelegationJobRecord {
  id: string
  kind: DelegationJobKind
  status: DelegationJobStatus
  backend?: 'claude' | 'codex' | 'opencode' | 'gemini' | null
  parentSessionId?: string | null
  childSessionId?: string | null
  agentId?: string | null
  agentName?: string | null
  cwd?: string | null
  task: string
  result?: string | null
  resultPreview?: string | null
  error?: string | null
  checkpoints?: DelegationJobCheckpoint[]
  artifacts?: DelegationJobArtifact[]
  resumeId?: string | null
  resumeIds?: {
    claudeCode?: string | null
    codex?: string | null
    opencode?: string | null
    gemini?: string | null
  }
  createdAt: number
  updatedAt: number
  startedAt?: number | null
  completedAt?: number | null
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
  pinned?: boolean
  sharedWith?: string[]
  accessCount?: number
  lastAccessedAt?: number
  contentHash?: string
  reinforcementCount?: number
  createdAt: number
  updatedAt: number
}

export type SessionType = 'human'
export type AppView = 'home' | 'agents' | 'chatrooms' | 'schedules' | 'memory' | 'tasks' | 'approvals' | 'secrets' | 'providers' | 'skills' | 'connectors' | 'webhooks' | 'mcp_servers' | 'knowledge' | 'plugins' | 'usage' | 'wallets' | 'runs' | 'logs' | 'settings' | 'projects' | 'activity'

// --- Chatrooms ---

export interface ChatroomRoutingRule {
  id: string
  type: 'keyword' | 'capability'
  pattern?: string
  keywords?: string[]
  agentId: string
  priority: number
}

export interface ChatroomMember {
  agentId: string
  role: 'admin' | 'moderator' | 'member'
  mutedUntil?: string
}

export interface ChatroomReaction {
  emoji: string
  reactorId: string   // 'user' or agentId
  time: number
}

export interface ChatroomMessage {
  id: string
  senderId: string    // 'user' or agentId
  senderName: string
  role: 'user' | 'assistant'
  text: string
  mentions: string[]  // parsed agentIds
  reactions: ChatroomReaction[]
  toolEvents?: MessageToolEvent[]
  time: number
  attachedFiles?: string[]
  imagePath?: string
  replyToId?: string
  source?: MessageSource
}

export interface Chatroom {
  id: string
  name: string
  description?: string
  agentIds: string[]
  members?: ChatroomMember[]
  messages: ChatroomMessage[]
  pinnedMessageIds?: string[]
  chatMode?: 'sequential' | 'parallel'
  autoAddress?: boolean
  routingRules?: ChatroomRoutingRule[]
  createdAt: number
  updatedAt: number
}

// --- Activity / Audit Trail ---

export interface ActivityEntry {
  id: string
  entityType: 'agent' | 'task' | 'connector' | 'session' | 'webhook' | 'schedule'
  entityId: string
  action: 'created' | 'updated' | 'deleted' | 'started' | 'stopped' | 'queued' | 'completed' | 'failed' | 'approved' | 'rejected'
  actor: 'user' | 'agent' | 'system' | 'daemon'
  actorId?: string
  summary: string
  detail?: Record<string, unknown>
  timestamp: number
}

// --- Webhook Retry Queue ---

export interface WebhookRetryEntry {
  id: string
  webhookId: string
  event: string
  payload: string
  attempts: number
  maxAttempts: number
  nextRetryAt: number
  deadLettered: boolean
  createdAt: number
}

export interface Project {
  id: string
  name: string
  description: string
  color?: string
  createdAt: number
  updatedAt: number
}

// --- Notifications ---

export interface AppNotification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message?: string
  actionLabel?: string
  actionUrl?: string
  entityType?: string
  entityId?: string
  dedupKey?: string
  read: boolean
  createdAt: number
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
  delegationMaxDepth?: number
  ongoingLoopMaxIterations?: number
  ongoingLoopMaxRuntimeMinutes?: number
  maxFollowupChain?: number
  shellCommandTimeoutSec?: number
  claudeCodeTimeoutSec?: number
  cliProcessTimeoutSec?: number
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
  sessionResetMode?: SessionResetMode | null
  sessionIdleTimeoutSec?: number | null
  sessionMaxAgeSec?: number | null
  sessionDailyResetAt?: string | null
  sessionResetTimezone?: string | null
  // Task resiliency and supervision
  defaultTaskMaxAttempts?: number
  taskRetryBackoffSec?: number
  taskStallTimeoutMin?: number
  // Safety rails
  approvalsEnabled?: boolean
  safetyRequireApprovalForOutbound?: boolean
  approvalAutoApproveCategories?: ApprovalCategory[]
  approvalConnectorNotifyEnabled?: boolean
  approvalConnectorNotifyDelaySec?: number | null
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
  // Chat UX
  suggestionsEnabled?: boolean
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
  // Per-plugin settings (keyed by pluginId)
  pluginSettings?: Record<string, Record<string, unknown>>
}

// --- Agent Secrets ---

export interface OrchestratorSecret {
  id: string
  name: string
  service: string           // e.g. 'gmail', 'ahrefs', 'custom'
  encryptedValue: string
  scope: 'global' | 'agent'
  agentIds: string[]      // if scope === 'agent', which agents can use it
  createdAt: number
  updatedAt: number
}

// --- Task Board ---

export type BoardTaskStatus = 'backlog' | 'queued' | 'running' | 'completed' | 'failed' | 'archived'

export interface TaskComment {
  id: string
  author: string         // agent name or 'user'
  agentId?: string     // if from an agent
  text: string
  createdAt: number
}

export interface TaskQualityGateConfig {
  enabled?: boolean
  minResultChars?: number
  minEvidenceItems?: number
  requireVerification?: boolean
  requireArtifact?: boolean
  requireReport?: boolean
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

// --- Gateways ---

export type GatewayProvider = 'openclaw'
export type GatewayHealthState = 'unknown' | 'healthy' | 'degraded' | 'offline' | 'pending'
export type OpenClawDeploymentMethod = 'local' | 'bundle' | 'ssh' | 'imported'
export type OpenClawDeploymentProvider =
  | 'local'
  | 'hetzner'
  | 'digitalocean'
  | 'vultr'
  | 'linode'
  | 'lightsail'
  | 'gcp'
  | 'azure'
  | 'oci'
  | 'generic'
  | 'render'
  | 'fly'
  | 'railway'
export type OpenClawRemoteDeployTarget = 'docker' | 'render' | 'fly' | 'railway'
export type OpenClawUseCaseTemplate = 'local-dev' | 'single-vps' | 'private-tailnet' | 'browser-heavy' | 'team-control'
export type OpenClawExposurePreset = 'private-lan' | 'tailscale' | 'caddy' | 'nginx' | 'ssh-tunnel'

export interface OpenClawGatewayStats {
  nodeCount?: number
  connectedNodeCount?: number
  pendingNodePairings?: number
  pairedDeviceCount?: number
  pendingDevicePairings?: number
  externalRuntimeCount?: number
}

export interface OpenClawDeploymentConfig {
  method?: OpenClawDeploymentMethod | null
  provider?: OpenClawDeploymentProvider | null
  remoteTarget?: OpenClawRemoteDeployTarget | null
  useCase?: OpenClawUseCaseTemplate | null
  exposure?: OpenClawExposurePreset | null
  managedBy?: 'swarmclaw' | 'manual' | null
  targetHost?: string | null
  sshHost?: string | null
  sshUser?: string | null
  sshPort?: number | null
  sshKeyPath?: string | null
  sshTargetDir?: string | null
  image?: string | null
  version?: string | null
  lastDeployAt?: number | null
  lastDeployAction?: string | null
  lastDeployProcessId?: string | null
  lastDeploySummary?: string | null
  lastVerifiedAt?: number | null
  lastVerifiedOk?: boolean | null
  lastVerifiedMessage?: string | null
  lastBackupPath?: string | null
}

export interface GatewayProfile {
  id: string
  name: string
  provider: GatewayProvider
  endpoint: string
  wsUrl?: string | null
  credentialId?: string | null
  status: GatewayHealthState
  notes?: string | null
  tags?: string[]
  lastError?: string | null
  lastCheckedAt?: number | null
  lastModelCount?: number | null
  discoveredHost?: string | null
  discoveredPort?: number | null
  deployment?: OpenClawDeploymentConfig | null
  stats?: OpenClawGatewayStats | null
  isDefault?: boolean
  createdAt: number
  updatedAt: number
}

export interface OpenClawNode {
  nodeId: string
  displayName?: string
  platform?: string
  version?: string
  coreVersion?: string
  uiVersion?: string
  deviceFamily?: string
  modelIdentifier?: string
  remoteIp?: string
  caps?: string[]
  commands?: string[]
  pathEnv?: string[]
  permissions?: string[]
  connectedAtMs?: number
  paired?: boolean
  connected?: boolean
}

export interface OpenClawNodePairRequest {
  requestId: string
  nodeId?: string
  displayName?: string
  platform?: string
  remoteIp?: string
  createdAtMs?: number
}

export interface OpenClawPairedDevice {
  deviceId: string
  displayName?: string
  role?: string
  remoteIp?: string
  platform?: string
  tokens?: Array<{ role?: string; scopes?: string[]; createdAtMs?: number; rotatedAtMs?: number; revokedAtMs?: number }>
}

export interface OpenClawDevicePairRequest {
  requestId: string
  deviceId?: string
  displayName?: string
  role?: string
  platform?: string
  remoteIp?: string
  createdAtMs?: number
}

export interface OpenClawPairingSnapshot {
  pending?: OpenClawDevicePairRequest[]
  paired?: OpenClawPairedDevice[]
}

// --- Agent Routing / Packs ---

export type AgentRoutingStrategy = 'single' | 'balanced' | 'economy' | 'premium' | 'reasoning'
export type AgentRoutingTargetRole = 'primary' | 'economy' | 'premium' | 'reasoning' | 'backup'

export interface AgentRoutingTarget {
  id: string
  label?: string
  role?: AgentRoutingTargetRole
  provider: ProviderType
  model: string
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
  provider: ProviderType
  model: string
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  routingStrategy?: AgentRoutingStrategy | null
  routingTargets?: AgentRoutingTarget[]
  tools?: string[]
  plugins?: string[]
  capabilities?: string[]
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

export type ExternalAgentSourceType = 'codex' | 'claude' | 'opencode' | 'openclaw' | 'custom'
export type ExternalAgentStatus = 'online' | 'idle' | 'offline' | 'stale'

export interface ExternalAgentRuntime {
  id: string
  name: string
  sourceType: ExternalAgentSourceType
  status: ExternalAgentStatus
  provider?: ProviderType | null
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
  lastHeartbeatAt?: number | null
  lastSeenAt?: number | null
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
  scope?: 'global' | 'agent'
  agentIds?: string[]
  createdAt: number
  updatedAt: number
}

// --- Connector Health Events ---

export type ConnectorHealthEventType = 'started' | 'stopped' | 'error' | 'reconnected' | 'disconnected'

export interface ConnectorHealthEvent {
  id: string
  connectorId: string
  event: ConnectorHealthEventType
  message?: string
  timestamp: string
}

// --- Connectors (Chat Platform Bridges) ---

export type ConnectorPlatform = 'discord' | 'telegram' | 'slack' | 'whatsapp' | 'openclaw' | 'bluebubbles' | 'signal' | 'teams' | 'googlechat' | 'matrix' | 'email'
export type ConnectorStatus = 'stopped' | 'running' | 'error'

export interface MessageSource {
  platform: ConnectorPlatform
  connectorId: string
  connectorName: string
  channelId?: string
  senderId?: string
  senderName?: string
  messageId?: string
  replyToMessageId?: string
  threadId?: string
}

export interface Connector {
  id: string
  name: string
  platform: ConnectorPlatform
  agentId?: string | null        // which agent handles incoming messages (optional if using chatroomId)
  chatroomId?: string | null     // route to a chatroom instead of a single agent
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
  outputFiles?: string[]
  artifacts?: Array<{
    url: string
    type: 'image' | 'video' | 'pdf' | 'file'
    filename: string
  }>
  comments?: TaskComment[]
  images?: string[]
  createdByAgentId?: string | null
  createdInSessionId?: string | null
  delegatedByAgentId?: string | null
  delegatedFromTaskId?: string | null
  delegationDepth?: number | null
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
  geminiResumeId?: string | null
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
  // Task dependencies (DAG)
  blockedBy?: string[]
  blocks?: string[]
  // Task tags
  tags?: string[]
  // Due date
  dueAt?: number | null
  // Custom fields
  customFields?: Record<string, string | number | boolean>
  // Priority
  priority?: 'low' | 'medium' | 'high' | 'critical'
  // Dedup fingerprint
  fingerprint?: string
  qualityGate?: TaskQualityGateConfig | null
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
