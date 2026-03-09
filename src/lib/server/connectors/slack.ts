import { App, LogLevel } from '@slack/bolt'
import fs from 'fs'
import path from 'path'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage, InboundThreadHistoryEntry } from './types'
import { normalizeConnectorIngressResult } from './types'
import { downloadInboundMediaToUpload, inferInboundMediaType, mimeFromPath, isImageMime } from './media'
import { getConnectorReplySendOptions, isNoMessage, recordConnectorOutboundDelivery } from './manager'

function normalizeSlackEmoji(input: string): string {
  const raw = input.trim().replace(/^:|:$/g, '')
  if (!raw) return 'eyes'
  if (raw === '👀') return 'eyes'
  if (raw === '✅') return 'white_check_mark'
  if (raw === '🤐') return 'zipper_mouth_face'
  return raw
}

function parseSlackTimestamp(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(value) ? value : 0
}

async function resolveSlackUserDisplayName(client: any, userId?: string): Promise<string | undefined> {
  if (!userId) return undefined
  try {
    const userInfo = await client.users.info({ user: userId })
    return userInfo.user?.real_name || userInfo.user?.name || userId
  } catch {
    return userId
  }
}

function buildSlackThreadTitle(channelName: string, starterText: string, fallbackTs: string): string {
  const snippet = starterText.replace(/\s+/g, ' ').trim().slice(0, 56)
  if (snippet) return `${channelName} · ${snippet}`
  return `${channelName} thread ${fallbackTs}`
}

async function hydrateSlackThreadContext(params: {
  client: any
  inbound: InboundMessage
  currentTs?: string
  botUserId?: string
}): Promise<void> {
  const threadTs = params.inbound.threadId
  if (!threadTs) return
  try {
    const result = await params.client.conversations.replies({
      channel: params.inbound.channelId,
      ts: threadTs,
      limit: 12,
      inclusive: true,
    })
    const messages = Array.isArray((result as any)?.messages) ? (result as any).messages as any[] : []
    if (!messages.length) return

    const userIds = [...new Set(messages.map((message) => typeof message?.user === 'string' ? message.user : '').filter(Boolean))]
    const nameMap = new Map<string, string>()
    await Promise.all(userIds.map(async (userId) => {
      const name = await resolveSlackUserDisplayName(params.client, userId)
      if (name) nameMap.set(userId, name)
    }))

    const starter = messages[0]
    const starterText = typeof starter?.text === 'string' ? starter.text.trim() : ''
    const starterSenderName = nameMap.get(starter?.user)
      || starter?.username
      || starter?.user
      || (starter?.bot_id ? 'Slack Bot' : '')
    const currentTsValue = parseSlackTimestamp(params.currentTs)
    const history: InboundThreadHistoryEntry[] = messages
      .filter((message) => {
        const tsValue = parseSlackTimestamp(message?.ts)
        if (!tsValue) return false
        if (String(message?.ts) === String(threadTs)) return false
        if (currentTsValue && tsValue >= currentTsValue) return false
        return true
      })
      .slice(-6)
      .map((message) => ({
        role: (message?.bot_id || (params.botUserId && message?.user === params.botUserId) ? 'assistant' : 'user') as 'assistant' | 'user',
        senderName: nameMap.get(message?.user) || message?.username || message?.user || (message?.bot_id ? 'Slack Bot' : 'Unknown'),
        text: typeof message?.text === 'string' ? message.text : '',
        messageId: typeof message?.ts === 'string' ? message.ts : undefined,
      }))
      .filter((entry) => entry.text.trim().length > 0)

    params.inbound.threadParentChannelId = params.inbound.channelId
    params.inbound.threadParentChannelName = params.inbound.channelName || params.inbound.channelId
    params.inbound.threadStarterText = starterText || undefined
    params.inbound.threadStarterSenderName = starterSenderName || undefined
    params.inbound.threadTitle = buildSlackThreadTitle(
      params.inbound.channelName || params.inbound.channelId,
      starterText,
      threadTs,
    )
    params.inbound.threadPersonaLabel = params.inbound.threadTitle
    params.inbound.threadHistory = history.length ? history : undefined
  } catch (err: unknown) {
    console.warn(`[slack] Thread context bootstrap failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const slack: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const appToken = connector.config.appToken || ''
    const signingSecret = connector.config.signingSecret || 'not-used-in-socket-mode'

    // Socket Mode requires an app-level token (xapp-...) — without it, Bolt starts an HTTP server
    if (!appToken) {
      throw new Error(
        'App-Level Token (xapp-...) is required. Enable Socket Mode in your Slack app settings ' +
        'and generate an App-Level Token under Basic Information > App-Level Tokens.'
      )
    }

    if (!appToken.startsWith('xapp-')) {
      throw new Error(
        `Invalid App-Level Token — must start with "xapp-" (got "${appToken.slice(0, 5)}..."). ` +
        'The App-Level Token is different from the Bot Token (xoxb-). ' +
        'Find it under Basic Information > App-Level Tokens in your Slack app settings.'
      )
    }

    // Validate the bot token format and auth
    if (!botToken.startsWith('xoxb-')) {
      throw new Error(
        `Invalid Bot Token — must start with "xoxb-" (got "${botToken.slice(0, 5)}..."). ` +
        'Find it under OAuth & Permissions > Bot User OAuth Token.'
      )
    }

    const { WebClient } = await import('@slack/web-api')
    const testClient = new WebClient(botToken)
    let botUserId: string | undefined
    try {
      const auth = await testClient.auth.test()
      if (!auth.user_id || !auth.team) {
        throw new Error('Auth test returned empty — the bot token may be revoked or the app uninstalled')
      }
      botUserId = auth.user_id as string
      console.log(`[slack] Authenticated as @${auth.user} in workspace "${auth.team}"`)
    } catch (err: any) {
      const hint = err.code === 'slack_webapi_platform_error'
        ? '. Check that your Bot Token (xoxb-...) is correct and the app is installed to the workspace.'
        : ''
      throw new Error(`Slack auth failed: ${err.message}${hint}`)
    }

    const app = new App({
      token: botToken,
      appToken,
      signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    })

    // Catch global errors so they don't become unhandled rejections
    app.error(async (error) => {
      console.error(`[slack] App error:`, error)
    })

    // Optional: restrict to specific channels
    const allowedChannels = connector.config.channelIds
      ? connector.config.channelIds.split(',').map((s) => s.trim()).filter(Boolean)
      : null

    // Handle messages
    app.message(async ({ message, say, client }) => {
      // Only handle user messages (not bot messages or own messages)
      if (!('text' in message) || ('bot_id' in message)) return
      const msg = message as any
      if (botUserId && msg.user === botUserId) return

      const channelId = msg.channel
      if (allowedChannels && !allowedChannels.includes(channelId)) return

      console.log(`[slack] Message in ${channelId} from ${msg.user}: ${(msg.text || '').slice(0, 80)}`)

      // Get user info for display name
      let senderName = msg.user || 'unknown'
      try {
        const userInfo = await client.users.info({ user: msg.user })
        senderName = userInfo.user?.real_name || userInfo.user?.name || senderName
      } catch { /* use ID as fallback */ }

      // Get channel name
      let channelName = channelId
      try {
        const channelInfo = await client.conversations.info({ channel: channelId })
        channelName = (channelInfo.channel as any)?.name || channelId
      } catch { /* use ID as fallback */ }

      const media: NonNullable<InboundMessage['media']> = []
      if (Array.isArray(msg.files)) {
        for (const f of msg.files as any[]) {
          const mediaType = inferInboundMediaType(f?.mimetype, f?.name, 'document')
          const sourceUrl = f?.url_private_download || f?.url_private || f?.permalink_public || f?.permalink
          if (typeof sourceUrl === 'string' && /^https?:\/\//i.test(sourceUrl)) {
            try {
              const stored = await downloadInboundMediaToUpload({
                connectorId: connector.id,
                mediaType,
                url: sourceUrl,
                headers: { Authorization: `Bearer ${botToken}` },
                fileName: f?.name || undefined,
                mimeType: f?.mimetype || undefined,
              })
              if (stored) {
                media.push(stored)
                continue
              }
            } catch (err: any) {
              console.warn(`[slack] Media download failed (${f?.name || 'file'}):`, err?.message || String(err))
            }
          }
          media.push({
            type: mediaType,
            fileName: f?.name || undefined,
            mimeType: f?.mimetype || undefined,
            sizeBytes: typeof f?.size === 'number' ? f.size : undefined,
            url: typeof sourceUrl === 'string' ? sourceUrl : undefined,
          })
        }
      }

      const inbound: InboundMessage = {
        platform: 'slack',
        channelId,
        channelName,
        senderId: msg.user,
        senderName,
        text: msg.text || (media.length > 0 ? '(media message)' : ''),
        isGroup: !String(channelId).startsWith('D'),
        messageId: msg.ts || undefined,
        replyToMessageId: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
        threadId: msg.thread_ts || undefined,
        mentionsBot: !!(botUserId && typeof msg.text === 'string' && msg.text.includes(`<@${botUserId}>`)),
        imageUrl: media.find((m) => m.type === 'image')?.url,
        media,
      }
      await hydrateSlackThreadContext({ client, inbound, currentTs: msg.ts || undefined, botUserId })

      try {
        const routeResult = normalizeConnectorIngressResult(await onMessage(inbound))
        if (routeResult.managerHandled || routeResult.delivery === 'silent') return
        const response = routeResult.visibleText

        const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound })
        const threadTs = replyOptions.threadId || replyOptions.replyToMessageId
        let lastMessageId: string | undefined

        // Slack has a 4000 char limit for messages
        if (response.length <= 4000) {
          const sent = await client.chat.postMessage({
            channel: channelId,
            text: response,
            thread_ts: threadTs,
          })
          lastMessageId = sent.ts || undefined
        } else {
          const chunks = response.match(/[\s\S]{1,3990}/g) || [response]
          for (const chunk of chunks) {
            const sent = await client.chat.postMessage({
              channel: channelId,
              text: chunk,
              thread_ts: threadTs,
            })
            lastMessageId = sent.ts || undefined
          }
        }
        await recordConnectorOutboundDelivery({
          connectorId: connector.id,
          inbound,
          messageId: lastMessageId,
          state: 'sent',
        })
      } catch (err: any) {
        console.error(`[slack] Error handling message:`, err.message)
        try {
          await say('Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    // Handle @mentions
    app.event('app_mention', async ({ event, client }) => {
      if (allowedChannels && !allowedChannels.includes(event.channel)) return

      let senderName = event.user || 'unknown'
      try {
        const userInfo = await client.users.info({ user: event.user! })
        senderName = userInfo.user?.real_name || userInfo.user?.name || senderName
      } catch { /* use ID */ }

      const inbound: InboundMessage = {
        platform: 'slack',
        channelId: event.channel,
        channelName: event.channel,
        senderId: event.user || 'unknown',
        senderName,
        text: event.text.replace(/<@[^>]+>/g, '').trim(), // Strip @mentions
        isGroup: !String(event.channel).startsWith('D'),
        messageId: (event as any).ts || undefined,
        replyToMessageId: (event as any).thread_ts && (event as any).thread_ts !== (event as any).ts
          ? (event as any).thread_ts
          : undefined,
        threadId: (event as any).thread_ts || undefined,
        mentionsBot: true,
      }
      await hydrateSlackThreadContext({
        client,
        inbound,
        currentTs: (event as any).ts || undefined,
        botUserId,
      })

      try {
        const routeResult = normalizeConnectorIngressResult(await onMessage(inbound))
        if (routeResult.managerHandled || routeResult.delivery === 'silent') return
        const response = routeResult.visibleText
        const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound })
        const sent = await client.chat.postMessage({
          channel: event.channel,
          text: response,
          thread_ts: replyOptions.threadId || replyOptions.replyToMessageId,
        })
        await recordConnectorOutboundDelivery({
          connectorId: connector.id,
          inbound,
          messageId: sent.ts || undefined,
          state: 'sent',
        })
      } catch (err: any) {
        console.error(`[slack] Error handling mention:`, err.message)
      }
    })

    await app.start()
    console.log(`[slack] Bot connected (socket mode)`)

    let appStopped = false

    const instance: ConnectorInstance = {
      connector,
      isAlive() {
        return !appStopped && !!app.client
      },
      async sendMessage(channelId, text, options) {
        const webClient = app.client
        const threadTs = options?.threadId?.trim() || options?.replyToMessageId?.trim() || undefined

        // File upload (local path or URL)
        const hasMedia = options?.mediaPath || options?.imageUrl || options?.fileUrl
        if (hasMedia) {
          let fileContent: Buffer | undefined
          let fileUrl: string | undefined
          let fileName = options?.fileName || 'attachment'

          if (options?.mediaPath) {
            if (!fs.existsSync(options.mediaPath)) throw new Error(`File not found: ${options.mediaPath}`)
            fileContent = fs.readFileSync(options.mediaPath)
            fileName = options.fileName || path.basename(options.mediaPath)
          } else {
            fileUrl = options?.imageUrl || options?.fileUrl
          }

          if (fileContent) {
            const uploadArgsBase = {
              channel_id: channelId,
              file: fileContent,
              filename: fileName,
              initial_comment: options?.caption || text || undefined,
            }
            const result = threadTs
              ? await webClient.filesUploadV2({
                  ...uploadArgsBase,
                  thread_ts: threadTs,
                })
              : await webClient.filesUploadV2(uploadArgsBase)
            return { messageId: (result as any)?.files?.[0]?.id }
          } else if (fileUrl) {
            // Send URL as message with unfurl
            const msg = await webClient.chat.postMessage({
              channel: channelId,
              text: `${options?.caption || text || ''}\n${fileUrl}`.trim(),
              thread_ts: threadTs,
              unfurl_links: true,
              unfurl_media: true,
            })
            return { messageId: msg.ts || undefined }
          }
        }

        // Text only
        const payload = text || options?.caption || ''
        if (payload.length <= 4000) {
          const msg = await webClient.chat.postMessage({ channel: channelId, text: payload, thread_ts: threadTs })
          return { messageId: msg.ts || undefined }
        }
        const chunks = payload.match(/[\s\S]{1,3990}/g) || [payload]
        let lastTs: string | undefined
        for (const chunk of chunks) {
          const msg = await webClient.chat.postMessage({ channel: channelId, text: chunk, thread_ts: threadTs })
          lastTs = msg.ts || undefined
        }
        return { messageId: lastTs }
      },
      async sendReaction(channelId, messageId, emoji) {
        await app.client.reactions.add({
          channel: channelId,
          timestamp: messageId,
          name: normalizeSlackEmoji(emoji),
        })
      },
      async editMessage(channelId, messageId, newText) {
        await app.client.chat.update({
          channel: channelId,
          ts: messageId,
          text: newText,
        })
      },
      async deleteMessage(channelId, messageId) {
        await app.client.chat.delete({
          channel: channelId,
          ts: messageId,
        })
      },
      async pinMessage(channelId, messageId) {
        await app.client.pins.add({
          channel: channelId,
          timestamp: messageId,
        })
      },
      async stop() {
        appStopped = true
        await app.stop()
        console.log(`[slack] Bot disconnected`)
      },
    }

    // Bolt emits 'error' on unrecoverable failures (auth revoked, socket closed permanently)
    app.error(async (error) => {
      const errMsg = error.original?.message || error.message || String(error)
      console.error(`[slack] App error:`, errMsg)
      if (appStopped) return
      appStopped = true
      instance.onCrash?.(`Slack error: ${errMsg}`)
    })

    return instance
  },
}

export default slack
