import fs from 'node:fs'
import path from 'node:path'
import type { BoardTask, Connector, MessageToolEvent } from '@/types'
import { normalizeWhatsappTarget } from '@/lib/server/connectors/response-media'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import { loadConnectors } from '@/lib/server/connectors/connector-repository'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { loadSessions } from '@/lib/server/sessions/session-repository'
import { UPLOAD_DIR } from '@/lib/server/upload-path'
import { errorMessage } from '@/lib/shared-utils'
import { isMainSession } from '@/lib/server/agents/main-agent-loop'
import { log } from '@/lib/server/logger'
import { getMessages } from '@/lib/server/messages/message-repository'

const TAG = 'task-followups'

export { normalizeWhatsappTarget }

export interface SessionMessageLike {
  role?: string
  text?: string
  time?: number
  kind?: string
  historyExcluded?: boolean
  source?: {
    connectorId?: string
    channelId?: string
    threadId?: string
  }
  toolEvents?: Array<{ name?: string; output?: string }>
  streaming?: boolean
  imageUrl?: string
}

export interface SessionLike {
  id?: string
  name?: string
  user?: string
  cwd?: string
  agentId?: string | null
  messages?: SessionMessageLike[]
  connectorContext?: {
    connectorId?: string | null
    channelId?: string | null
    threadId?: string | null
    senderId?: string | null
    senderName?: string | null
    isOwnerConversation?: boolean | null
  }
  lastActiveAt?: number
  heartbeatEnabled?: boolean | null
  active?: boolean
  currentRunId?: string | null
}

export interface ScheduleTaskMeta extends BoardTask {
  user?: string | null
  createdInSessionId?: string | null
}

export interface RunningConnectorLike {
  id: string
  platform: string
  agentId: string | null
  supportsSend: boolean
  configuredTargets: string[]
  recentChannelId: string | null
}

export interface ConnectorTaskFollowupTarget {
  connectorId: string
  channelId: string
  threadId?: string | null
}

const CONNECTOR_DELIVERY_STATUSES = new Set(['sent', 'voice_sent'])

function isEnabledFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'on'
    || normalized === 'enabled'
}

export function fillTaskFollowupTemplate(template: string, data: {
  status: string
  title: string
  summary: string
  taskId: string
}): string {
  return template
    .replaceAll('{status}', data.status)
    .replaceAll('{title}', data.title)
    .replaceAll('{summary}', data.summary)
    .replaceAll('{taskId}', data.taskId)
}

export function maybeResolveUploadMediaPathFromUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith('/api/uploads/')) return undefined
  const rawName = url.slice('/api/uploads/'.length).split(/[?#]/)[0] || ''
  let decoded: string
  try { decoded = decodeURIComponent(rawName) } catch { decoded = rawName }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safeName) return undefined
  const fullPath = path.join(UPLOAD_DIR, safeName)
  return fs.existsSync(fullPath) ? fullPath : undefined
}

const OUTPUT_FILE_BACKTICK_RE = /`([^`\n]+\.(?:txt|md|json|csv|pdf|png|jpe?g|webp|gif|svg|mp4|webm|mov|zip|tar|gz|log|yml|yaml|xml|html|css|js|ts|tsx|jsx|py|go|rs|java|swift|kt|sql))`/gi
const OUTPUT_FILE_PATH_RE = /\b((?:\.{1,2}\/|~\/|\/)?[\w./-]+\.(?:txt|md|json|csv|pdf|png|jpe?g|webp|gif|svg|mp4|webm|mov|zip|tar|gz|log|yml|yaml|xml|html|css|js|ts|tsx|jsx|py|go|rs|java|swift|kt|sql))\b/gi
const MAX_CONNECTOR_ATTACHMENT_BYTES = 25 * 1024 * 1024

export function extractLikelyOutputFiles(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const value = raw.trim().replace(/^['"]|['"]$/g, '')
    if (!value || /^https?:\/\//i.test(value)) return
    if (value.startsWith('/api/uploads/')) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(value)
  }

  for (const match of text.matchAll(OUTPUT_FILE_BACKTICK_RE)) {
    push(match[1] || '')
    if (out.length >= 8) return out
  }
  for (const match of text.matchAll(OUTPUT_FILE_PATH_RE)) {
    push(match[1] || '')
    if (out.length >= 8) return out
  }

  return out
}

export function resolveExistingOutputFilePath(fileRef: string, cwd: string): string | null {
  const ref = (fileRef || '').trim()
  if (!ref) return null
  if (ref.startsWith('/api/uploads/')) {
    return maybeResolveUploadMediaPathFromUrl(ref) || null
  }
  const withoutFileScheme = ref.replace(/^file:\/\//i, '')
  const candidates = path.isAbsolute(withoutFileScheme)
    ? [withoutFileScheme]
    : [
        cwd ? path.resolve(cwd, withoutFileScheme) : '',
        path.resolve(WORKSPACE_DIR, withoutFileScheme),
      ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // ignore missing candidate
    }
  }
  return null
}

export function isSendableAttachment(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size <= MAX_CONNECTOR_ATTACHMENT_BYTES
  } catch {
    return false
  }
}

export function resolveTaskOriginConnectorFollowupTarget(params: {
  task: BoardTask
  sessions: Record<string, SessionLike>
  connectors: Record<string, Connector>
  running: RunningConnectorLike[]
}): ConnectorTaskFollowupTarget | null {
  const { task, sessions, connectors, running } = params
  const metaTask = task as ScheduleTaskMeta
  const delegatedByAgentId = typeof metaTask.delegatedByAgentId === 'string'
    ? metaTask.delegatedByAgentId.trim()
    : ''
  const allowedOwners = new Set([task.agentId, delegatedByAgentId].filter(Boolean))
  const sourceSessionId = typeof metaTask.createdInSessionId === 'string'
    ? metaTask.createdInSessionId.trim()
    : ''

  const runningById = new Map<string, RunningConnectorLike>()
  for (const entry of running) {
    if (!entry?.id) continue
    runningById.set(entry.id, entry)
  }

  const normalizeTarget = (raw: {
    connectorId?: string | null
    channelId?: string | null
    threadId?: string | null
  }): ConnectorTaskFollowupTarget | null => {
    const connectorId = typeof raw.connectorId === 'string' ? raw.connectorId.trim() : ''
    if (!connectorId) return null
    const connector = connectors[connectorId]
    if (!connector) return null
    const ownerId = typeof connector.agentId === 'string' ? connector.agentId.trim() : ''
    if (ownerId && !allowedOwners.has(ownerId)) return null

    const runtime = runningById.get(connectorId)
    if (runtime && !runtime.supportsSend) return null

    const channelId = typeof raw.channelId === 'string' ? raw.channelId.trim() : ''
    if (!channelId) return null
    const normalizedChannelId = connector.platform === 'whatsapp'
      ? normalizeWhatsappTarget(channelId)
      : channelId
    const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : ''
    return {
      connectorId,
      channelId: normalizedChannelId,
      ...(threadId ? { threadId } : {}),
    }
  }

  const resolveMainSessionOwnerTarget = (preferredConnectorId?: string | null): ConnectorTaskFollowupTarget | null => {
    if (!sourceSessionId) return null
    const sourceSession = sessions[sourceSessionId]
    if (!sourceSession || isDirectConnectorSession(sourceSession)) return null
    if (!isMainSession(sourceSession)) return null

    const ownerSessionTarget = normalizeTarget({
      connectorId: typeof sourceSession.connectorContext?.connectorId === 'string'
        ? sourceSession.connectorContext.connectorId
        : null,
      channelId: typeof sourceSession.connectorContext?.channelId === 'string'
        ? sourceSession.connectorContext.channelId
        : null,
      threadId: typeof sourceSession.connectorContext?.threadId === 'string'
        ? sourceSession.connectorContext.threadId
        : null,
    })
    if (sourceSession.connectorContext?.isOwnerConversation === true && ownerSessionTarget) {
      return ownerSessionTarget
    }

    const connectorId = typeof preferredConnectorId === 'string' ? preferredConnectorId.trim() : ''
    if (!connectorId) return null
    const connector = connectors[connectorId]
    if (!connector) return null

    const ownerChannelIdRaw = typeof connector.config?.ownerSenderId === 'string' && connector.config.ownerSenderId.trim()
      ? connector.config.ownerSenderId.trim()
      : typeof connector.config?.outboundJid === 'string' && connector.config.outboundJid.trim()
        ? connector.config.outboundJid.trim()
        : typeof connector.config?.outboundTarget === 'string' && connector.config.outboundTarget.trim()
          ? connector.config.outboundTarget.trim()
          : ''
    if (!ownerChannelIdRaw) return null

    return normalizeTarget({
      connectorId,
      channelId: ownerChannelIdRaw,
    })
  }

  const explicitTarget = normalizeTarget({
    connectorId: typeof metaTask.followupConnectorId === 'string' ? metaTask.followupConnectorId : null,
    channelId: typeof metaTask.followupChannelId === 'string' ? metaTask.followupChannelId : null,
    threadId: typeof metaTask.followupThreadId === 'string' ? metaTask.followupThreadId : null,
  })
  if (explicitTarget) {
    return resolveMainSessionOwnerTarget(explicitTarget.connectorId) || explicitTarget
  }

  if (!sourceSessionId) return null
  const sourceSession = sessions[sourceSessionId]
  if (!sourceSession) return null

  if (isDirectConnectorSession(sourceSession)) {
    const sessionContextTarget = normalizeTarget({
      connectorId: typeof sourceSession.connectorContext?.connectorId === 'string'
        ? sourceSession.connectorContext.connectorId
        : null,
      channelId: typeof sourceSession.connectorContext?.channelId === 'string'
        ? sourceSession.connectorContext.channelId
        : null,
      threadId: typeof sourceSession.connectorContext?.threadId === 'string'
        ? sourceSession.connectorContext.threadId
        : null,
    })
    if (sessionContextTarget) return sessionContextTarget
  }
  const ownerSessionTarget = resolveMainSessionOwnerTarget()
  if (ownerSessionTarget) return ownerSessionTarget

  const sourceMessages = typeof sourceSession.id === 'string' ? getMessages(sourceSession.id) : []
  if (!isMainSession(sourceSession) && sourceMessages.length > 0) {
    for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
      const message = sourceMessages[index]
      if (!message || message.role !== 'user') continue
      if (message.historyExcluded === true) continue

      const connectorId = typeof message.source?.connectorId === 'string'
        ? message.source.connectorId.trim()
        : ''
      if (!connectorId) continue

      const connector = connectors[connectorId]
      if (!connector) continue
      const runtime = runningById.get(connectorId)
      const sourceChannel = typeof message.source?.channelId === 'string'
        ? message.source.channelId.trim()
        : ''
      const fallbackChannel = runtime?.recentChannelId
        || runtime?.configuredTargets?.[0]
        || connector.config?.outboundJid
        || connector.config?.outboundTarget
        || ''
      const target = normalizeTarget({
        connectorId,
        channelId: sourceChannel || fallbackChannel,
        threadId: typeof message.source?.threadId === 'string' ? message.source.threadId : null,
      })
      if (target) return target
    }
  }

  return null
}

export function collectTaskConnectorFollowupTargets(params: {
  task: BoardTask
  sessions: Record<string, SessionLike>
  connectors: Record<string, Connector>
  running: RunningConnectorLike[]
}): ConnectorTaskFollowupTarget[] {
  const { task, sessions, connectors, running } = params
  const originTarget = resolveTaskOriginConnectorFollowupTarget({ task, sessions, connectors, running })
  if (originTarget) return [originTarget]

  const targets: ConnectorTaskFollowupTarget[] = []
  const seen = new Set<string>()
  const pushTarget = (target: ConnectorTaskFollowupTarget | null | undefined) => {
    if (!target?.connectorId || !target?.channelId) return
    const key = `${target.connectorId}|${target.channelId}|${target.threadId || ''}`
    if (seen.has(key)) return
    seen.add(key)
    targets.push(target)
  }

  for (const entry of running) {
    if (!entry.supportsSend || !entry.id) continue
    const connector = connectors[entry.id]
    if (!connector) continue
    if (connector.agentId !== task.agentId) continue
    if (!isEnabledFlag(connector.config?.taskFollowups)) continue
    const channelTargetRaw = entry.configuredTargets[0]
      || connector.config?.outboundJid
      || connector.config?.outboundTarget
      || ''
    if (!channelTargetRaw) continue
    pushTarget({
      connectorId: entry.id,
      channelId: connector.platform === 'whatsapp'
        ? normalizeWhatsappTarget(channelTargetRaw)
        : channelTargetRaw,
    })
  }

  return targets
}

function normalizeFollowupChannelForConnector(connector: Connector | undefined, channelId: string | null | undefined): string {
  const raw = typeof channelId === 'string' ? channelId.trim() : ''
  if (!raw) return ''
  return connector?.platform === 'whatsapp' ? normalizeWhatsappTarget(raw) : raw
}

function extractDeliveredConnectorTarget(event: MessageToolEvent | null | undefined): {
  connectorId: string
  channelId: string
} | null {
  if (!event || event.name !== 'connector_message_tool' || event.error === true || !event.output) return null
  try {
    const parsed = JSON.parse(event.output) as Record<string, unknown>
    const status = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : ''
    const connectorId = typeof parsed.connectorId === 'string' ? parsed.connectorId.trim() : ''
    const channelId = typeof parsed.to === 'string' ? parsed.to.trim() : ''
    if (!CONNECTOR_DELIVERY_STATUSES.has(status) || !connectorId || !channelId) return null
    return { connectorId, channelId }
  } catch {
    return null
  }
}

export function taskAlreadyDeliveredToConnectorTarget(params: {
  task: BoardTask
  target: ConnectorTaskFollowupTarget
  sessions: Record<string, SessionLike>
  connectors: Record<string, Connector>
}): boolean {
  const taskRecord = params.task as BoardTask & {
    checkpoint?: {
      lastSessionId?: string | null
    } | null
  }
  const taskSessionId = typeof taskRecord.sessionId === 'string' && taskRecord.sessionId.trim()
    ? taskRecord.sessionId.trim()
    : typeof taskRecord.checkpoint?.lastSessionId === 'string' && taskRecord.checkpoint.lastSessionId.trim()
      ? taskRecord.checkpoint.lastSessionId.trim()
      : ''
  if (!taskSessionId) return false
  const session = params.sessions[taskSessionId]
  if (!session) return false

  const sessionMessages = typeof session.id === 'string' ? getMessages(session.id) : []
  const connector = params.connectors[params.target.connectorId]
  const normalizedTargetChannel = normalizeFollowupChannelForConnector(connector, params.target.channelId)
  if (!normalizedTargetChannel) return false

  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index]
    if (!message || message.role !== 'assistant' || !Array.isArray(message.toolEvents)) continue
    for (const event of message.toolEvents) {
      const delivered = extractDeliveredConnectorTarget(event as MessageToolEvent)
      if (!delivered) continue
      if (delivered.connectorId !== params.target.connectorId) continue
      const normalizedDeliveredChannel = normalizeFollowupChannelForConnector(connector, delivered.channelId)
      if (normalizedDeliveredChannel === normalizedTargetChannel) return true
    }
  }

  return false
}

export async function notifyConnectorTaskFollowups(params: {
  task: BoardTask
  statusLabel: string
  summaryText: string
  imageUrl?: string
  mediaPath?: string
  mediaFileName?: string
}) {
  const { task, statusLabel, summaryText, imageUrl, mediaPath, mediaFileName } = params

  const connectors = loadConnectors()
  const running = (await import('@/lib/server/connectors/manager')).listRunningConnectors()
  const manager = await import('@/lib/server/connectors/manager')
  const sessions = loadSessions()
  const targets = collectTaskConnectorFollowupTargets({
    task,
    sessions: sessions as Record<string, SessionLike>,
    connectors,
    running: running as RunningConnectorLike[],
  })
  if (!targets.length) return
  const originTarget = resolveTaskOriginConnectorFollowupTarget({
    task,
    sessions: sessions as Record<string, SessionLike>,
    connectors,
    running: running as RunningConnectorLike[],
  })
  const preferredTargetKey = originTarget
    ? `${originTarget.connectorId}|${originTarget.channelId}|${originTarget.threadId || ''}`
    : ''

  const summary = summaryText.trim().slice(0, 1400)
  for (const target of targets) {
    const connector = connectors[target.connectorId]
    if (!connector) continue
    if (taskAlreadyDeliveredToConnectorTarget({
      task,
      target,
      sessions: sessions as Record<string, SessionLike>,
      connectors: connectors as Record<string, Connector>,
    })) {
      continue
    }

    const template = typeof connector.config?.taskFollowupTemplate === 'string'
      ? connector.config.taskFollowupTemplate.trim()
      : ''
    const message = template
      ? fillTaskFollowupTemplate(template, {
          status: statusLabel,
          title: task.title || task.id,
          summary,
          taskId: task.id,
        })
      : [
          `Task ${statusLabel}: ${task.title}`,
          summary || 'No summary provided.',
        ].join('\n\n')
    const targetKey = `${target.connectorId}|${target.channelId}|${target.threadId || ''}`
    const preferredChannelNote = !template && preferredTargetKey && targetKey === preferredTargetKey
      ? '\n\n(Update sent in the same channel that requested this task.)'
      : ''
    const outboundMessage = `${message}${preferredChannelNote}`

    const resolvedMediaPath = mediaPath || maybeResolveUploadMediaPathFromUrl(imageUrl)
    try {
      await manager.sendConnectorMessage({
        connectorId: target.connectorId,
        channelId: target.channelId,
        threadId: target.threadId || undefined,
        text: outboundMessage,
        ...(resolvedMediaPath
          ? {
              mediaPath: resolvedMediaPath,
              fileName: mediaFileName || path.basename(resolvedMediaPath),
              caption: outboundMessage,
            }
          : {}),
      })
    } catch (err: unknown) {
      const errMsg = errorMessage(err)
      log.warn(TAG, `Failed task follow-up send on connector ${target.connectorId}: ${errMsg}`)
    }
  }
}
