import { Client, GatewayIntentBits, Events, Partials } from 'discord.js'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { inferInboundMediaType } from './media'

const discord: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // Required to receive DM events
    })

    // Optional: restrict to specific channels
    const allowedChannels = connector.config.channelIds
      ? connector.config.channelIds.split(',').map((s) => s.trim()).filter(Boolean)
      : null

    client.on(Events.MessageCreate, async (message) => {
      console.log(`[discord] Message from ${message.author.username} in ${message.channel.type === 1 ? 'DM' : '#' + ('name' in message.channel ? (message.channel as any).name : message.channelId)}: ${message.content.slice(0, 80)}`)
      // Ignore bot messages
      if (message.author.bot) return

      // Filter by allowed channels if configured
      if (allowedChannels && !allowedChannels.includes(message.channelId)) return

      const attachmentList = Array.from(message.attachments.values())
      const media = attachmentList.map((a) => ({
        type: inferInboundMediaType(a.contentType || undefined, a.name || undefined),
        fileName: a.name || undefined,
        mimeType: a.contentType || undefined,
        sizeBytes: a.size || undefined,
        url: a.url || undefined,
      }))
      const firstImage = media.find((m) => m.type === 'image' && m.url)

      const inbound: InboundMessage = {
        platform: 'discord',
        channelId: message.channelId,
        channelName: 'name' in message.channel ? (message.channel as any).name : 'DM',
        senderId: message.author.id,
        senderName: message.author.displayName || message.author.username,
        text: message.content || (media.length > 0 ? '(media message)' : ''),
        imageUrl: firstImage?.url,
        media,
      }

      try {
        // Show typing indicator
        await message.channel.sendTyping()
        const response = await onMessage(inbound)

        // NO_MESSAGE means the agent chose not to reply — skip outbound send
        if (response === 'NO_MESSAGE') return

        // Discord has a 2000 char limit per message
        if (response.length <= 2000) {
          await message.channel.send(response)
        } else {
          // Split into chunks
          const chunks = response.match(/[\s\S]{1,1990}/g) || [response]
          for (const chunk of chunks) {
            await message.channel.send(chunk)
          }
        }
      } catch (err: any) {
        console.error(`[discord] Error handling message:`, err.message)
        try {
          await message.reply('Sorry, I encountered an error processing your message.')
        } catch { /* ignore */ }
      }
    })

    await client.login(botToken)
    console.log(`[discord] Bot logged in as ${client.user?.tag}`)

    return {
      connector,
      async stop() {
        client.destroy()
        console.log(`[discord] Bot disconnected`)
      },
    }
  },
}

export default discord
