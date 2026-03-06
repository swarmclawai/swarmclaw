import { genId } from '@/lib/id'
import { loadApprovals, upsertApproval, loadSessions, saveSessions, loadSettings, loadAgents } from './storage'
import type { ApprovalRequest, ApprovalCategory, Message } from '@/types'
import { notify } from './ws-hub'
import { log } from './logger'

const AUTO_APPROVABLE_CATEGORIES: ApprovalCategory[] = [
  'tool_access',
  'wallet_transfer',
  'plugin_scaffold',
  'plugin_install',
  'task_tool',
  'human_loop',
]
const DEFAULT_APPROVAL_CONNECTOR_NOTIFY_DELAY_SEC = 300
const MIN_APPROVAL_CONNECTOR_NOTIFY_DELAY_SEC = 30
const MAX_APPROVAL_CONNECTOR_NOTIFY_DELAY_SEC = 86_400
const APPROVAL_CONNECTOR_NOTIFY_RETRY_COOLDOWN_MS = 10 * 60 * 1000

interface RunningConnectorSummary {
  id: string
  agentId: string | null
  supportsSend: boolean
  configuredTargets: string[]
  recentChannelId: string | null
}

export interface PendingApprovalConnectorNotification {
  approvalId: string
  connectorId: string
  channelId: string
  threadId?: string | null
  text: string
}

function trimToString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clampApprovalConnectorNotifyDelaySec(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_APPROVAL_CONNECTOR_NOTIFY_DELAY_SEC
  return Math.max(
    MIN_APPROVAL_CONNECTOR_NOTIFY_DELAY_SEC,
    Math.min(MAX_APPROVAL_CONNECTOR_NOTIFY_DELAY_SEC, Math.trunc(parsed)),
  )
}

function getApprovalConnectorNotifySettings(): { enabled: boolean; delayMs: number } {
  const settings = loadSettings()
  const enabled = settings.approvalConnectorNotifyEnabled !== false
  const delaySec = clampApprovalConnectorNotifyDelaySec(settings.approvalConnectorNotifyDelaySec)
  return {
    enabled,
    delayMs: delaySec * 1000,
  }
}

function approvalsAreDisabled(): boolean {
  return loadSettings().approvalsEnabled === false
}

function getMessageSourceConnectorTarget(
  message: Record<string, unknown> | null | undefined,
  runningById: Map<string, RunningConnectorSummary>,
): { connectorId: string; channelId: string; threadId?: string | null } | null {
  const source = message?.source as Record<string, unknown> | undefined
  const connectorId = trimToString(source?.connectorId)
  const channelId = trimToString(source?.channelId)
  if (!connectorId || !channelId) return null
  const runtime = runningById.get(connectorId)
  if (!runtime?.supportsSend) return null
  const threadId = trimToString(source?.threadId)
  return {
    connectorId,
    channelId,
    ...(threadId ? { threadId } : {}),
  }
}

function getSessionConnectorTarget(
  session: Record<string, unknown> | null | undefined,
  runningById: Map<string, RunningConnectorSummary>,
): { connectorId: string; channelId: string; threadId?: string | null } | null {
  const context = session?.connectorContext as Record<string, unknown> | undefined
  const connectorId = trimToString(context?.connectorId)
  const channelId = trimToString(context?.channelId)
  if (connectorId && channelId) {
    const runtime = runningById.get(connectorId)
    if (runtime?.supportsSend) {
      const threadId = trimToString(context?.threadId)
      return {
        connectorId,
        channelId,
        ...(threadId ? { threadId } : {}),
      }
    }
  }

  const messages = Array.isArray(session?.messages) ? session.messages as Record<string, unknown>[] : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (trimToString(message?.role) !== 'user') continue
    const target = getMessageSourceConnectorTarget(message, runningById)
    if (target) return target
  }
  return null
}

function getMostRecentAgentSessionConnectorTarget(
  agentId: string,
  runningById: Map<string, RunningConnectorSummary>,
): { connectorId: string; channelId: string; threadId?: string | null } | null {
  const sessions = loadSessions()
  const candidates = Object.values(sessions) as Record<string, unknown>[]
  let best: { score: number; target: { connectorId: string; channelId: string; threadId?: string | null } } | null = null

  for (const session of candidates) {
    if (trimToString(session?.agentId) !== agentId) continue
    const target = getSessionConnectorTarget(session, runningById)
    if (!target) continue
    const context = session.connectorContext as Record<string, unknown> | undefined
    const score = typeof context?.lastInboundAt === 'number'
      ? context.lastInboundAt
      : typeof session.lastActiveAt === 'number'
        ? session.lastActiveAt
        : 0
    if (!best || score > best.score) best = { score, target }
  }

  return best?.target || null
}

function getAgentRunningConnectorFallback(
  agentId: string,
  runningConnectors: RunningConnectorSummary[],
): { connectorId: string; channelId: string } | null {
  const match = runningConnectors.find((entry) => entry.agentId === agentId && entry.supportsSend && trimToString(entry.recentChannelId))
  if (!match) return null
  return {
    connectorId: match.id,
    channelId: trimToString(match.recentChannelId),
  }
}

function buildApprovalConnectorReminderText(request: ApprovalRequest): string {
  const agents = loadAgents()
  const agentName = request.agentId && agents[request.agentId]?.name
    ? agents[request.agentId].name
    : 'Your agent'
  const ageMin = Math.max(1, Math.round((Date.now() - request.createdAt) / 60_000))
  const lines = [
    `${agentName} is waiting for your approval in SwarmClaw.`,
    `Request: ${request.title}`,
  ]
  const description = trimToString(request.description)
  if (description) lines.push(`Details: ${description.slice(0, 500)}`)
  lines.push(`Pending for about ${ageMin} minute${ageMin === 1 ? '' : 's'}.`)
  lines.push('Open the Approvals panel to approve or reject it.')
  return lines.join('\n')
}

function buildApprovalChatMessage(request: ApprovalRequest): string {
  const targetId = getApprovalTargetId(request.data)
  switch (request.category) {
    case 'tool_access':
      return JSON.stringify({
        type: 'plugin_request',
        approvalId: request.id,
        pluginId: targetId || '',
        toolId: targetId || '',
        reason: trimToString(request.description),
        message: `Plugin access request sent to user for "${targetId || 'requested tool'}". Once granted, I'll automatically continue.`,
      })
    case 'plugin_scaffold':
      return JSON.stringify({
        type: 'plugin_scaffold_request',
        approvalId: request.id,
        filename: trimToString(request.data.filename),
        message: `I've submitted a request to create plugin "${trimToString(request.data.filename) || 'plugin.js'}". The user needs to approve it via the Approvals page or the approval card in chat. Once approved, the plugin file will be written automatically — no need to call this tool again.`,
      })
    case 'plugin_install':
      return JSON.stringify({
        type: 'plugin_install_request',
        approvalId: request.id,
        url: trimToString(request.data.url),
        pluginId: trimToString(request.data.pluginId),
        reason: trimToString(request.description),
        message: `I'm requesting to install a new plugin${trimToString(request.data.url) ? ` from ${trimToString(request.data.url)}` : ''}. This will add new capabilities to the platform.`,
      })
    case 'wallet_transfer':
      return JSON.stringify({
        type: 'plugin_wallet_transfer_request',
        approvalId: request.id,
        amountSol: request.data.amountSol,
        toAddress: trimToString(request.data.toAddress),
        memo: trimToString(request.data.memo),
        message: `I'm requesting to send ${request.data.amountSol ?? 'funds'} to ${trimToString(request.data.toAddress) || 'the specified address'}. Please approve this transaction.`,
      })
    default: {
      const lines = [
        `[Approval requested] ${request.title}`,
      ]
      const description = trimToString(request.description)
      if (description) lines.push(`Details: ${description}`)
      lines.push('Approve or reject this request in the chat approval card or the Approvals panel.')
      return lines.join('\n')
    }
  }
}

function pushApprovalRequestMessage(request: ApprovalRequest): void {
  const sessionId = trimToString(request.sessionId)
  if (!sessionId) return
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) return

  const text = buildApprovalChatMessage(request)
  const recentMessages: Message[] = Array.isArray(session.messages) ? session.messages.slice(-6) : []
  if (recentMessages.some((message) => message?.role === 'assistant' && message?.text === text)) {
    return
  }

  session.messages = Array.isArray(session.messages) ? session.messages : []
  session.messages.push({
    role: 'assistant',
    text,
    time: Date.now(),
    kind: 'system',
  })
  session.lastActiveAt = Date.now()
  sessions[sessionId] = session
  saveSessions(sessions)
  notify(`messages:${sessionId}`)
}

function persistApprovalConnectorNotification(
  id: string,
  mutate: (request: ApprovalRequest) => void,
): ApprovalRequest | null {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  const request = approvals[id]
  if (!request) return null
  mutate(request)
  upsertApproval(id, request)
  return request
}

function getApprovalTargetId(data: Record<string, unknown>): string | null {
  const toolId = typeof data.toolId === 'string' ? data.toolId.trim() : ''
  if (toolId) return toolId
  const pluginId = typeof data.pluginId === 'string' ? data.pluginId.trim() : ''
  return pluginId || null
}

export function requestApproval(params: {
  category: ApprovalCategory
  title: string
  description?: string
  data: Record<string, unknown>
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
}): ApprovalRequest {
  const targetId = getApprovalTargetId(params.data)
  if (params.category === 'tool_access' && !targetId) {
    throw new Error('tool_access approvals require a toolId or pluginId')
  }

  const normalizedData = { ...params.data }
  if (params.category === 'tool_access' && targetId) {
    normalizedData.toolId = targetId
    normalizedData.pluginId = targetId
  }

  const id = genId(8)
  const now = Date.now()
  const request: ApprovalRequest = {
    id,
    ...params,
    title: params.category === 'tool_access' && targetId ? `Enable Plugin: ${targetId}` : params.title,
    data: normalizedData,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }

  upsertApproval(id, request)

  notify('approvals')
  return request
}

export function listAutoApprovableApprovalCategories(): ApprovalCategory[] {
  return [...AUTO_APPROVABLE_CATEGORIES]
}

export function isApprovalCategoryAutoApproved(category: ApprovalCategory): boolean {
  const configured = Array.isArray(loadSettings().approvalAutoApproveCategories)
    ? loadSettings().approvalAutoApproveCategories
    : []
  return configured.includes(category)
}

async function applyApprovedSideEffects(request: ApprovalRequest): Promise<void> {
  if (request.category === 'tool_access' && request.sessionId) {
    const sessions = loadSessions()
    const session = sessions[request.sessionId]
    if (session) {
      const toolId = getApprovalTargetId(request.data)
      const currentTools = session.plugins || []
      if (toolId && !currentTools.includes(toolId)) {
        session.plugins = [...currentTools, toolId]
        saveSessions(sessions)
      }
    }
  }

  if (request.category === 'plugin_scaffold') {
    const filename = typeof request.data.filename === 'string' ? request.data.filename : ''
    const code = typeof request.data.code === 'string' ? request.data.code : ''
    if (filename && code) {
      const { getPluginManager } = await import('./plugins')
      const manager = getPluginManager()

      const createdByAgentId = typeof request.data.createdByAgentId === 'string' ? request.data.createdByAgentId : request.agentId
      try {
        await manager.savePluginSource(filename, code, {
          packageJson: request.data.packageJson,
          packageManager: typeof request.data.packageManager === 'string' ? request.data.packageManager : undefined,
          installDependencies: request.data.packageJson !== undefined,
          meta: createdByAgentId ? { createdByAgentId } : undefined,
        })
      } catch (err: unknown) {
        log.error('approvals', 'Plugin scaffold dependency setup failed', {
          filename,
          error: err instanceof Error ? err.message : String(err),
        })
        await manager.savePluginSource(filename, code, {
          meta: createdByAgentId ? { createdByAgentId } : undefined,
        })
      }
      log.info('approvals', `Plugin scaffolded: ${filename}`)

      if (request.sessionId) {
        const sessions = loadSessions()
        const session = sessions[request.sessionId]
        if (session) {
          const currentTools = session.plugins || []
          if (!currentTools.includes(filename)) {
            session.plugins = [...currentTools, filename]
            saveSessions(sessions)
          }
        }
      }
      notify('plugins')
    }
  }

  if (request.category === 'plugin_install') {
    const url = typeof request.data.url === 'string' ? request.data.url : ''
    const filename = typeof request.data.filename === 'string' ? request.data.filename : ''
    if (url) {
      try {
        const pluginId = typeof request.data.pluginId === 'string' ? request.data.pluginId : ''
        const safeName = (pluginId || url.split('/').pop() || 'plugin').replace(/[^a-zA-Z0-9._-]/g, '_')
        const resolvedFilename = safeName.endsWith('.js') || safeName.endsWith('.mjs') ? safeName : `${safeName}.js`
        const { getPluginManager } = await import('./plugins')
        await getPluginManager().installPluginFromUrl(url, resolvedFilename, {
          createdByAgentId: typeof request.data.createdByAgentId === 'string' ? request.data.createdByAgentId : request.agentId || undefined,
        })
        log.info('approvals', `Plugin installed from URL: ${resolvedFilename}`)
        notify('plugins')
      } catch (err: unknown) {
        log.error('approvals', 'Plugin install failed after approval', {
          url,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else if (filename) {
      try {
        const { getPluginManager } = await import('./plugins')
        const manager = getPluginManager()
        if (request.data.packageJson !== undefined) {
          const source = manager.readPluginSource(filename)
          await manager.savePluginSource(filename, source, {
            packageJson: request.data.packageJson,
            packageManager: typeof request.data.packageManager === 'string' ? request.data.packageManager : undefined,
          })
        }
        await manager.installPluginDependencies(filename, {
          packageManager: typeof request.data.packageManager === 'string'
            ? request.data.packageManager as import('@/types').PluginPackageManager
            : undefined,
        })
        notify('plugins')
      } catch (err: unknown) {
        log.error('approvals', 'Plugin dependency install failed after approval', {
          filename,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}

async function persistApprovalDecision(request: ApprovalRequest, approved: boolean): Promise<ApprovalRequest> {
  request.status = approved ? 'approved' : 'rejected'
  request.updatedAt = Date.now()
  upsertApproval(request.id, request)

  if (approved) {
    await applyApprovedSideEffects(request)
  }

  notify('approvals')
  import('./watch-jobs')
    .then(({ triggerApprovalWatchJobs }) => {
      triggerApprovalWatchJobs({
        approvalId: request.id,
        status: approved ? 'approved' : 'rejected',
        title: request.title,
        description: request.description,
      })
    })
    .catch(() => {
      // best-effort trigger only
    })
  if (request.sessionId) notify(`session:${request.sessionId}`)
  return request
}

export async function requestApprovalMaybeAutoApprove(params: {
  category: ApprovalCategory
  title: string
  description?: string
  data: Record<string, unknown>
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
}): Promise<ApprovalRequest> {
  const request = requestApproval(params)
  if (!approvalsAreDisabled() && !isApprovalCategoryAutoApproved(request.category)) {
    pushApprovalRequestMessage(request)
    return request
  }
  return persistApprovalDecision(request, true)
}


export async function submitDecision(id: string, approved: boolean): Promise<void> {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  const request = approvals[id]
  if (!request) throw new Error('Approval request not found')
  await persistApprovalDecision(request, approved)
}

export function listPendingApprovalsNeedingConnectorNotification(params?: {
  now?: number
  runningConnectors?: RunningConnectorSummary[]
}): PendingApprovalConnectorNotification[] {
  const { enabled, delayMs } = getApprovalConnectorNotifySettings()
  if (!enabled) return []

  const now = typeof params?.now === 'number' ? params.now : Date.now()
  const runningConnectors = Array.isArray(params?.runningConnectors) ? params.runningConnectors : []
  const runningById = new Map(
    runningConnectors
      .filter((entry) => entry?.id && entry.supportsSend)
      .map((entry) => [entry.id, entry] as const),
  )

  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  const sessions = loadSessions()
  const out: PendingApprovalConnectorNotification[] = []

  for (const request of Object.values(approvals)) {
    if (request.status !== 'pending') continue
    if ((now - request.createdAt) < delayMs) continue
    if (request.connectorNotification?.sentAt) continue
    const lastAttemptAt = request.connectorNotification?.attemptedAt || 0
    if (lastAttemptAt > 0 && (now - lastAttemptAt) < APPROVAL_CONNECTOR_NOTIFY_RETRY_COOLDOWN_MS) continue

    let target: { connectorId: string; channelId: string; threadId?: string | null } | null = null
    if (request.sessionId) {
      target = getSessionConnectorTarget(sessions[request.sessionId] as Record<string, unknown> | undefined, runningById)
    }
    if (!target && request.agentId) {
      target = getMostRecentAgentSessionConnectorTarget(request.agentId, runningById)
    }
    if (!target && request.agentId) {
      target = getAgentRunningConnectorFallback(request.agentId, runningConnectors)
    }
    if (!target) continue

    out.push({
      approvalId: request.id,
      connectorId: target.connectorId,
      channelId: target.channelId,
      ...(target.threadId ? { threadId: target.threadId } : {}),
      text: buildApprovalConnectorReminderText(request),
    })
  }

  return out
}

export function markApprovalConnectorNotificationAttempt(id: string, params: {
  at?: number
  connectorId?: string | null
  channelId?: string | null
  threadId?: string | null
  lastError?: string | null
}): ApprovalRequest | null {
  return persistApprovalConnectorNotification(id, (request) => {
    request.connectorNotification = {
      ...(request.connectorNotification || {}),
      attemptedAt: typeof params.at === 'number' ? params.at : Date.now(),
      connectorId: params.connectorId ?? request.connectorNotification?.connectorId ?? null,
      channelId: params.channelId ?? request.connectorNotification?.channelId ?? null,
      threadId: params.threadId ?? request.connectorNotification?.threadId ?? null,
      lastError: params.lastError ?? request.connectorNotification?.lastError ?? null,
    }
  })
}

export function markApprovalConnectorNotificationSent(id: string, params: {
  at?: number
  connectorId: string
  channelId: string
  threadId?: string | null
  messageId?: string | null
}): ApprovalRequest | null {
  return persistApprovalConnectorNotification(id, (request) => {
    request.connectorNotification = {
      ...(request.connectorNotification || {}),
      attemptedAt: typeof params.at === 'number' ? params.at : Date.now(),
      sentAt: typeof params.at === 'number' ? params.at : Date.now(),
      connectorId: params.connectorId,
      channelId: params.channelId,
      threadId: params.threadId ?? request.connectorNotification?.threadId ?? null,
      messageId: params.messageId ?? request.connectorNotification?.messageId ?? null,
      lastError: null,
    }
  })
}

export function listPendingApprovals(): ApprovalRequest[] {
  const approvals = loadApprovals() as Record<string, ApprovalRequest>
  return Object.values(approvals)
    .filter(a => a.status === 'pending')
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
