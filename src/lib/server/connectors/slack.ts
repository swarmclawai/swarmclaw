import { App, LogLevel } from '@slack/bolt'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'

const slack: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const appToken = connector.config.appToken || ''
    const signingSecret = connector.config.signingSecret || 'not-used-in-socket-mode'

    const app = new App({
      token: botToken,
      appToken,
      signingSecret,
      socketMode: !!appToken,  // Use socket mode if app token is provided
      logLevel: LogLevel.WARN,
    })

    // Optional: restrict to specific channels
    const allowedChannels = connector.config.channelIds
      ? connector.config.channelIds.split(',').map((s) => s.trim()).filter(Boolean)
      : null

    // Handle messages
    app.message(async ({ message, say, client }) => {
      // Only handle user messages (not bot messages)
      if (!('text' in message) || ('bot_id' in message)) return
      const msg = message as any

      const channelId = msg.channel
      if (allowedChannels && !allowedChannels.includes(channelId)) return

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

      const inbound: InboundMessage = {
        platform: 'slack',
        channelId,
        channelName,
        senderId: msg.user,
        senderName,
        text: msg.text || '',
      }

      try {
        const response = await onMessage(inbound)

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

    // Handle DMs / app_mention
    app.event('app_mention', async ({ event, say, client }) => {
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
        await say(response)
      } catch (err: any) {
        console.error(`[slack] Error handling mention:`, err.message)
      }
    })

    await app.start()
    console.log(`[slack] Bot connected (socket mode: ${!!appToken})`)

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
