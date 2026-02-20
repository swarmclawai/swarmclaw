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
  toolEvents?: MessageToolEvent[]
  kind?: 'chat' | 'heartbeat' | 'system'
}

export type ProviderType = 'claude-cli' | 'codex-cli' | 'opencode-cli' | 'openai' | 'ollama' | 'anthropic' | 'openclaw' | 'google' | 'deepseek' | 'groq' | 'together' | 'mistral' | 'xai' | 'fireworks'

export interface ProviderInfo {
  id: ProviderType
  name: string
  models: string[]
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
  sessionType?: SessionType
  agentId?: string | null
  parentSessionId?: string | null
  tools?: string[]
  heartbeatEnabled?: boolean | null
  heartbeatIntervalSec?: number | null
  file?: string | null
  queuedCount?: number
  currentRunId?: string | null
}

export type Sessions = Record<string, Session>

export type SessionTool = 'shell' | 'files' | 'claude_code' | 'web_search' | 'web_fetch' | 'edit_file' | 'process'

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
  t: 'd' | 'md' | 'r' | 'done' | 'err' | 'tool_call' | 'tool_result'
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
  platformAssignScope?: 'self' | 'all'  // defaults to 'self'
  heartbeatEnabled?: boolean
  heartbeatIntervalSec?: number | null
  heartbeatPrompt?: string | null
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
  taskPrompt: string
  scheduleType: ScheduleType
  cron?: string
  intervalMs?: number
  runAt?: number
  lastRunAt?: number
  nextRunAt?: number
  status: ScheduleStatus
  createdAt: number
}

export interface MemoryEntry {
  id: string
  agentId?: string | null
  sessionId?: string | null
  category: string
  title: string
  content: string
  metadata?: Record<string, string>
  createdAt: number
  updatedAt: number
}

export type SessionType = 'human' | 'orchestrated'
export type AppView = 'sessions' | 'agents' | 'schedules' | 'memory' | 'tasks' | 'secrets' | 'providers' | 'skills' | 'connectors' | 'logs'

// --- App Settings ---

export type LangGraphProvider = string
export type LoopMode = 'bounded' | 'ongoing'

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
  heartbeatActiveStart?: string | null
  heartbeatActiveEnd?: string | null
  heartbeatTimezone?: string | null
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

export type BoardTaskStatus = 'backlog' | 'queued' | 'running' | 'completed' | 'failed'

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
  description?: string
  sourceUrl?: string
  sourceFormat?: 'openclaw' | 'plain'
  createdAt: number
  updatedAt: number
}

// --- Connectors (Chat Platform Bridges) ---

export type ConnectorPlatform = 'discord' | 'telegram' | 'slack' | 'whatsapp'
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
  cwd?: string | null
  file?: string | null
  sessionId?: string | null
  result?: string | null
  error?: string | null
  comments?: TaskComment[]
  images?: string[]
  createdAt: number
  updatedAt: number
  queuedAt?: number | null
  startedAt?: number | null
  completedAt?: number | null
}
