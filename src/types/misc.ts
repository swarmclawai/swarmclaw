import type { MessageToolEvent } from './message'
import type { MessageSource } from './connector'
import type { ExtensionDefinitionCost, ExtensionInvocationRecord } from './extension'
import type { SkillInstallOption, SkillRequirements } from './skill'

export interface SSEEvent {
  t: 'd' | 'md' | 'r' | 'done' | 'err' | 'tool_call' | 'tool_result' | 'status' | 'thinking' | 'reset' | 'cr_agent_start' | 'cr_agent_done'
  text?: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolCallId?: string
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
  agentId?: string | null
  projectId?: string | null
  extensionDefinitionCosts?: ExtensionDefinitionCost[]
  extensionInvocations?: ExtensionInvocationRecord[]
}

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
  targetAgentId?: string
  source?: MessageSource
  historyExcluded?: boolean
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
  routingGuidance?: string | null
  /** Legacy deterministic routing config kept only for migration/read compatibility. */
  routingRules?: ChatroomRoutingRule[]
  temporary?: boolean
  topic?: string
  hidden?: boolean
  archivedAt?: number | null
  protocolRunId?: string | null
  parentChatroomId?: string | null
  createdAt: number
  updatedAt: number
}

// --- Activity / Audit Trail ---

export interface ActivityEntry {
  id: string
  entityType: 'agent' | 'task' | 'connector' | 'session' | 'webhook' | 'schedule' | 'delegation' | 'swarm' | 'chatroom' | 'coordination' | 'approval' | 'settings' | 'budget' | 'credential'
  entityId: string
  action: 'created' | 'updated' | 'deleted' | 'started' | 'stopped' | 'queued' | 'completed' | 'failed' | 'archived' | 'restored' | 'approved' | 'rejected' | 'delegated' | 'queried' | 'spawned' | 'timeout' | 'cancelled' | 'incident' | 'running' | 'claimed' | 'configured' | 'budget_exceeded' | 'budget_warning'
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
  objective?: string
  audience?: string
  priorities?: string[]
  openObjectives?: string[]
  capabilityHints?: string[]
  credentialRequirements?: string[]
  successMetrics?: string[]
  heartbeatPrompt?: string
  heartbeatIntervalSec?: number
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
  updatedAt?: number
  occurrenceCount?: number
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

// --- Agent Secrets ---

export interface StoredSecret {
  id: string
  name: string
  service: string           // e.g. 'gmail', 'ahrefs', 'custom'
  encryptedValue: string
  scope: 'global' | 'agent'
  agentIds: string[]      // if scope === 'agent', which agents can use it
  projectId?: string
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

export interface DocumentRevision {
  id: string
  documentId: string
  version: number
  content: string
  createdAt: number
  createdBy?: string | null
}

export interface DocumentEntry {
  id: string
  title: string
  fileName: string
  sourcePath: string
  content: string
  method: string
  textLength: number
  currentVersion?: number
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

// --- Browser Sessions ---

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

export interface BrowserSandboxRuntimeInfo {
  scopeKey?: string | null
  containerName?: string | null
  cdpEndpoint?: string | null
  cdpPort?: number | null
  noVncPort?: number | null
  bridgeUrl?: string | null
}

export interface BrowserSessionRecord {
  id: string
  sessionId: string
  profileId: string
  profileDir: string
  status: BrowserSessionStatus
  runtime?: 'host' | 'sandbox-browser' | null
  sandbox?: BrowserSandboxRuntimeInfo | null
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

// --- Watch Jobs ---

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

// --- Delegation Jobs ---

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
  requesterRunId?: string | null
  childRunId?: string | null
  createdAt: number
  updatedAt: number
  startedAt?: number | null
  completedAt?: number | null
}

// --- File & Memory References ---

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
  abstract?: string | null
  createdAt: number
  updatedAt: number
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
  localInstanceId?: string | null
  localPort?: number | null
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

// --- ClawHub ---

export interface ClawHubSkill {
  id: string
  name: string
  description: string
  author: string
  tags: string[]
  downloads: number
  stars?: number
  url: string
  version: string
  changelog?: string
  createdAt?: number
  updatedAt?: number
  metadata?: Record<string, unknown> | null
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
