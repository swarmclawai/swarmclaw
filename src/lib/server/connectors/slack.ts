import { App, LogLevel } from '@slack/bolt'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { downloadInboundMediaToUpload, inferInboundMediaType } from './media'

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
        imageUrl: media.find((m) => m.type === 'image')?.url,
        media,
      }

      try {
        const response = await onMessage(inbound)

        // NO_MESSAGE means the agent chose not to reply — skip outbound send
        if (response === 'NO_MESSAGE') return

        // Slack has a 4000 char limit for messages
        if (response.length <= 4000) {
          await say(response)
        } else {
          const chunks = response.match(/[\s\S]{1,3990}/g) || [response]
          for (const chunk of chunks) {
            await say(chunk)
          }
        }
      } catch (err: any) {
        console.error(`[slack] Error handling message:`, err.message)
        try {
          await say('Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    // Handle @mentions
    app.event('app_mention', async ({ event, say, client }) => {
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
      }

      try {
        const response = await onMessage(inbound)
        // NO_MESSAGE means the agent chose not to reply — skip outbound send
        if (response === 'NO_MESSAGE') return
        await say(response)
      } catch (err: any) {
        console.error(`[slack] Error handling mention:`, err.message)
      }
    })

    await app.start()
    console.log(`[slack] Bot connected (socket mode)`)

    return {
      connector,
      async stop() {
        await app.stop()
        console.log(`[slack] Bot disconnected`)
      },
    }
  },
}

export default slack
