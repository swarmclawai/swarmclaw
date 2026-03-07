import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import path from 'path'
import fs from 'fs'
import { loadConnectors, loadSettings, UPLOAD_DIR } from '../storage'
import { genId } from '@/lib/id'
import { synthesizeElevenLabsMp3 } from '../elevenlabs'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

const CONNECTOR_ACTION_DEDUPE_TTL_MS = 30_000
const CONNECTOR_TURN_SEND_TTL_MS = 180_000
const AUTONOMOUS_OUTREACH_COOLDOWN_MS = 2 * 60 * 60 * 1000
const recentConnectorActionCache = new Map<string, { at: number; result: string }>()
const connectorTurnSendBudget = new Map<string, { count: number; at: number; lastResult?: string }>()
const autonomousOutreachBudget = new Map<string, { at: number; result?: string }>()

function pruneOldConnectorToolState(now: number): void {
  for (const [key, entry] of recentConnectorActionCache.entries()) {
    if (now - entry.at > CONNECTOR_ACTION_DEDUPE_TTL_MS) recentConnectorActionCache.delete(key)
  }
  for (const [key, entry] of connectorTurnSendBudget.entries()) {
    if (now - entry.at > CONNECTOR_TURN_SEND_TTL_MS) connectorTurnSendBudget.delete(key)
  }
  for (const [key, entry] of autonomousOutreachBudget.entries()) {
    if (now - entry.at > AUTONOMOUS_OUTREACH_COOLDOWN_MS) autonomousOutreachBudget.delete(key)
  }
}

function parseLatestUserTurn(
  session: { messages?: Array<Record<string, unknown>> } | null | undefined,
): { text: string; time: number } {
  const msgs = Array.isArray(session?.messages) ? session.messages : []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i]
    if (String(msg?.role || '') !== 'user') continue
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    const time = typeof msg.time === 'number' ? msg.time : 0
    return { text, time }
  }
  return { text: '', time: 0 }
}

function userExplicitlyWantsMultipleOutbound(userText: string): boolean {
  if (!userText) return false
  const text = userText.toLowerCase()
  return /\b(both|multiple|all of them|all numbers|two messages|three messages|each number|every number|and also|plus also|send again|resend)\b/.test(text)
}

function userExplicitlyRequestedFollowup(userText: string): boolean {
  if (!userText) return false
  const text = userText.toLowerCase()
  if (/connector_message_tool/.test(text) && /(schedule_followup|followupmessage|followup|delaysec|follow.?up)/.test(text)) return true
  return /\b(follow[ -]?up|check[ -]?in|remind(?: me)?|later|tomorrow|in \d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days))\b/.test(text)
}

function isAutonomousSystemTurn(userText: string): boolean {
  if (!userText) return false
  const text = userText.toUpperCase()
  return text.includes('AGENT_HEARTBEAT_WAKE')
    || text.includes('SWARM_HEARTBEAT_CHECK')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _isSignificantOutreachText(raw: string): boolean {
  const text = (raw || '').trim().toLowerCase()
  if (text.length < 12) return false
  if (/\b(just checking in|checking in|touching base|quick check-in|hope you'?re well|any updates\??)\b/.test(text)) {
    return false
  }
  return /\b(completed|complete|done|finished|failed|failure|error|blocked|urgent|important|deadline|overdue|incident|warning|reminder|birthday|anniversary|milestone|congrats|congratulations|celebrate|payment|invoice|appointment|meeting)\b/.test(text)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _isUrgentOutreachText(raw: string): boolean {
  const text = (raw || '').toLowerCase()
  return /\b(urgent|immediately|asap|critical|incident|outage|failed|failure|blocked|overdue|deadline)\b/.test(text)
}

function buildConnectorActionKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => String(part ?? '')).join('|')
}

function normalizeDedupedReplayResult(raw: string, fallback: { connectorId: string; platform: string; to: string }): string {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    const record = parsed as Record<string, unknown>
    if (String(record.status || '') === 'deduped') {
      return JSON.stringify({
        status: 'sent',
        connectorId: String(record.connectorId || fallback.connectorId),
        platform: String(record.platform || fallback.platform),
        to: String(record.to || fallback.to),
        deduped: true,
      })
    }
    return raw
  } catch {
    return JSON.stringify({
      status: 'sent',
      connectorId: fallback.connectorId,
      platform: fallback.platform,
      to: fallback.to,
      deduped: true,
    })
  }
}

/** Resolve /api/uploads/filename URLs to actual disk paths */
function resolveUploadUrl(url: string | undefined): { mediaPath: string; mimeType?: string } | null {
  if (!url) return null
  const match = url.match(/^\/api\/uploads\/([^?#]+)/)
  if (!match) return null
  let decoded: string
  try { decoded = decodeURIComponent(match[1]) } catch { decoded = match[1] }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  const filePath = path.join(UPLOAD_DIR, safeName)
  if (!fs.existsSync(filePath)) return null
  return { mediaPath: filePath }
}

function normalizeWhatsAppTarget(input: string): string {
  const raw = input.trim()
  if (!raw) return raw
  if (raw.includes('@')) return raw
  let cleaned = raw.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
  if (cleaned.startsWith('0') && cleaned.length >= 10) {
    cleaned = `44${cleaned.slice(1)}`
  }
  cleaned = cleaned.replace(/[^\d]/g, '')
  return cleaned ? `${cleaned}@s.whatsapp.net` : raw
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function pickChannelTarget(params: {
  connector: { config?: Record<string, string> }
  to?: string
  recentChannelId: string | null
}): { channelId: string; error?: string } {
  let channelId = params.to?.trim() || ''
  const connector = params.connector

  if (!channelId) {
    const outbound = connector.config?.outboundJid?.trim()
    if (outbound) channelId = outbound
  }
  if (!channelId) {
    const outbound = connector.config?.outboundTarget?.trim()
    if (outbound) channelId = outbound
  }
  if (!channelId && params.recentChannelId) {
    channelId = params.recentChannelId
  }
  if (!channelId) {
    const allowed = parseCsv(connector.config?.allowedJids)
    if (allowed.length) channelId = allowed[0]
  }
  if (!channelId) {
    const allowed = parseCsv(connector.config?.allowFrom)
    if (allowed.length) channelId = allowed[0]
  }
  if (!channelId) {
    const knownTargets = [
      connector.config?.outboundJid?.trim(),
      connector.config?.outboundTarget?.trim(),
      ...parseCsv(connector.config?.allowedJids),
      ...parseCsv(connector.config?.allowFrom),
    ].filter(Boolean) as string[]
    const unique = [...new Set(knownTargets)]
    if (unique.length) {
      return {
        channelId: '',
        error: `Error: no default outbound target is set, but the connector has ${unique.length} configured number(s)/target(s): ${JSON.stringify(unique)}. Ask the user which one to send to, then re-call with the "to" parameter set to their choice.`,
      }
    }
    return {
      channelId: '',
      error: 'Error: no target recipient configured and no known contacts on this connector. Ask the user for the recipient number/ID, then re-call with the "to" parameter. They can also configure "allowedJids" or "outboundJid" in the connector settings.',
    }
  }
  return { channelId }
}

export function resolveConnectorMediaInput(params: {
  cwd: string
  mediaPath?: string
  imageUrl?: string
  fileUrl?: string
}): { mediaPath?: string; imageUrl?: string; fileUrl?: string; error?: string } {
  let resolvedMediaPath = params.mediaPath?.trim() || undefined
  let resolvedImageUrl = params.imageUrl?.trim() || undefined
  let resolvedFileUrl = params.fileUrl?.trim() || undefined

  // Be forgiving when the model passes a served upload URL or remote URL in mediaPath.
  if (resolvedMediaPath?.startsWith('/api/uploads/')) {
    const fromUpload = resolveUploadUrl(resolvedMediaPath)
    if (fromUpload) {
      resolvedMediaPath = fromUpload.mediaPath
    } else {
      return { error: `Error: File not found: ${resolvedMediaPath}` }
    }
  } else if (resolvedMediaPath && /^https?:\/\//i.test(resolvedMediaPath)) {
    if (/\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(resolvedMediaPath)) {
      resolvedImageUrl = resolvedMediaPath
    } else {
      resolvedFileUrl = resolvedMediaPath
    }
    resolvedMediaPath = undefined
  }

  if (resolvedMediaPath && !path.isAbsolute(resolvedMediaPath) && !resolvedMediaPath.startsWith('/api/uploads/')) {
    const candidatePaths = [
      path.resolve(params.cwd, resolvedMediaPath),
      path.resolve(params.cwd, 'uploads', resolvedMediaPath),
      path.join(UPLOAD_DIR, resolvedMediaPath),
      path.join(UPLOAD_DIR, path.basename(resolvedMediaPath)),
    ]
    const found = candidatePaths.find((p) => fs.existsSync(p))
    if (found) {
      resolvedMediaPath = found
    } else {
      return {
        error: `Error: File not found. Tried: ${candidatePaths.join(', ')}. Use an absolute path or ensure the file exists in the session workspace.`,
      }
    }
  }

  if (!resolvedMediaPath) {
    const fromImage = resolveUploadUrl(resolvedImageUrl)
    if (fromImage) {
      resolvedMediaPath = fromImage.mediaPath
      resolvedImageUrl = undefined
    }
    const fromFile = resolveUploadUrl(resolvedFileUrl)
    if (fromFile) {
      resolvedMediaPath = fromFile.mediaPath
      resolvedFileUrl = undefined
    }
  }

  return {
    mediaPath: resolvedMediaPath,
    imageUrl: resolvedImageUrl,
    fileUrl: resolvedFileUrl,
  }
}

/**
 * Core Connector Execution Logic
 */
interface ConnectorActionInput {
  action?: string
  connectorId?: string
  platform?: string
  to?: string
  message?: string
  messageId?: string
  targetMessage?: 'last_inbound' | 'last_outbound'
  emoji?: string
  voiceText?: string
  voiceId?: string
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  delaySec?: number
  followUpMessage?: string
  followUpDelaySec?: number
  dedupeKey?: string
  approved?: boolean
  ptt?: boolean
}

interface ConnectorActionContext {
  cwd: string
  resolveCurrentSession?: () => { messages?: Array<Record<string, unknown>>; id?: string } | null
  ctx?: { sessionId?: string | null }
}

async function executeConnectorAction(input: ConnectorActionInput, bctx: ConnectorActionContext) {
  const normalized = normalizeToolInputArgs((input ?? {}) as Record<string, unknown>)
  const {
    action,
    connectorId,
    platform,
    to,
    message,
    voiceText,
    voiceId,
    imageUrl,
    fileUrl,
    mediaPath,
    mimeType,
    fileName,
    caption,
    messageId,
    targetMessage,
    emoji,
    replyToMessageId,
    threadId,
    dedupeKey,
    approved,
    ptt,
  } = normalized as ConnectorActionInput

  try {
    const actionName = String(action)
    const {
      listRunningConnectors,
      sendConnectorMessage,
      getConnectorRecentChannelId,
      scheduleConnectorFollowUp,
      performConnectorMessageAction,
    } = await import('../connectors/manager')
    const running = listRunningConnectors(platform || undefined)

    if (actionName === 'list_running' || actionName === 'list_targets') {
      return JSON.stringify(running)
    }

    if (actionName === 'start') {
      if (!connectorId) {
        const allConnectors = loadConnectors()
        const stopped = Object.values(allConnectors)
          .filter((c) => !platform || c.platform === platform)
          .filter((c) => !running.find((r) => r.id === c.id))
          .map((c) => ({ id: c.id, name: c.name, platform: c.platform }))
        if (!stopped.length) return 'All connectors are already running.'
        return `Error: connectorId is required. Stopped connectors available to start: ${JSON.stringify(stopped)}`
      }
      const { startConnector: doStart } = await import('../connectors/manager')
      await doStart(connectorId)
      return JSON.stringify({ status: 'started', connectorId })
    }

    if (actionName === 'stop') {
      if (!connectorId) return 'Error: connectorId is required for stop action.'
      const { stopConnector: doStop } = await import('../connectors/manager')
      await doStop(connectorId)
      return JSON.stringify({ status: 'stopped', connectorId })
    }

    const resolveSelectedConnector = () => {
      if (!running.length) {
        const allConnectors = loadConnectors()
        const configured = Object.values(allConnectors)
          .filter((c) => !platform || c.platform === platform)
          .map((c) => ({ id: c.id, name: c.name, platform: c.platform, agentId: c.agentId || null }))
        if (configured.length) {
          return {
            error: `Error: no running connectors found. Ask user to start one. Configured: ${JSON.stringify(configured)}`,
          }
        }
        return {
          error: `Error: no running connectors. User needs to set one up in the Connectors panel.`,
        }
      }
      const selected = connectorId ? running.find((c) => c.id === connectorId) : running[0]
      if (!selected) return { error: `Error: running connector not found: ${connectorId}` }
      const connectors = loadConnectors()
      const connector = connectors[selected.id]
      if (!connector) return { error: `Error: connector not found: ${selected.id}` }
      return { selected, connector }
    }

    const currentSession = bctx.resolveCurrentSession?.()
    const sessionId = bctx.ctx?.sessionId || currentSession?.id || undefined

    if (actionName === 'send' || actionName === 'send_voice_note' || actionName === 'schedule_followup') {
      const settings = loadSettings()
      if (settings.safetyRequireApprovalForOutbound === true && approved !== true) {
        return 'Error: outbound connector sends require explicit approval. Re-run with approved=true after user confirmation.'
      }
      const now = Date.now()
      pruneOldConnectorToolState(now)
      const resolved = resolveSelectedConnector()
      if ('error' in resolved) return resolved.error
      const { selected, connector } = resolved

      const target = pickChannelTarget({
        connector,
        to,
        recentChannelId: getConnectorRecentChannelId(selected.id),
      })
      if (target.error) return target.error

      let channelId = target.channelId
      if (connector.platform === 'whatsapp') channelId = normalizeWhatsAppTarget(channelId)

      const latestUserTurn = parseLatestUserTurn(currentSession)
      const turnKey = buildConnectorActionKey([sessionId, latestUserTurn.time || 'no-user-turn'])
      const multiOutboundAllowed = userExplicitlyWantsMultipleOutbound(latestUserTurn.text)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _followupExplicitlyRequested = userExplicitlyRequestedFollowup(latestUserTurn.text)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _autonomousTurn = isAutonomousSystemTurn(latestUserTurn.text)
      const existingBudget = connectorTurnSendBudget.get(turnKey)
      
      if (!multiOutboundAllowed && existingBudget && now - existingBudget.at <= CONNECTOR_TURN_SEND_TTL_MS && existingBudget.count >= 1) {
        if (existingBudget.lastResult) {
          return normalizeDedupedReplayResult(existingBudget.lastResult, { connectorId: selected.id, platform: selected.platform, to: channelId })
        }
        return JSON.stringify({ status: 'sent', connectorId: selected.id, platform: selected.platform, to: channelId, deduped: true })
      }

      if (actionName === 'send_voice_note') {
        const ttsText = (voiceText || message || '').trim()
        if (!ttsText) return 'Error: voiceText or message is required.'
        const audioBuffer = await synthesizeElevenLabsMp3({ text: ttsText, voiceId: voiceId?.trim() || undefined })
        const voiceFileName = `${Date.now()}-${genId()}-voicenote.mp3`
        const voicePath = path.join(UPLOAD_DIR, voiceFileName)
        fs.writeFileSync(voicePath, audioBuffer)

        const sent = await sendConnectorMessage({
          connectorId: selected.id, channelId, text: '', mediaPath: voicePath, mimeType: 'audio/mpeg',
          fileName: fileName?.trim() || 'voicenote.mp3', caption: caption?.trim() || undefined, ptt: ptt ?? true,
          sessionId,
          replyToMessageId: replyToMessageId?.trim() || undefined,
          threadId: threadId?.trim() || undefined,
        })
        const result = JSON.stringify({ status: 'voice_sent', connectorId: sent.connectorId, platform: sent.platform, to: sent.channelId, voiceFile: voicePath })
        connectorTurnSendBudget.set(turnKey, { count: (existingBudget?.count || 0) + 1, at: now, lastResult: result })
        return result
      }

      const media = resolveConnectorMediaInput({ cwd: bctx.cwd, mediaPath, imageUrl, fileUrl })
      if (media.error) return media.error

      if (actionName === 'send' && !message?.trim() && !media.mediaPath && !media.imageUrl && !media.fileUrl) {
        return 'Error: message or media required.'
      }

      if (actionName === 'schedule_followup') {
        const followupText = (normalized.followUpMessage as string | undefined)?.trim() || message?.trim() || ''
        if (!followupText && !media.mediaPath && !media.imageUrl && !media.fileUrl) {
          return 'Error: follow-up message or media required.'
        }
        const followupDelay = (() => {
          const direct = Number(normalized.followUpDelaySec)
          if (Number.isFinite(direct) && direct >= 0) return direct
          const fallback = Number(normalized.delaySec)
          if (Number.isFinite(fallback) && fallback >= 0) return fallback
          return 300
        })()
        const scheduled = scheduleConnectorFollowUp({
          connectorId: selected.id,
          channelId,
          text: followupText,
          sessionId,
          delaySec: followupDelay,
          dedupeKey: dedupeKey?.trim() || undefined,
          imageUrl: media.imageUrl,
          fileUrl: media.fileUrl,
          mediaPath: media.mediaPath,
          mimeType: mimeType?.trim() || undefined,
          fileName: fileName?.trim() || undefined,
          caption: caption?.trim() || undefined,
          replyToMessageId: replyToMessageId?.trim() || undefined,
          threadId: threadId?.trim() || undefined,
          ptt: ptt ?? undefined,
        })
        return JSON.stringify({
          status: 'scheduled',
          connectorId: selected.id,
          platform: selected.platform,
          to: channelId,
          followUpId: scheduled.followUpId,
          sendAt: scheduled.sendAt,
        })
      }

      const sent = await sendConnectorMessage({
        connectorId: selected.id, channelId, text: message?.trim() || '',
        sessionId,
        imageUrl: media.imageUrl, fileUrl: media.fileUrl, mediaPath: media.mediaPath,
        mimeType: mimeType?.trim() || undefined, fileName: fileName?.trim() || undefined,
        caption: caption?.trim() || undefined,
        replyToMessageId: replyToMessageId?.trim() || undefined,
        threadId: threadId?.trim() || undefined,
        ptt: ptt ?? undefined,
      })

      const result = JSON.stringify({ status: 'sent', connectorId: sent.connectorId, platform: sent.platform, to: sent.channelId, messageId: sent.messageId || null })
      connectorTurnSendBudget.set(turnKey, { count: (existingBudget?.count || 0) + 1, at: now, lastResult: result })
      return result
    }

    if (actionName === 'react' || actionName === 'edit' || actionName === 'delete' || actionName === 'pin') {
      const resolved = resolveSelectedConnector()
      if ('error' in resolved) return resolved.error
      const { selected } = resolved
      const target = pickChannelTarget({
        connector: resolved.connector,
        to,
        recentChannelId: getConnectorRecentChannelId(selected.id),
      })
      if (target.error) return target.error
      const result = await performConnectorMessageAction({
        connectorId: selected.id,
        channelId: selected.platform === 'whatsapp' ? normalizeWhatsAppTarget(target.channelId) : target.channelId,
        action: actionName,
        messageId: messageId?.trim() || undefined,
        emoji: emoji?.trim() || undefined,
        text: message?.trim() || undefined,
        sessionId,
        targetMessage,
      })
      return JSON.stringify({
        status: actionName,
        connectorId: result.connectorId,
        platform: result.platform,
        to: result.channelId,
        messageId: result.messageId || null,
      })
    }

    return 'Unknown action.'
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const ConnectorPlugin: Plugin = {
  name: 'Core Connectors',
  description: 'Manage and send messages through chat platform connectors (WhatsApp, Telegram, Slack, etc.).',
  hooks: {
    getCapabilityDescription: () => 'I can manage messaging channels (`manage_connectors`) — WhatsApp, Telegram, Slack, Discord — and send proactive messages via `connector_message_tool`.',
    getOperatingGuidance: () => 'Connectors: proactive outreach for significant events only. Keep messages concise, no duplicates.',
  } as PluginHooks,
  tools: [
    {
      name: 'connector_message_tool',
      description: 'Send and manage outbound messages across chat platforms.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_running', 'start', 'stop', 'send', 'send_voice_note', 'schedule_followup', 'react', 'edit', 'delete', 'pin'] },
          connectorId: { type: 'string' },
          platform: { type: 'string' },
          to: { type: 'string' },
          message: { type: 'string' },
          messageId: { type: 'string' },
          targetMessage: { type: 'string', enum: ['last_inbound', 'last_outbound'] },
          emoji: { type: 'string' },
          voiceText: { type: 'string' },
          voiceId: { type: 'string' },
          imageUrl: { type: 'string' },
          fileUrl: { type: 'string' },
          mediaPath: { type: 'string' },
          mimeType: { type: 'string' },
          fileName: { type: 'string' },
          caption: { type: 'string' },
          replyToMessageId: { type: 'string' },
          threadId: { type: 'string' },
          delaySec: { type: 'number' },
          followUpMessage: { type: 'string' },
          followUpDelaySec: { type: 'number' },
          dedupeKey: { type: 'string' },
        },
        required: ['action']
      },
      execute: async (args, context) => executeConnectorAction(args as ConnectorActionInput, { ...context.session, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('connectors', ConnectorPlugin)

/**
 * Legacy Bridge
 */
export function buildConnectorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('manage_connectors')) return []
  return [
    tool(
      async (args) => executeConnectorAction(args as ConnectorActionInput, bctx),
      {
        name: 'connector_message_tool',
        description: ConnectorPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
