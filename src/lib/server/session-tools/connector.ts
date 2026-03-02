import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import path from 'path'
import fs from 'fs'
import { loadConnectors, loadSettings, UPLOAD_DIR } from '../storage'
import type { ToolBuildContext } from './context'

/** Resolve /api/uploads/filename URLs to actual disk paths */
function resolveUploadUrl(url: string | undefined): { mediaPath: string; mimeType?: string } | null {
  if (!url) return null
  const match = url.match(/^\/api\/uploads\/([^?#]+)/)
  if (!match) return null
  const safeName = match[1].replace(/[^a-zA-Z0-9._-]/g, '')
  const filePath = path.join(UPLOAD_DIR, safeName)
  if (!fs.existsSync(filePath)) return null
  return { mediaPath: filePath }
}

export function buildConnectorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { ctx, hasTool } = bctx

  if (hasTool('manage_connectors')) {
    tools.push(
      tool(
        async ({ action, connectorId, platform, to, message, imageUrl, fileUrl, mediaPath, mimeType, fileName, caption, approved }) => {
          try {
            const normalizeWhatsAppTarget = (input: string): string => {
              const raw = input.trim()
              if (!raw) return raw
              if (raw.includes('@')) return raw
              let cleaned = raw.replace(/[^\d+]/g, '')
              if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
              if (cleaned.startsWith('0') && cleaned.length >= 10) {
                cleaned = '44' + cleaned.slice(1)
              }
              cleaned = cleaned.replace(/[^\d]/g, '')
              return cleaned ? `${cleaned}@s.whatsapp.net` : raw
            }

            const { listRunningConnectors, sendConnectorMessage, getConnectorRecentChannelId } = await import('../connectors/manager')
            const running = listRunningConnectors(platform || undefined)

            if (action === 'list_running' || action === 'list_targets') {
              return JSON.stringify(running)
            }

            if (action === 'start') {
              if (!connectorId) {
                // If no ID given, list available connectors to start
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

            if (action === 'stop') {
              if (!connectorId) return 'Error: connectorId is required for stop action.'
              const { stopConnector: doStop } = await import('../connectors/manager')
              await doStop(connectorId)
              return JSON.stringify({ status: 'stopped', connectorId })
            }

            if (action === 'send') {
              const settings = loadSettings()
              if (settings.safetyRequireApprovalForOutbound === true && approved !== true) {
                return 'Error: outbound connector sends require explicit approval. Re-run with approved=true after user confirmation.'
              }
              const hasText = !!message?.trim()
              const hasMedia = !!imageUrl?.trim() || !!fileUrl?.trim()
              if (!hasText && !hasMedia) return 'Error: message or media URL is required for send action.'
              if (!running.length) {
                // Check for configured-but-not-running connectors to give actionable feedback
                const allConnectors = loadConnectors()
                const configured = Object.values(allConnectors)
                  .filter((c) => !platform || c.platform === platform)
                  .map((c) => ({ id: c.id, name: c.name, platform: c.platform, agentId: c.agentId || null }))
                if (configured.length) {
                  return `Error: no running connectors${platform ? ` for platform "${platform}"` : ''}, but ${configured.length} configured connector(s) found: ${JSON.stringify(configured)}. These connectors exist but are not currently started. Ask the user if they'd like you to start one (use action "start" with the connectorId), then retry the send.`
                }
                return `Error: no running connectors${platform ? ` for platform "${platform}"` : ''}. No connectors are configured for this platform either — the user needs to set one up in the Connectors panel first.`
              }

              const selected = connectorId
                ? running.find((c) => c.id === connectorId)
                : running[0]
              if (!selected) return `Error: running connector not found: ${connectorId}`

              const connectors = loadConnectors()
              const connector = connectors[selected.id]
              if (!connector) return `Error: connector not found: ${selected.id}`

              let channelId = to?.trim() || ''
              if (!channelId) {
                const outbound = connector.config?.outboundJid?.trim()
                if (outbound) channelId = outbound
              }
              if (!channelId) {
                const outbound = connector.config?.outboundTarget?.trim()
                if (outbound) channelId = outbound
              }
              if (!channelId) {
                const recentChannelId = getConnectorRecentChannelId(selected.id)
                if (recentChannelId) channelId = recentChannelId
              }
              if (!channelId) {
                const allowed = connector.config?.allowedJids?.split(',').map((s: string) => s.trim()).filter(Boolean) || []
                if (allowed.length) channelId = allowed[0]
              }
              if (!channelId) {
                const allowed = connector.config?.allowFrom?.split(',').map((s: string) => s.trim()).filter(Boolean) || []
                if (allowed.length) channelId = allowed[0]
              }
              if (!channelId) {
                // Collect any known numbers/targets from config to help the agent suggest them
                const knownTargets: string[] = []
                const jids = connector.config?.allowedJids?.split(',').map((s: string) => s.trim()).filter(Boolean) || []
                const from = connector.config?.allowFrom?.split(',').map((s: string) => s.trim()).filter(Boolean) || []
                const outJid = connector.config?.outboundJid?.trim()
                const outTarget = connector.config?.outboundTarget?.trim()
                if (outJid) knownTargets.push(outJid)
                if (outTarget) knownTargets.push(outTarget)
                knownTargets.push(...jids, ...from)
                const unique = [...new Set(knownTargets)]
                if (unique.length) {
                  return `Error: no default outbound target is set, but the connector has ${unique.length} configured number(s)/target(s): ${JSON.stringify(unique)}. Ask the user which one to send to, then re-call with the "to" parameter set to their choice.`
                }
                return `Error: no target recipient configured and no known contacts on this connector. Ask the user for the recipient number/ID, then re-call with the "to" parameter. They can also configure "allowedJids" or "outboundJid" in the connector settings.`
              }
              if (connector.platform === 'whatsapp') {
                channelId = normalizeWhatsAppTarget(channelId)
              }

              // Resolve /api/uploads/ URLs to actual disk paths so connectors can read the files
              let resolvedMediaPath = mediaPath?.trim() || undefined
              let resolvedImageUrl = imageUrl?.trim() || undefined
              let resolvedFileUrl = fileUrl?.trim() || undefined
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

              const sent = await sendConnectorMessage({
                connectorId: selected.id,
                channelId,
                text: message?.trim() || '',
                imageUrl: resolvedImageUrl,
                fileUrl: resolvedFileUrl,
                mediaPath: resolvedMediaPath,
                mimeType: mimeType?.trim() || undefined,
                fileName: fileName?.trim() || undefined,
                caption: caption?.trim() || undefined,
              })
              return JSON.stringify({
                status: 'sent',
                connectorId: sent.connectorId,
                platform: sent.platform,
                to: sent.channelId,
                messageId: sent.messageId || null,
              })
            }

            if (action === 'message_react' || action === 'message_edit' || action === 'message_pin' || action === 'message_delete') {
              if (!connectorId) return 'Error: connectorId is required for rich messaging actions.'
              const { getRunningInstance } = await import('../connectors/manager')
              const inst = getRunningInstance(connectorId)
              if (!inst) return `Error: connector "${connectorId}" is not running.`

              const targetChannel = to?.trim() || ''
              const targetMessageId = message?.trim() || ''
              if (!targetMessageId) return 'Error: message parameter (used as messageId) is required for rich messaging actions.'

              try {
                if (action === 'message_react') {
                  if (!inst.sendReaction) return 'Error: this connector does not support reactions.'
                  const emoji = caption?.trim() || '👍'
                  await inst.sendReaction(targetChannel, targetMessageId, emoji)
                  return JSON.stringify({ status: 'reacted', connectorId, messageId: targetMessageId, emoji })
                }
                if (action === 'message_edit') {
                  if (!inst.editMessage) return 'Error: this connector does not support message editing.'
                  const newText = caption?.trim() || ''
                  if (!newText) return 'Error: caption (new text) is required for message_edit.'
                  await inst.editMessage(targetChannel, targetMessageId, newText)
                  return JSON.stringify({ status: 'edited', connectorId, messageId: targetMessageId })
                }
                if (action === 'message_delete') {
                  if (!inst.deleteMessage) return 'Error: this connector does not support message deletion.'
                  await inst.deleteMessage(targetChannel, targetMessageId)
                  return JSON.stringify({ status: 'deleted', connectorId, messageId: targetMessageId })
                }
                if (action === 'message_pin') {
                  if (!inst.pinMessage) return 'Error: this connector does not support message pinning.'
                  await inst.pinMessage(targetChannel, targetMessageId)
                  return JSON.stringify({ status: 'pinned', connectorId, messageId: targetMessageId })
                }
              } catch (err: unknown) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`
              }
            }

            return 'Unknown action. Use list_running, list_targets, start, stop, or send.'
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'connector_message_tool',
          description: 'Manage and send messages through chat platform connectors (WhatsApp, Telegram, Slack, Discord, etc.). Use "start"/"stop" to manage connector lifecycle, "list_running"/"list_targets" to discover available connectors and recipients, "send" to deliver messages, and rich actions (react, edit, delete, pin) for message management. When a send fails because no connector is running, check if one is configured and offer to start it. When no target is set, list available configured numbers and ask the user which to send to.',
          schema: z.object({
            action: z.enum(['list_running', 'list_targets', 'start', 'stop', 'send', 'message_react', 'message_edit', 'message_delete', 'message_pin']).describe('connector messaging action'),
            connectorId: z.string().optional().describe('Optional connector id. Defaults to the first running connector (or first for selected platform).'),
            platform: z.string().optional().describe('Optional platform filter (whatsapp, telegram, slack, discord, bluebubbles, etc.).'),
            to: z.string().optional().describe('Target channel id / recipient. For WhatsApp, phone number or full JID.'),
            message: z.string().optional().describe('Message text to send (required for send action).'),
            imageUrl: z.string().optional().describe('Optional public image URL to attach/send where platform supports media.'),
            fileUrl: z.string().optional().describe('Optional public file URL to attach/send where platform supports documents.'),
            mediaPath: z.string().optional().describe('Absolute local file path to send (e.g. a screenshot). Auto-detects mime type from extension. Takes priority over imageUrl/fileUrl.'),
            mimeType: z.string().optional().describe('Optional MIME type for mediaPath or fileUrl.'),
            fileName: z.string().optional().describe('Optional display file name for mediaPath or fileUrl.'),
            caption: z.string().optional().describe('Optional caption used with image/file sends.'),
            approved: z.boolean().optional().describe('Set true to explicitly confirm outbound send when safetyRequireApprovalForOutbound is enabled.'),
          }),
        },
      ),
    )
  }

  return tools
}
